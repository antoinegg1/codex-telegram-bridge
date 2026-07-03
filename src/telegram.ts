import type { TelegramReplyMarkup, TelegramTransport, TelegramUpdate } from "./types.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramClient implements TelegramTransport {
  constructor(readonly token: string) {}

  async sendMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup): Promise<{ message_id: number }> {
    return this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, reply_markup: replyMarkup });
  }

  async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: TelegramReplyMarkup): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, reply_markup: replyMarkup });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 400")) return;
      throw error;
    }
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}: ${bodyText}`);
    const json = JSON.parse(bodyText) as TelegramApiResponse<T>;
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? "unknown error"}`);
    return json.result as T;
  }
}

export class TelegramPoller {
  private stopped = false;

  constructor(readonly client: TelegramClient, readonly onUpdate: (update: TelegramUpdate) => Promise<void>, private offset?: number) {}

  async start(): Promise<void> {
    while (!this.stopped) {
      const updates = await this.client.getUpdates(this.offset);
      for (const update of updates) {
        this.offset = update.update_id + 1;
        await this.onUpdate(update);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  currentOffset(): number | undefined {
    return this.offset;
  }
}
