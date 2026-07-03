import type { TelegramReplyMarkup, TelegramTransport, TelegramUpdate } from "./types.js";
export declare class TelegramClient implements TelegramTransport {
    readonly token: string;
    constructor(token: string);
    sendMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup): Promise<{
        message_id: number;
    }>;
    editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: TelegramReplyMarkup): Promise<void>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    private call;
}
export declare class TelegramPoller {
    readonly client: TelegramClient;
    readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
    private offset?;
    private stopped;
    constructor(client: TelegramClient, onUpdate: (update: TelegramUpdate) => Promise<void>, offset?: number | undefined);
    start(): Promise<void>;
    stop(): void;
    currentOffset(): number | undefined;
}
