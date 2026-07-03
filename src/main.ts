#!/usr/bin/env node
import process from "node:process";
import { discoverChatId } from "./chat-id.js";
import { loadConfig } from "./config.js";
import { CodexAppServerClient, lastAssistantText, requestQuestionsFromProtocol } from "./codex.js";
import { BridgeCore } from "./core.js";
import { BridgeLogger } from "./logger.js";
import { StateStore } from "./state.js";
import { TelegramClient, TelegramPoller } from "./telegram.js";
import { enqueueHookEvent, HookInbox } from "./hooks.js";
import { installCodexHooks } from "./install.js";
import type { JsonValue, ThreadRecord } from "./types.js";

type JsonRecord = Record<string, JsonValue | undefined>;

async function main(): Promise<void> {
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
  if (command === "chat-id") {
    await printChatId();
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

async function run(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.stateDir);
  const state = store.load();
  const logger = new BridgeLogger(config.stateDir);
  const telegram = new TelegramClient(config.botToken);
  const codex = new CodexAppServerClient(config.codexCliPath);
  const core = new BridgeCore(config, state, store, telegram, codex, logger);
  codex.on("stderr", (line) => logger.log("codex.stderr", line));
  codex.on("notification", async (message: JsonRecord) => {
    try {
      await handleCodexNotification(core, message);
    } catch (error) {
      logger.log("codex.notification.error", String(error));
    }
  });
  codex.on("request", async (message: JsonRecord) => {
    try {
      await handleCodexRequest(core, codex, message);
    } catch (error) {
      logger.log("codex.request.error", String(error));
    }
  });
  await codex.start();
  await core.refreshThreads();
  const inbox = new HookInbox(config.stateDir, (event) => core.handleHookEvent(event));
  const poller = new TelegramPoller(telegram, async (update) => {
    try {
      await core.handleTelegramUpdate(update);
    } catch (error) {
      logger.log("telegram.update.error", { update_id: update.update_id, error: String(error) });
    } finally {
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

async function hookNotify(args: string[]): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    await enqueueHookEvent(args, Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exitCode = 0;
  }
}

async function printChatId(): Promise<void> {
  const token = process.env.CODEX_TG_BOT_TOKEN;
  if (!token) throw new Error("Missing CODEX_TG_BOT_TOKEN");
  console.log("Send any message to your Telegram bot now. Waiting up to 60 seconds...");
  const chatId = await discoverChatId(new TelegramClient(token));
  console.log(`Detected Telegram chat id: ${chatId}`);
  console.log("\nPowerShell:");
  console.log(`[Environment]::SetEnvironmentVariable("CODEX_TG_CHAT_ID", "${chatId}", "User")`);
  console.log("\nmacOS/Linux:");
  console.log(`export CODEX_TG_CHAT_ID="${chatId}"`);
}

async function handleCodexNotification(core: BridgeCore, message: JsonRecord): Promise<void> {
  const method = String(message.method);
  const params = (message.params ?? {}) as JsonRecord;
  if (method === "thread/started") {
    const thread = threadFromNotification(params.thread as JsonRecord | undefined);
    if (thread) core.state.data.threads[thread.id] = thread;
    core.store.save(core.state);
  }
  if (method === "thread/status/changed") {
    const threadId = String(params.threadId ?? "");
    const thread = core.state.data.threads[threadId];
    const status = (params.status as JsonRecord | undefined)?.type;
    if (thread && typeof status === "string") {
      thread.status = status === "active" || status === "idle" || status === "systemError" ? status : "notLoaded";
      const flags = (params.status as JsonRecord | undefined)?.activeFlags;
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
    const turn = params.turn as JsonRecord | undefined;
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
    const turn = params.turn as JsonRecord | undefined;
    if (!threadId || !turn) return;
    const thread = core.state.data.threads[threadId] ?? await core.codex.readThread(threadId);
    if (!thread) return;
    thread.status = "idle";
    thread.activeFlags = [];
    thread.lastTurnId = String(turn.id ?? thread.lastTurnId ?? "");
    const summary = lastAssistantText(turn);
    if (summary) thread.lastSummary = summary;
    core.state.data.threads[threadId] = thread;
    core.store.save(core.state);
  }
}

async function handleCodexRequest(core: BridgeCore, codex: CodexAppServerClient, message: JsonRecord): Promise<void> {
  const method = String(message.method);
  const id = message.id as string | number;
  const params = (message.params ?? {}) as JsonRecord;
  if (method === "item/tool/requestUserInput") {
    await core.notifyUserInput(id, {
      threadId: String(params.threadId),
      turnId: params.turnId ? String(params.turnId) : undefined,
      itemId: params.itemId ? String(params.itemId) : undefined,
      questions: requestQuestionsFromProtocol(params)
    });
    return;
  }
  if (/requestApproval|Approval/.test(method)) await codex.cancelApproval(id, method);
}

function threadFromNotification(thread: JsonRecord | undefined): ThreadRecord | undefined {
  if (!thread?.id) return undefined;
  const status = thread.status as JsonRecord | undefined;
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

function printHelp(): void {
  console.log(`codex-telegram-bridge

Commands:
  run                  Start Telegram long polling and Codex app-server bridge
  hook notify          Receive Codex notify payloads from stdin/argv
  install-codex-hooks  Configure ~/.codex notify hook and global prompt policy
  chat-id              Discover your Telegram chat id from a bot message
  doctor               Validate environment configuration
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
