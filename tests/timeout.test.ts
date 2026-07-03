import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeCore } from "../src/core.js";
import { BridgeLogger } from "../src/logger.js";
import { BridgeState, StateStore } from "../src/state.js";
import type { BridgeConfig } from "../src/config.js";
import type { CodexController, TelegramTransport, ThreadRecord } from "../src/types.js";

const thread: ThreadRecord = { id: "t", title: "Timeout thread", status: "active", activeFlags: ["waitingOnUserInput"], updatedAt: Date.now(), continuable: true };

class Telegram implements TelegramTransport {
  edits: string[] = [];
  async sendMessage(): Promise<{ message_id: number }> {
    return { message_id: 7 };
  }
  async editMessageText(_: string, __: number, text: string): Promise<void> {
    this.edits.push(text);
  }
  async answerCallbackQuery(): Promise<void> {}
}

class Codex implements CodexController {
  answers: Array<Record<string, { answers: string[] }>> = [];
  async listThreads(): Promise<ThreadRecord[]> { return [thread]; }
  async readThread(): Promise<ThreadRecord> { return thread; }
  async startThread(): Promise<ThreadRecord> { return thread; }
  async resumeThread(): Promise<void> {}
  async startTurn(): Promise<void> {}
  async setGoal(): Promise<void> {}
  async interruptThread(): Promise<void> {}
  async answerUserInput(_: string | number, answers: Record<string, { answers: string[] }>): Promise<void> {
    this.answers.push(answers);
  }
}

describe("pending request timeout", () => {
  it("marks open requests as timed out after the configured limit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctb-"));
    const config: BridgeConfig = { botToken: "secret", allowedChatIds: ["42"], timeoutSeconds: 1, codexCliPath: "codex", stateDir: dir };
    const state = new BridgeState({ threads: { t: thread } });
    const telegram = new Telegram();
    const codex = new Codex();
    const core = new BridgeCore(config, state, new StateStore(dir), telegram, codex, new BridgeLogger(dir));
    await core.notifyUserInput("req", { threadId: "t", questions: [{ id: "q", header: "Q", question: "Choose", isOther: false, isSecret: false, options: [{ label: "Yes", description: "" }] }] });
    await core.expirePendingRequests(Date.now() + 2000);
    expect(state.data.pendingRequests.req.status).toBe("timed_out");
    expect(codex.answers).toEqual([{}]);
    expect(telegram.edits[0]).toContain("Timed out");
  });
});
