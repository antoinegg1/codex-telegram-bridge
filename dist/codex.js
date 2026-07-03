import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { titleForThread, truncateText } from "./text.js";
export class CodexAppServerClient extends EventEmitter {
    codexCliPath;
    child;
    nextId = 1;
    pending = new Map();
    buffer = "";
    constructor(codexCliPath) {
        super();
        this.codexCliPath = codexCliPath;
    }
    async start() {
        this.child = spawn(this.codexCliPath, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdout.on("data", (chunk) => this.onStdout(chunk.toString("utf8")));
        this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
        this.child.on("exit", (code, signal) => this.emit("exit", { code, signal }));
        await this.request("initialize", {
            clientInfo: { name: "codex-telegram-bridge", version: "0.1.0" },
            capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
        });
        this.notify("initialized");
    }
    stop() {
        this.child?.kill();
    }
    async listThreads(limit = 20) {
        const response = await this.request("thread/list", { limit, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "appServer", "exec"], archived: false });
        const data = (response.data ?? []);
        return data.map((thread) => this.threadFromProtocol(thread));
    }
    async readThread(threadId) {
        const response = await this.request("thread/read", { threadId, includeTurns: true });
        const thread = response.thread;
        return thread ? this.threadFromProtocol(thread) : null;
    }
    async startThread(cwd) {
        const response = await this.request("thread/start", { cwd, sessionStartSource: "startup" });
        return this.threadFromProtocol(response.thread);
    }
    async resumeThread(threadId) {
        await this.request("thread/resume", { threadId });
    }
    async startTurn(threadId, text) {
        await this.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
    }
    async setGoal(threadId, objective) {
        await this.request("thread/goal/set", { threadId, objective, status: "active" });
    }
    async interruptThread(threadId, turnId) {
        if (!turnId)
            return;
        await this.request("turn/interrupt", { threadId, turnId });
    }
    async answerUserInput(serverRequestId, answers) {
        this.respond(serverRequestId, { answers });
    }
    async cancelApproval(serverRequestId, method) {
        if (method === "item/commandExecution/requestApproval")
            this.respond(serverRequestId, { decision: "cancel" });
        else if (method === "item/fileChange/requestApproval")
            this.respond(serverRequestId, { decision: "cancel" });
        else if (method === "execCommandApproval" || method === "applyPatchApproval")
            this.respond(serverRequestId, { decision: "abort" });
        else if (method === "item/permissions/requestApproval")
            this.respond(serverRequestId, { permissions: {}, scope: "turn", strictAutoReview: true });
        else
            this.respond(serverRequestId, {});
    }
    async request(method, params) {
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
    }
    notify(method, params) {
        this.write(params === undefined ? { method } : { method, params });
    }
    respond(id, result) {
        this.write({ id, result });
    }
    write(message) {
        if (!this.child)
            throw new Error("Codex app-server is not running");
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    onStdout(data) {
        this.buffer += data;
        for (;;) {
            const newline = this.buffer.indexOf("\n");
            if (newline < 0)
                break;
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line)
                this.onMessage(JSON.parse(line));
        }
    }
    onMessage(message) {
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            this.pending.delete(message.id);
            if (message.error !== undefined)
                pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
            else
                pending.resolve(message.result);
            return;
        }
        if (message.id !== undefined && typeof message.method === "string")
            this.emit("request", message);
        else if (typeof message.method === "string")
            this.emit("notification", message);
    }
    threadFromProtocol(thread) {
        const status = thread.status;
        const statusType = typeof status?.type === "string" ? status.type : "notLoaded";
        const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map(String) : [];
        const record = {
            id: String(thread.id),
            title: typeof thread.name === "string" && thread.name ? thread.name : typeof thread.preview === "string" ? truncateText(thread.preview, 80) : String(thread.id),
            preview: typeof thread.preview === "string" ? thread.preview : undefined,
            cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
            status: statusType === "idle" || statusType === "systemError" || statusType === "active" ? statusType : "notLoaded",
            activeFlags,
            source: typeof thread.source === "string" ? thread.source : JSON.stringify(thread.source ?? "unknown"),
            updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : Date.now(),
            continuable: true
        };
        record.title = titleForThread(record);
        const turns = Array.isArray(thread.turns) ? thread.turns : [];
        const lastTurn = turns.at(-1);
        if (lastTurn?.id)
            record.lastTurnId = String(lastTurn.id);
        if (lastTurn)
            record.lastSummary = lastAssistantText(lastTurn);
        return record;
    }
}
export function lastAssistantText(turn) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of [...items].reverse()) {
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
            return truncateText(item.text, 1200);
        if (item.type === "reasoning" && Array.isArray(item.summary) && item.summary.length > 0)
            return truncateText(item.summary.map(String).join("\n"), 1200);
    }
    return "";
}
export function requestQuestionsFromProtocol(value) {
    const questions = (value.questions ?? []);
    return questions.map((question) => ({
        id: String(question.id),
        header: String(question.header ?? ""),
        question: String(question.question ?? ""),
        isOther: Boolean(question.isOther),
        isSecret: Boolean(question.isSecret),
        options: Array.isArray(question.options) ? question.options.map((option) => ({ label: String(option.label ?? ""), description: String(option.description ?? "") })) : null
    }));
}
//# sourceMappingURL=codex.js.map