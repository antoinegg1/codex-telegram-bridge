import { formatStopMessage, formatThreadList, formatThreadStatus, titleForThread, truncateText } from "./text.js";
export class BridgeCore {
    config;
    state;
    store;
    telegram;
    codex;
    logger;
    constructor(config, state, store, telegram, codex, logger) {
        this.config = config;
        this.state = state;
        this.store = store;
        this.telegram = telegram;
        this.codex = codex;
        this.logger = logger;
    }
    async refreshThreads(limit = 20) {
        const threads = await this.codex.listThreads(limit);
        for (const thread of threads)
            this.upsertThread(thread);
        this.save();
        return threads;
    }
    async notifyStopped(thread, status, summary, eventKey) {
        const dedupeKey = eventKey ? normalizeStopEventKey(eventKey) : undefined;
        if (dedupeKey && this.seenRecently(dedupeKey))
            return;
        this.upsertThread({ ...thread, status: thread.status === "active" ? "idle" : thread.status, lastSummary: summary });
        const markup = this.threadMarkup(thread, true, undefined);
        await this.telegram.sendMessage(this.config.allowedChatIds[0], formatStopMessage(thread, status, summary), markup);
        if (dedupeKey)
            this.state.data.sentEvents[dedupeKey] = Date.now();
        this.save();
    }
    async notifyUserInput(serverRequestId, params) {
        const thread = this.state.data.threads[params.threadId] ?? await this.codex.readThread(params.threadId) ?? this.syntheticThread(params.threadId);
        this.upsertThread({ ...thread, status: "active", activeFlags: ["waitingOnUserInput"] });
        const requestId = String(serverRequestId);
        const now = Date.now();
        const pending = {
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
    async handleTelegramUpdate(update) {
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
            if (!this.authorized(chatId))
                return;
            await this.handleText(chatId, update.message.text.trim());
        }
    }
    async handleText(chatId, text) {
        if (text === "/help" || text === "/start") {
            await this.telegram.sendMessage(chatId, "Commands:\n/threads - choose a Codex thread\n/status - show selected thread\n\nSelect a thread first, then send text to continue it when it is stopped or idle.");
            return;
        }
        if (text === "/threads") {
            await this.sendThreadList(chatId);
            return;
        }
        if (text === "/status") {
            const thread = this.selectedThread(chatId);
            await this.telegram.sendMessage(chatId, thread ? `Selected: ${titleForThread(thread)}\nStatus: ${formatThreadStatus(thread)}` : "No thread selected. Use /threads.");
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
        }
        catch (error) {
            this.logger.log("codex.continue.error", { threadId: thread.id, error: String(error) });
            await this.telegram.sendMessage(chatId, `Could not continue "${titleForThread(thread)}": ${friendlyError(error)}\n\nUse /threads and choose a regular Codex thread, or reopen the session in Codex App.`);
        }
    }
    async handleCallback(chatId, messageId, callbackData, callbackQueryId) {
        const action = this.state.resolveCallback(callbackData);
        if (!action) {
            if (callbackQueryId)
                await this.telegram.answerCallbackQuery(callbackQueryId, "Expired button");
            return;
        }
        if (callbackQueryId)
            await this.telegram.answerCallbackQuery(callbackQueryId);
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
    async expirePendingRequests(now = Date.now()) {
        for (const pending of Object.values(this.state.data.pendingRequests)) {
            if (pending.status !== "open" || pending.expiresAt > now)
                continue;
            pending.status = "timed_out";
            await this.codex.answerUserInput(pending.serverRequestId, {});
            if (pending.messageId)
                await this.telegram.editMessageText(pending.chatId, pending.messageId, `${this.formatRequestMessage(this.state.data.threads[pending.threadId] ?? this.syntheticThread(pending.threadId), pending)}\n\nTimed out.`);
        }
        this.save();
    }
    async handleHookEvent(event) {
        this.logger.log("hook.event", event);
        const payload = typeof event.payload === "object" && event.payload ? event.payload : {};
        const eventName = String(payload.hook_event_name ?? payload.type ?? "Codex");
        if (/permission|approval/i.test(eventName))
            return;
        if (isTitleGenerationHook(payload))
            return;
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
    async sendThreadList(chatId) {
        const threads = await this.refreshThreads(20);
        await this.telegram.sendMessage(chatId, formatThreadList(threads), this.makeThreadListMarkup(threads));
    }
    async terminate(chatId, messageId, threadId, requestId) {
        const pending = requestId ? this.state.data.pendingRequests[requestId] : undefined;
        if (pending && pending.status === "open") {
            pending.status = "terminated";
            await this.codex.answerUserInput(pending.serverRequestId, {});
        }
        const thread = this.state.data.threads[threadId];
        if (thread?.status === "active")
            await this.codex.interruptThread(threadId, this.state.data.activeTurns[threadId] ?? thread.lastTurnId);
        if (messageId)
            await this.telegram.editMessageText(chatId, messageId, `Closed: ${titleForThread(thread ?? this.syntheticThread(threadId))}`);
        this.save();
    }
    async answerChoice(chatId, messageId, requestId, questionId, answer) {
        const pending = this.state.data.pendingRequests[requestId];
        if (!pending || pending.status !== "open") {
            await this.telegram.sendMessage(chatId, "That request is already closed.");
            return;
        }
        pending.answers[questionId] = [answer];
        const complete = pending.questions.every((question) => pending.answers[question.id]?.length);
        if (!complete) {
            if (messageId)
                await this.telegram.editMessageText(chatId, messageId, this.formatRequestMessage(this.state.data.threads[pending.threadId] ?? this.syntheticThread(pending.threadId), pending), this.requestMarkup(pending));
            this.save();
            return;
        }
        pending.status = "answered";
        await this.codex.answerUserInput(pending.serverRequestId, Object.fromEntries(Object.entries(pending.answers).map(([id, answers]) => [id, { answers }])));
        if (messageId)
            await this.telegram.editMessageText(chatId, messageId, `${this.formatRequestMessage(this.state.data.threads[pending.threadId] ?? this.syntheticThread(pending.threadId), pending)}\n\nAnswered.`);
        this.save();
    }
    async threadListMarkup() {
        return this.makeThreadListMarkup(await this.refreshThreads(10));
    }
    makeThreadListMarkup(threads) {
        return { inline_keyboard: threads.slice(0, 10).map((thread) => [{ text: titleForThread(thread).slice(0, 48), callback_data: this.state.callback({ type: "selectThread", threadId: thread.id }) }]) };
    }
    threadMarkup(thread, includeContinue, requestId) {
        const row = [{ text: "Select thread", callback_data: this.state.callback({ type: "selectThread", threadId: thread.id }) }];
        if (includeContinue && thread.continuable)
            row.push({ text: "Continue", callback_data: this.state.callback({ type: "continueThread", threadId: thread.id }) });
        row.push({ text: "Terminate", callback_data: this.state.callback({ type: "terminateThread", threadId: thread.id, requestId }) });
        return { inline_keyboard: [row] };
    }
    requestMarkup(pending) {
        const rows = [];
        for (const question of pending.questions) {
            for (const option of question.options ?? [])
                rows.push([{ text: option.label.slice(0, 56), callback_data: this.state.callback({ type: "answerChoice", requestId: pending.id, questionId: question.id, answer: option.label }) }]);
        }
        rows.push([{ text: "Select thread", callback_data: this.state.callback({ type: "selectThread", threadId: pending.threadId }) }, { text: "Terminate", callback_data: this.state.callback({ type: "terminateThread", threadId: pending.threadId, requestId: pending.id }) }]);
        return { inline_keyboard: rows };
    }
    formatRequestMessage(thread, pending) {
        const lines = [`Codex: ${titleForThread(thread)}`, `Status: waiting for your decision`, `Timeout: ${new Date(pending.expiresAt).toLocaleString()}`, ""];
        for (const question of pending.questions) {
            lines.push(question.header ? `${question.header}: ${question.question}` : question.question);
            for (const option of question.options ?? [])
                lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
            const chosen = pending.answers[question.id]?.join(", ");
            if (chosen)
                lines.push(`Selected: ${chosen}`);
            lines.push("");
        }
        return truncateText(lines.join("\n"));
    }
    selectedThread(chatId) {
        const id = this.state.data.selectedThreadByChat[chatId];
        return id ? this.state.data.threads[id] : undefined;
    }
    authorized(chatId) {
        return this.config.allowedChatIds.includes(chatId);
    }
    upsertThread(thread) {
        this.state.data.threads[thread.id] = { ...this.state.data.threads[thread.id], ...thread, title: titleForThread(thread), updatedAt: thread.updatedAt || Date.now() };
        if (thread.lastTurnId)
            this.state.data.activeTurns[thread.id] = thread.lastTurnId;
    }
    syntheticThread(id, cwd, continuable = true) {
        return { id, title: id, cwd, status: "notLoaded", activeFlags: [], updatedAt: Date.now(), continuable };
    }
    seenRecently(key) {
        const previous = this.state.data.sentEvents[key];
        return typeof previous === "number" && Date.now() - previous < 60_000;
    }
    save() {
        this.store.save(this.state);
    }
}
function samePath(a, b) {
    if (!a || !b)
        return false;
    return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}
function normalizeStopEventKey(eventKey) {
    return eventKey.replace(/:(?:hook-stop|turn-completed)$/, ":stop");
}
function isTitleGenerationHook(payload) {
    const summary = String(payload.last_assistant_message ?? payload["last-assistant-message"] ?? "");
    const inputMessages = Array.isArray(payload["input-messages"]) ? payload["input-messages"].map(String) : [];
    if (inputMessages.some((message) => message.includes("Generate a concise UI title") || message.includes("User prompt:"))) {
        try {
            const parsed = JSON.parse(summary);
            if (typeof parsed.title === "string")
                return true;
        }
        catch {
            return false;
        }
    }
    return false;
}
function friendlyError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("no rollout found"))
        return "the selected item was not a resumable Codex conversation";
    return truncateText(message, 220);
}
//# sourceMappingURL=core.js.map