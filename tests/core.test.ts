import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeCore } from "../src/core.js";
import { BridgeLogger } from "../src/logger.js";
import { BridgeState, StateStore } from "../src/state.js";
import type { BridgeConfig } from "../src/config.js";
import type { CodexController, TelegramReplyMarkup, TelegramTransport, ThreadRecord } from "../src/types.js";

class FakeTelegram implements TelegramTransport {
  messages: Array<{ chatId: string; text: string; replyMarkup?: TelegramReplyMarkup }> = [];
  edits: Array<{ chatId: string; messageId: number; text: string; replyMarkup?: TelegramReplyMarkup }> = [];
  callbacks: string[] = [];

  async sendMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup): Promise<{ message_id: number }> {
    this.messages.push({ chatId, text, replyMarkup });
    return { message_id: this.messages.length };
  }

  async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: TelegramReplyMarkup): Promise<void> {
    this.edits.push({ chatId, messageId, text, replyMarkup });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.callbacks.push(`${callbackQueryId}:${text ?? ""}`);
  }
}

class FakeCodex implements CodexController {
  answered: Array<Record<string, { answers: string[] }>> = [];
  interrupted: string[] = [];
  resumed: string[] = [];
  started: Array<{ threadId: string; text: string }> = [];
  failResume = false;

  constructor(readonly threads: ThreadRecord[]) {}

  async listThreads(): Promise<ThreadRecord[]> {
    return this.threads;
  }

  async readThread(threadId: string): Promise<ThreadRecord | null> {
    return this.threads.find((thread) => thread.id === threadId) ?? null;
  }

  async resumeThread(threadId: string): Promise<void> {
    if (this.failResume) throw new Error("thread/resume failed: no rollout found");
    this.resumed.push(threadId);
  }

  async startTurn(threadId: string, text: string): Promise<void> {
    this.started.push({ threadId, text });
  }

  async interruptThread(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
  }

  async answerUserInput(_: string | number, answers: Record<string, { answers: string[] }>): Promise<void> {
    this.answered.push(answers);
  }
}

const thread: ThreadRecord = {
  id: "thread-1",
  title: "Build feature",
  cwd: "/repo",
  status: "idle",
  activeFlags: [],
  updatedAt: Date.now(),
  continuable: true
};

function makeCore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctb-"));
  const config: BridgeConfig = { botToken: "secret", allowedChatIds: ["42"], timeoutSeconds: 900, codexCliPath: "codex", stateDir: dir };
  const state = new BridgeState({ threads: { [thread.id]: { ...thread } } });
  const store = new StateStore(dir);
  const telegram = new FakeTelegram();
  const codex = new FakeCodex([{ ...thread }]);
  return { core: new BridgeCore(config, state, store, telegram, codex, new BridgeLogger(dir)), state, telegram, codex };
}

describe("BridgeCore", () => {
  it("answers a choice callback", async () => {
    const { core, state, telegram, codex } = makeCore();
    await core.notifyUserInput("req-1", { threadId: thread.id, turnId: "turn-1", questions: [{ id: "mode", header: "Mode", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "A", description: "alpha" }] }] });
    const callbackData = telegram.messages[0].replyMarkup!.inline_keyboard[0][0].callback_data;
    await core.handleCallback("42", 1, callbackData, "cbq");
    expect(codex.answered).toEqual([{ mode: { answers: ["A"] } }]);
    expect(state.data.pendingRequests["req-1"].status).toBe("answered");
    expect(telegram.edits[0].text).toContain("Answered");
  });

  it("continues only stopped selected threads", async () => {
    const { core, state, codex } = makeCore();
    state.data.selectedThreadByChat["42"] = thread.id;
    await core.handleText("42", "continue please");
    expect(codex.resumed).toEqual([thread.id]);
    expect(codex.started).toEqual([{ threadId: thread.id, text: "continue please" }]);
  });

  it("rejects free text while a thread is active", async () => {
    const { core, state, telegram, codex } = makeCore();
    state.data.threads[thread.id].status = "active";
    state.data.selectedThreadByChat["42"] = thread.id;
    await core.handleText("42", "interrupting text");
    expect(codex.started).toEqual([]);
    expect(telegram.messages.at(-1)!.text).toContain("still running");
  });

  it("shows detailed selected thread status without resuming it", async () => {
    const { core, state, telegram, codex } = makeCore();
    state.data.selectedThreadByChat["42"] = thread.id;
    state.data.activeTurns[thread.id] = "turn-1";
    state.data.threads[thread.id] = { ...state.data.threads[thread.id], status: "active", activeFlags: ["waitingOnUserInput"], lastTurnId: "turn-1", lastSummary: "Latest assistant summary." };
    state.data.pendingRequests["req-1"] = {
      id: "req-1",
      serverRequestId: "req-1",
      threadId: thread.id,
      turnId: "turn-1",
      questions: [{ id: "mode", header: "Mode", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "A", description: "alpha" }] }],
      answers: {},
      chatId: "42",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      status: "open"
    };
    await core.handleText("42", "/status");
    const text = telegram.messages.at(-1)!.text;
    expect(text).toContain("Selected: Build feature");
    expect(text).toContain("Status: active (waitingOnUserInput)");
    expect(text).toContain("Thread ID: thread-1");
    expect(text).toContain("CWD: /repo");
    expect(text).toContain("Turn ID: turn-1");
    expect(text).toContain("Pending decisions: 1 open");
    expect(text).toContain("Question: Mode: Pick one");
    expect(text).toContain("Last summary:\nLatest assistant summary.");
    expect(codex.resumed).toEqual([]);
    expect(codex.started).toEqual([]);
  });

  it("reports resume failures to Telegram", async () => {
    const { core, state, telegram, codex } = makeCore();
    codex.failResume = true;
    state.data.selectedThreadByChat["42"] = thread.id;
    await core.handleText("42", "continue please");
    expect(codex.started).toEqual([]);
    expect(telegram.messages.at(-1)!.text).toContain("not a resumable Codex conversation");
  });

  it("ignores unauthorized chats", async () => {
    const { core, telegram } = makeCore();
    await core.handleTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: "99" }, text: "/threads" } });
    expect(telegram.messages).toHaveLength(0);
  });

  it("ignores Codex title generation hook events", async () => {
    const { core, telegram } = makeCore();
    await core.handleHookEvent({
      id: "hook-title",
      receivedAt: Date.now(),
      cwd: "/repo",
      argv: [],
      payload: {
        type: "agent-turn-complete",
        "thread-id": "title-thread",
        "input-messages": ["Generate a concise UI title\n\nUser prompt:\nhi"],
        "last-assistant-message": "{\"title\":\"Say hi\"}"
      }
    });
    expect(telegram.messages).toHaveLength(0);
  });

  it("deduplicates stop notifications across app-server and hook event keys", async () => {
    const { core, telegram } = makeCore();
    await core.notifyStopped(thread, "completed", "done once", "thread-1:turn-1:turn-completed");
    await core.notifyStopped(thread, "agent-turn-complete", "done twice", "thread-1:turn-1:hook-stop");
    expect(telegram.messages).toHaveLength(1);
  });
});
