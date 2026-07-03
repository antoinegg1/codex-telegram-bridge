import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodexController, JsonValue, RequestQuestion, ThreadRecord } from "./types.js";
import { titleForThread, truncateText } from "./text.js";

type JsonRecord = Record<string, JsonValue | undefined>;

interface PendingRpc {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexAppServerClient extends EventEmitter implements CodexController {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string | number, PendingRpc>();
  private buffer = "";

  constructor(readonly codexCliPath: string) {
    super();
  }

  async start(): Promise<void> {
    this.child = spawn(this.codexCliPath, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.on("exit", (code, signal) => this.emit("exit", { code, signal }));
    await this.request("initialize", {
      clientInfo: { name: "codex-telegram-bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
    });
    this.notify("initialized");
  }

  stop(): void {
    this.child?.kill();
  }

  async listThreads(limit = 20): Promise<ThreadRecord[]> {
    const response = await this.request("thread/list", { limit, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "appServer", "exec"], archived: false });
    const data = ((response as { data?: unknown[] }).data ?? []) as JsonRecord[];
    return data.map((thread) => this.threadFromProtocol(thread));
  }

  async readThread(threadId: string): Promise<ThreadRecord | null> {
    const response = await this.request("thread/read", { threadId, includeTurns: true });
    const thread = (response as { thread?: JsonRecord }).thread;
    return thread ? this.threadFromProtocol(thread) : null;
  }

  async startThread(cwd: string): Promise<ThreadRecord> {
    const response = await this.request("thread/start", { cwd, sessionStartSource: "startup" });
    return this.threadFromProtocol((response as { thread: JsonRecord }).thread);
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
  }

  async startTurn(threadId: string, text: string): Promise<void> {
    await this.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  }

  async setGoal(threadId: string, objective: string): Promise<void> {
    await this.request("thread/goal/set", { threadId, objective, status: "active" });
  }

  async interruptThread(threadId: string, turnId?: string): Promise<void> {
    if (!turnId) return;
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async answerUserInput(serverRequestId: string | number, answers: Record<string, { answers: string[] }>): Promise<void> {
    this.respond(serverRequestId, { answers });
  }

  async cancelApproval(serverRequestId: string | number, method: string): Promise<void> {
    if (method === "item/commandExecution/requestApproval") this.respond(serverRequestId, { decision: "cancel" });
    else if (method === "item/fileChange/requestApproval") this.respond(serverRequestId, { decision: "cancel" });
    else if (method === "execCommandApproval" || method === "applyPatchApproval") this.respond(serverRequestId, { decision: "abort" });
    else if (method === "item/permissions/requestApproval") this.respond(serverRequestId, { permissions: {}, scope: "turn", strictAutoReview: true });
    else this.respond(serverRequestId, {});
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  private write(message: unknown): void {
    if (!this.child) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(data: string): void {
    this.buffer += data;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(JSON.parse(line) as JsonRecord);
    }
  }

  private onMessage(message: JsonRecord): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id as string | number);
      if (!pending) return;
      this.pending.delete(message.id as string | number);
      if (message.error !== undefined) pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") this.emit("request", message);
    else if (typeof message.method === "string") this.emit("notification", message);
  }

  private threadFromProtocol(thread: JsonRecord): ThreadRecord {
    const status = thread.status as JsonRecord | undefined;
    const statusType = typeof status?.type === "string" ? status.type : "notLoaded";
    const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map(String) : [];
    const record: ThreadRecord = {
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
    const turns = Array.isArray(thread.turns) ? thread.turns as JsonRecord[] : [];
    const lastTurn = turns.at(-1);
    if (lastTurn?.id) record.lastTurnId = String(lastTurn.id);
    if (lastTurn) record.lastSummary = lastAssistantText(lastTurn);
    return record;
  }
}

export function lastAssistantText(turn: JsonRecord): string {
  const items = Array.isArray(turn.items) ? turn.items as JsonRecord[] : [];
  for (const item of [...items].reverse()) {
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) return truncateText(item.text, 1200);
    if (item.type === "reasoning" && Array.isArray(item.summary) && item.summary.length > 0) return truncateText(item.summary.map(String).join("\n"), 1200);
  }
  return "";
}

export function requestQuestionsFromProtocol(value: unknown): RequestQuestion[] {
  const questions = ((value as { questions?: unknown[] }).questions ?? []) as JsonRecord[];
  return questions.map((question) => ({
    id: String(question.id),
    header: String(question.header ?? ""),
    question: String(question.question ?? ""),
    isOther: Boolean(question.isOther),
    isSecret: Boolean(question.isSecret),
    options: Array.isArray(question.options) ? question.options.map((option) => ({ label: String((option as JsonRecord).label ?? ""), description: String((option as JsonRecord).description ?? "") })) : null
  }));
}
