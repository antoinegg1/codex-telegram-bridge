#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "./config.js";
import { CodexAppServerClient, lastAssistantText, requestQuestionsFromProtocol } from "./codex.js";
import { BridgeCore } from "./core.js";
import { BridgeLogger } from "./logger.js";
import { StateStore } from "./state.js";
import { TelegramClient, TelegramPoller } from "./telegram.js";
import { enqueueHookEvent, HookInbox } from "./hooks.js";
import { installCodexHooks } from "./install.js";
async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === "help" || command === "--help" || command === "-h") {
        printHelp();
        return;
    }
    if (command === "run") {
        await run();
        return;
    }
    if (command === "hook" && args[0] === "notify") {
        await hookNotify(args.slice(1));
        return;
    }
    if (command === "install-codex-hooks") {
        const changed = installCodexHooks(undefined, [process.execPath, process.argv[1], "hook", "notify"]);
        console.log(changed.length > 0 ? `Updated:\n${changed.map((item) => `- ${item}`).join("\n")}` : "Codex hooks already configured.");
        return;
    }
    if (command === "doctor") {
        const config = loadConfig();
        console.log(`Telegram chat allow-list: ${config.allowedChatIds.length}`);
        console.log(`Timeout seconds: ${config.timeoutSeconds}`);
        console.log(`Codex CLI: ${config.codexCliPath}`);
        console.log(`State dir: ${config.stateDir}`);
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}
async function run() {
    const config = loadConfig();
    const store = new StateStore(config.stateDir);
    const state = store.load();
    const logger = new BridgeLogger(config.stateDir);
    const telegram = new TelegramClient(config.botToken);
    const codex = new CodexAppServerClient(config.codexCliPath);
    const core = new BridgeCore(config, state, store, telegram, codex, logger);
    codex.on("stderr", (line) => logger.log("codex.stderr", line));
    codex.on("notification", async (message) => {
        try {
            await handleCodexNotification(core, message);
        }
        catch (error) {
            logger.log("codex.notification.error", String(error));
        }
    });
    codex.on("request", async (message) => {
        try {
            await handleCodexRequest(core, codex, message);
        }
        catch (error) {
            logger.log("codex.request.error", String(error));
        }
    });
    await codex.start();
    await core.refreshThreads();
    const inbox = new HookInbox(config.stateDir, (event) => core.handleHookEvent(event));
    const poller = new TelegramPoller(telegram, async (update) => {
        try {
            await core.handleTelegramUpdate(update);
        }
        catch (error) {
            logger.log("telegram.update.error", { update_id: update.update_id, error: String(error) });
        }
        finally {
            state.data.telegramOffset = update.update_id + 1;
            store.save(state);
        }
    }, state.data.telegramOffset);
    const interval = setInterval(() => {
        void inbox.drain().catch((error) => logger.log("hook.drain.error", String(error)));
        void core.expirePendingRequests().catch((error) => logger.log("timeout.error", String(error)));
    }, 5000);
    process.once("SIGINT", () => {
        clearInterval(interval);
        poller.stop();
        codex.stop();
        process.exit(0);
    });
    await telegram.sendMessage(config.allowedChatIds[0], "codex-telegram-bridge is running.");
    await poller.start();
}
async function hookNotify(args) {
    try {
        const chunks = [];
        for await (const chunk of process.stdin)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        await enqueueHookEvent(args, Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        process.exitCode = 0;
    }
}
async function handleCodexNotification(core, message) {
    const method = String(message.method);
    const params = (message.params ?? {});
    if (method === "thread/started") {
        const thread = threadFromNotification(params.thread);
        if (thread)
            core.state.data.threads[thread.id] = thread;
        core.store.save(core.state);
    }
    if (method === "thread/status/changed") {
        const threadId = String(params.threadId ?? "");
        const thread = core.state.data.threads[threadId];
        const status = params.status?.type;
        if (thread && typeof status === "string") {
            thread.status = status === "active" || status === "idle" || status === "systemError" ? status : "notLoaded";
            const flags = params.status?.activeFlags;
            thread.activeFlags = Array.isArray(flags) ? flags.map(String) : [];
            core.store.save(core.state);
        }
    }
    if (method === "thread/name/updated") {
        const threadId = String(params.threadId ?? "");
        const name = params.threadName;
        if (threadId && typeof name === "string" && core.state.data.threads[threadId]) {
            core.state.data.threads[threadId].title = name;
            core.store.save(core.state);
        }
    }
    if (method === "turn/started") {
        const threadId = String(params.threadId ?? "");
        const turn = params.turn;
        if (threadId && turn?.id) {
            core.state.data.activeTurns[threadId] = String(turn.id);
            const thread = core.state.data.threads[threadId];
            if (thread) {
                thread.status = "active";
                thread.lastTurnId = String(turn.id);
            }
            core.store.save(core.state);
        }
    }
    if (method === "turn/completed") {
        const threadId = String(params.threadId ?? "");
        const turn = params.turn;
        if (!threadId || !turn)
            return;
        const thread = core.state.data.threads[threadId] ?? await core.codex.readThread(threadId);
        if (!thread)
            return;
        thread.status = "idle";
        thread.activeFlags = [];
        thread.lastTurnId = String(turn.id ?? thread.lastTurnId ?? "");
        const summary = lastAssistantText(turn);
        if (summary)
            thread.lastSummary = summary;
        core.state.data.threads[threadId] = thread;
        core.store.save(core.state);
    }
}
async function handleCodexRequest(core, codex, message) {
    const method = String(message.method);
    const id = message.id;
    const params = (message.params ?? {});
    if (method === "item/tool/requestUserInput") {
        await core.notifyUserInput(id, {
            threadId: String(params.threadId),
            turnId: params.turnId ? String(params.turnId) : undefined,
            itemId: params.itemId ? String(params.itemId) : undefined,
            questions: requestQuestionsFromProtocol(params)
        });
        return;
    }
    if (/requestApproval|Approval/.test(method))
        await codex.cancelApproval(id, method);
}
function threadFromNotification(thread) {
    if (!thread?.id)
        return undefined;
    const status = thread.status;
    const statusType = typeof status?.type === "string" ? status.type : "notLoaded";
    const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map(String) : [];
    return {
        id: String(thread.id),
        title: typeof thread.name === "string" && thread.name ? thread.name : typeof thread.preview === "string" && thread.preview ? thread.preview.slice(0, 80) : String(thread.id),
        preview: typeof thread.preview === "string" ? thread.preview : undefined,
        cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
        status: statusType === "active" || statusType === "idle" || statusType === "systemError" ? statusType : "notLoaded",
        activeFlags,
        source: typeof thread.source === "string" ? thread.source : undefined,
        updatedAt: Date.now(),
        continuable: true
    };
}
function printHelp() {
    console.log(`codex-telegram-bridge

Commands:
  run                  Start Telegram long polling and Codex app-server bridge
  hook notify          Receive Codex notify payloads from stdin/argv
  install-codex-hooks  Configure ~/.codex notify hook and global prompt policy
  doctor               Validate environment configuration
`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
//# sourceMappingURL=main.js.map