import type { BridgeConfig } from "./config.js";
import { BridgeState, StateStore } from "./state.js";
import type { BridgeLogger } from "./logger.js";
import type { CodexController, HookInboxEvent, PendingRequest, RequestQuestion, TelegramButton, TelegramReplyMarkup, TelegramTransport, TelegramUpdate, ThreadRecord } from "./types.js";
import { formatStopMessage, formatThreadList, formatThreadStatus, titleForThread, truncateText } from "./text.js";

const completionFallbackDelayMs = 7000;
const telegramHelp = `Commands:
/help - show this help
/threads - list recent Codex sessions and select one
/status - show selected session details without resuming it
/new <message> - start a new Codex session in the selected session's working directory
/goal <objective> - set or update the selected session goal

How to reply:
- Select a thread first with /threads.
- Send plain text to continue the selected idle/stopped session.
- Text is rejected while the selected session is active.
- Use /status while a session is running; it will not interrupt it.

Buttons:
Select thread - make this Telegram chat target that session
Continue - select session and prompt you to reply
Terminate - interrupt active turn or close pending request`;

export class BridgeCore {
  private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly config: BridgeConfig, readonly state: BridgeState, readonly store: StateStore, readonly telegram: TelegramTransport, readonly codex: CodexController, readonly logger: BridgeLogger) {}

  async refreshThreads(limit = 20): Promise<ThreadRecord[]> {
    const threads = await this.codex.listThreads(limit);
    for (const thread of threads) this.upsertThread(thread);
    this.save();
    return threads;
  }

  async notifyStopped(thread: ThreadRecord, status: string, summary: string, eventKey?: string): Promise<void> {
    const dedupeKey = eventKey ? normalizeStopEventKey(eventKey) : undefined;
    if (dedupeKey) this.cancelCompletionTimer(dedupeKey);
    if (dedupeKey && this.seenRecently(dedupeKey)) return;
    this.upsertThread({ ...thread, status: thread.status === "active" ? "idle" : thread.status, lastSummary: summary });
    const markup = this.threadMarkup(thread, true, undefined);
    await this.telegram.sendMessage(this.config.allowedChatIds[0], formatStopMessage(thread, status, summary), markup);
    if (dedupeKey) this.state.data.sentEvents[dedupeKey] = Date.now();
    this.save();
  }

  scheduleCompletionNotice(thread: ThreadRecord, summary: string, eventKey: string): void {
    this.scheduleStopNotice(thread, "completed", summary, eventKey);
  }

  scheduleStopNotice(thread: ThreadRecord, status: string, summary: string, eventKey: string): void {
    const key = normalizeStopEventKey(eventKey);
    if (this.seenRecently(key)) return;
    this.cancelCompletionTimer(key);
    const timer = setTimeout(() => {
      this.completionTimers.delete(key);
      void this.notifyStopped(thread, status, summary, eventKey).catch((error) => this.logger.log("completion.fallback.error", { eventKey, error: String(error) }));
    }, completionFallbackDelayMs);
    timer.unref?.();
    this.completionTimers.set(key, timer);
  }

  updateThreadStatus(threadId: string, status: ThreadRecord["status"], activeFlags: string[]): void {
    const thread = this.state.data.threads[threadId];
    if (!thread) return;
    const wasActive = thread.status === "active";
    thread.status = status;
    thread.activeFlags = activeFlags;
    this.save();
    if (wasActive && (status === "idle" || status === "systemError")) {
      const turnId = this.state.data.activeTurns[threadId] ?? thread.lastTurnId ?? "unknown";
      const summary = thread.lastSummary || (status === "systemError" ? "Codex stopped with a system error." : "Codex stopped running.");
      this.scheduleStopNotice(thread, status === "systemError" ? "systemError" : "stopped", summary, `${threadId}:${turnId}:turn-completed`);
    }
  }

  async notifyUserInput(serverRequestId: string | number, params: { threadId: string; turnId?: string; itemId?: string; questions: RequestQuestion[] }): Promise<void> {
    const thread = this.state.data.threads[params.threadId] ?? await this.codex.readThread(params.threadId) ?? this.syntheticThread(params.threadId);
    this.upsertThread({ ...thread, status: "active", activeFlags: ["waitingOnUserInput"] });
    const requestId = String(serverRequestId);
    const now = Date.now();
    const pending: PendingRequest = {
      id: requestId,
      serverRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      questions: params.questions,
      answers: {},
      chatId: this.config.allowedChatIds[0],
      createdAt: now,
      expiresAt: now + this.config.timeoutSeconds * 1000,
      status: "open"
    };
    this.state.data.pendingRequests[requestId] = pending;
    const sent = await this.telegram.sendMessage(pending.chatId, this.formatRequestMessage(thread, pending), this.requestMarkup(pending));
    pending.messageId = sent.message_id;
    this.save();
  }

  async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    this.logger.log("telegram.update", update);
    if (update.callback_query) {
      const chatId = String(update.callback_query.message?.chat.id ?? update.callback_query.from?.id ?? "");
      if (!this.authorized(chatId)) {
        await this.telegram.answerCallbackQuery(update.callback_query.id, "Not authorized");
        return;
      }
      await this.handleCallback(chatId, update.callback_query.message?.message_id, update.callback_query.data ?? "", update.callback_query.id);
      return;
    }
    if (update.message?.text) {
      const chatId = String(update.message.chat.id);
      if (!this.authorized(chatId)) return;
      await this.handleText(chatId, update.message.text.trim());
    }
  }

  async handleText(chatId: string, text: string): Promise<void> {
    const parsed = this.command(text);
    if (parsed?.name === "help" || parsed?.name === "start") {
      await this.telegram.sendMessage(chatId, telegramHelp);
      return;
    }
    if (parsed?.name === "threads") {
      await this.sendThreadList(chatId);
      return;
    }
    if (parsed?.name === "status") {
      const thread = this.selectedThread(chatId);
      await this.telegram.sendMessage(chatId, thread ? this.formatStatusMessage(thread) : "No thread selected. Use /threads.");
      return;
    }
    if (parsed?.name === "new") {
      await this.startNewThread(chatId, parsed.arg);
      return;
    }
    if (parsed?.name === "goal") {
      await this.setGoal(chatId, parsed.arg);
      return;
    }
    const thread = this.selectedThread(chatId);
    if (!thread) {
      await this.telegram.sendMessage(chatId, "Choose a Codex thread first.", await this.threadListMarkup());
      return;
    }
    if (thread.status === "active") {
      await this.telegram.sendMessage(chatId, `Codex is still running in "${titleForThread(thread)}". Wait until it stops, then reply again.`);
      return;
    }
    if (!thread.continuable) {
      await this.telegram.sendMessage(chatId, `This notification is not tied to a resumable Codex thread. Use /threads to choose a real thread.`);
      return;
    }
    try {
      await this.codex.resumeThread(thread.id);
      await this.codex.startTurn(thread.id, text);
      this.upsertThread({ ...thread, status: "active", activeFlags: [] });
      await this.telegram.sendMessage(chatId, `Sent to Codex: ${titleForThread(thread)}`);
      this.save();
    } catch (error) {
      this.logger.log("codex.continue.error", { threadId: thread.id, error: String(error) });
      await this.telegram.sendMessage(chatId, `Could not continue "${titleForThread(thread)}": ${friendlyError(error)}\n\nUse /threads and choose a regular Codex thread, or reopen the session in Codex App.`);
    }
  }

  async handleCallback(chatId: string, messageId: number | undefined, callbackData: string, callbackQueryId?: string): Promise<void> {
    const action = this.state.resolveCallback(callbackData);
    if (!action) {
      if (callbackQueryId) await this.telegram.answerCallbackQuery(callbackQueryId, "Expired button");
      return;
    }
    if (callbackQueryId) await this.telegram.answerCallbackQuery(callbackQueryId);
    if (action.type === "selectThread") {
      this.state.data.selectedThreadByChat[chatId] = action.threadId;
      this.save();
      await this.telegram.sendMessage(chatId, `Selected: ${titleForThread(this.state.data.threads[action.threadId] ?? this.syntheticThread(action.threadId))}`);
      return;
    }
    if (action.type === "continueThread") {
      this.state.data.selectedThreadByChat[chatId] = action.threadId;
      this.save();
      await this.telegram.sendMessage(chatId, `Reply with the next Codex message for: ${titleForThread(this.state.data.threads[action.threadId] ?? this.syntheticThread(action.threadId))}`);
      return;
    }
    if (action.type === "terminateThread") {
      await this.terminate(chatId, messageId, action.threadId, action.requestId);
      return;
    }
    await this.answerChoice(chatId, messageId, action.requestId, action.questionId, action.answer);
  }

  async expirePendingRequests(now = Date.now()): Promise<void> {
    for (const pending of Object.values(this.state.data.pendingRequests)) {
      if (pending.status !== "open" || pending.expiresAt > now) continue;
      pending.status = "timed_out";
      await this.codex.answerUserInput(pending.serverRequestId, {});
      if (pending.messageId) await this.telegram.editMessageText(pending.chatId, pending.messageId, `${this.formatRequestMessage(this.state.data.threads[pending.threadId] ?? this.syntheticThread(pending.threadId), pending)}\n\nTimed out.`);
    }
    this.save();
  }

  async handleHookEvent(event: HookInboxEvent): Promise<void> {
    this.logger.log("hook.event", event);
    const payload = typeof event.payload === "object" && event.payload ? event.payload as Record<string, unknown> : {};
    const eventName = String(payload.hook_event_name ?? payload.type ?? "Codex");
    if (/permission|approval/i.test(eventName)) return;
    if (isTitleGenerationHook(payload)) return;
    const cwd = String(payload.cwd ?? event.cwd);
    let threadId = String(payload.thread_id ?? payload.threadId ?? payload["thread-id"] ?? "");
    if (!threadId && cwd) {
      const threads = await this.refreshThreads(30);
      threadId = threads.find((thread) => samePath(thread.cwd, cwd))?.id ?? "";
    }
    const thread = threadId ? this.state.data.threads[threadId] ?? this.syntheticThread(threadId, cwd) : this.syntheticThread(`hook:${event.id}`, cwd, false);
    const summary = String(payload.last_assistant_message ?? payload["last-assistant-message"] ?? payload.summary ?? eventName);
    const turnId = String(payload.turn_id ?? payload.turnId ?? payload["turn-id"] ?? "");
    const key = threadId && turnId ? `${threadId}:${turnId}:hook-stop` : event.id;
    await this.notifyStopped(thread, eventName, truncateText(summary, 1200), key);
  }

  async sendThreadList(chatId: string): Promise<void> {
    const threads = await this.refreshThreads(20);
    await this.telegram.sendMessage(chatId, formatThreadList(threads), this.makeThreadListMarkup(threads));
  }

  private async startNewThread(chatId: string, prompt: string): Promise<void> {
    if (!prompt) {
      await this.telegram.sendMessage(chatId, "Usage: /new <first message>");
      return;
    }
    const baseThread = this.selectedThread(chatId);
    if (!baseThread?.cwd) {
      await this.telegram.sendMessage(chatId, "Select a thread from the target project first with /threads, then use /new <first message>.");
      return;
    }
    try {
      const thread = await this.codex.startThread(baseThread.cwd);
      await this.codex.startTurn(thread.id, prompt);
      const started = { ...thread, title: thread.title || truncateText(prompt, 80), status: "active" as const, activeFlags: [] };
      this.upsertThread(started);
      this.state.data.selectedThreadByChat[chatId] = thread.id;
      this.save();
      await this.telegram.sendMessage(chatId, `Created new Codex session: ${titleForThread(started)}\nCWD: ${baseThread.cwd}\nSent first message.`, this.threadMarkup(started, false));
    } catch (error) {
      this.logger.log("codex.new.error", { cwd: baseThread.cwd, error: String(error) });
      await this.telegram.sendMessage(chatId, `Could not create a new Codex session: ${friendlyError(error)}`);
    }
  }

  private async setGoal(chatId: string, objective: string): Promise<void> {
    if (!objective) {
      await this.telegram.sendMessage(chatId, "Usage: /goal <objective>");
      return;
    }
    const thread = this.selectedThread(chatId);
    if (!thread) {
      await this.telegram.sendMessage(chatId, "Choose a Codex thread first with /threads.");
      return;
    }
    try {
      await this.codex.setGoal(thread.id, objective);
      await this.telegram.sendMessage(chatId, `Goal set for ${titleForThread(thread)}:\n${truncateText(objective, 1200)}`);
    } catch (error) {
      this.logger.log("codex.goal.error", { threadId: thread.id, error: String(error) });
      await this.telegram.sendMessage(chatId, `Could not set goal for "${titleForThread(thread)}": ${friendlyError(error)}`);
    }
  }

  private async terminate(chatId: string, messageId: number | undefined, threadId: string, requestId?: string): Promise<void> {
    const pending = requestId ? this.state.data.pendingRequests[requestId] : undefined;
    if (pending && pending.status === "open") {
      pending.status = "terminated";
      await this.codex.answerUserInput(pending.serverRequestId, {});
    }
    const thread = this.state.data.threads[threadId];
    if (thread?.status === "active") await this.codex.interruptThread(threadId, this.state.data.activeTurns[threadId] ?? thread.lastTurnId);
    if (messageId) await this.telegram.editMessageText(chatId, messageId, `Closed: ${titleForThread(thread ?? this.syntheticThread(threadId))}`);
    this.save();
  }

  private async answerChoice(chatId: string, messageId: number | undefined, requestId: string, questionId: string, answer: string): Promise<void> {
    const pending = this.state.data.pendingRequests[requestId];
    if (!pending || pending.status !== "open") {
      await this.telegram.sendMessage(chatId, "That request is already closed.");
      return;
    }
    pending.answers[questionId] = [answer];
    const complete = pending.questions.every((question) => pending.answers[question.id]?.length);
    if (!complete) {
      if (messageId) await this.telegram.editMessageText(chatId, messageId, this.formatRequestMessage(this.state.data.threads[pending.threadId] ?? this.syntheticThread(pending.threadId), pending), this.requestMarkup(pending));
      this.save();
      return;
    }
    pending.status = "answered";
    await this.codex.answerUserInput(pending.serverRequestId, Object.fromEntries(Object.entries(pending.answers).map(([id, answers]) => [id, { answers }])));
    if (messageId) await this.telegram.editMessageText(chatId, messageId, `${this.formatRequestMessage(this.state.data.threads[pending.threadId] ?? this.syntheticThread(pending.threadId), pending)}\n\nAnswered.`);
    this.save();
  }

  private async threadListMarkup(): Promise<TelegramReplyMarkup> {
    return this.makeThreadListMarkup(await this.refreshThreads(10));
  }

  private makeThreadListMarkup(threads: ThreadRecord[]): TelegramReplyMarkup {
    return { inline_keyboard: threads.slice(0, 10).map((thread) => [{ text: titleForThread(thread).slice(0, 48), callback_data: this.state.callback({ type: "selectThread", threadId: thread.id }) }]) };
  }

  private threadMarkup(thread: ThreadRecord, includeContinue: boolean, requestId?: string): TelegramReplyMarkup {
    const row: TelegramButton[] = [{ text: "Select thread", callback_data: this.state.callback({ type: "selectThread", threadId: thread.id }) }];
    if (includeContinue && thread.continuable) row.push({ text: "Continue", callback_data: this.state.callback({ type: "continueThread", threadId: thread.id }) });
    row.push({ text: "Terminate", callback_data: this.state.callback({ type: "terminateThread", threadId: thread.id, requestId }) });
    return { inline_keyboard: [row] };
  }

  private requestMarkup(pending: PendingRequest): TelegramReplyMarkup {
    const rows: TelegramButton[][] = [];
    for (const question of pending.questions) {
      for (const option of question.options ?? []) rows.push([{ text: option.label.slice(0, 56), callback_data: this.state.callback({ type: "answerChoice", requestId: pending.id, questionId: question.id, answer: option.label }) }]);
    }
    rows.push([{ text: "Select thread", callback_data: this.state.callback({ type: "selectThread", threadId: pending.threadId }) }, { text: "Terminate", callback_data: this.state.callback({ type: "terminateThread", threadId: pending.threadId, requestId: pending.id }) }]);
    return { inline_keyboard: rows };
  }

  private formatRequestMessage(thread: ThreadRecord, pending: PendingRequest): string {
    const lines = [`Codex: ${titleForThread(thread)}`, `Status: waiting for your decision`, `Timeout: ${new Date(pending.expiresAt).toLocaleString()}`, ""];
    for (const question of pending.questions) {
      lines.push(question.header ? `${question.header}: ${question.question}` : question.question);
      for (const option of question.options ?? []) lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
      const chosen = pending.answers[question.id]?.join(", ");
      if (chosen) lines.push(`Selected: ${chosen}`);
      lines.push("");
    }
    return truncateText(lines.join("\n"));
  }

  private formatStatusMessage(thread: ThreadRecord): string {
    const lines = [`Selected: ${titleForThread(thread)}`, `Status: ${formatThreadStatus(thread)}`, `Thread ID: ${thread.id}`, `Continuable: ${thread.continuable ? "yes" : "no"}`];
    if (thread.cwd) lines.push(`CWD: ${thread.cwd}`);
    const turnId = this.state.data.activeTurns[thread.id] ?? thread.lastTurnId;
    if (turnId) lines.push(`Turn ID: ${turnId}`);
    const openRequests = Object.values(this.state.data.pendingRequests).filter((pending) => pending.threadId === thread.id && pending.status === "open").sort((a, b) => a.expiresAt - b.expiresAt);
    if (openRequests.length > 0) {
      const pending = openRequests[0];
      const seconds = Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000));
      const remaining = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      lines.push(`Pending decisions: ${openRequests.length} open, next timeout in ${remaining}`);
      const questionSummary = pending.questions.map((question) => question.header ? `${question.header}: ${question.question}` : question.question).join(" | ");
      if (questionSummary) lines.push(`Question: ${truncateText(questionSummary, 600)}`);
    } else {
      lines.push("Pending decisions: none");
    }
    if (thread.lastSummary) lines.push("", `Last summary:\n${truncateText(thread.lastSummary, 1200)}`);
    return truncateText(lines.join("\n"));
  }

  private selectedThread(chatId: string): ThreadRecord | undefined {
    const id = this.state.data.selectedThreadByChat[chatId];
    return id ? this.state.data.threads[id] : undefined;
  }

  private command(text: string): { name: string; arg: string } | undefined {
    const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
    return match ? { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() } : undefined;
  }

  private authorized(chatId: string): boolean {
    return this.config.allowedChatIds.includes(chatId);
  }

  private upsertThread(thread: ThreadRecord): void {
    this.state.data.threads[thread.id] = { ...this.state.data.threads[thread.id], ...thread, title: titleForThread(thread), updatedAt: thread.updatedAt || Date.now() };
    if (thread.lastTurnId) this.state.data.activeTurns[thread.id] = thread.lastTurnId;
  }

  private syntheticThread(id: string, cwd?: string, continuable = true): ThreadRecord {
    return { id, title: id, cwd, status: "notLoaded", activeFlags: [], updatedAt: Date.now(), continuable };
  }

  private seenRecently(key: string): boolean {
    const previous = this.state.data.sentEvents[key];
    return typeof previous === "number" && Date.now() - previous < 60_000;
  }

  private save(): void {
    this.store.save(this.state);
  }

  private cancelCompletionTimer(key: string): void {
    const normalized = normalizeStopEventKey(key);
    const timer = this.completionTimers.get(normalized);
    if (timer) clearTimeout(timer);
    this.completionTimers.delete(normalized);
  }
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function normalizeStopEventKey(eventKey: string): string {
  return eventKey.replace(/:(?:hook-stop|turn-completed)$/, ":stop");
}

function isTitleGenerationHook(payload: Record<string, unknown>): boolean {
  const summary = String(payload.last_assistant_message ?? payload["last-assistant-message"] ?? "");
  const inputMessages = Array.isArray(payload["input-messages"]) ? payload["input-messages"].map(String) : [];
  if (inputMessages.some((message) => message.includes("Generate a concise UI title") || message.includes("User prompt:"))) {
    try {
      const parsed = JSON.parse(summary) as { title?: unknown };
      if (typeof parsed.title === "string") return true;
    } catch {
      return false;
    }
  }
  return false;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("no rollout found")) return "the selected item was not a resumable Codex conversation";
  return truncateText(message, 220);
}
