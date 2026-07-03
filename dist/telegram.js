export class TelegramClient {
    token;
    constructor(token) {
        this.token = token;
    }
    async sendMessage(chatId, text, replyMarkup) {
        return this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, reply_markup: replyMarkup });
    }
    async editMessageText(chatId, messageId, text, replyMarkup) {
        await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, reply_markup: replyMarkup });
    }
    async answerCallbackQuery(callbackQueryId, text) {
        await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    }
    async getUpdates(offset) {
        return this.call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    }
    async call(method, body) {
        const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        });
        if (!response.ok)
            throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
        const json = (await response.json());
        if (!json.ok)
            throw new Error(`Telegram ${method} failed: ${json.description ?? "unknown error"}`);
        return json.result;
    }
}
export class TelegramPoller {
    client;
    onUpdate;
    offset;
    stopped = false;
    constructor(client, onUpdate, offset) {
        this.client = client;
        this.onUpdate = onUpdate;
        this.offset = offset;
    }
    async start() {
        while (!this.stopped) {
            const updates = await this.client.getUpdates(this.offset);
            for (const update of updates) {
                this.offset = update.update_id + 1;
                await this.onUpdate(update);
            }
        }
    }
    stop() {
        this.stopped = true;
    }
    currentOffset() {
        return this.offset;
    }
}
//# sourceMappingURL=telegram.js.map