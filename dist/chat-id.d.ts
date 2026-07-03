import type { TelegramUpdate } from "./types.js";
interface TelegramUpdateReader {
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
}
export declare function chatIdFromUpdate(update: TelegramUpdate): string | undefined;
export declare function discoverChatId(client: TelegramUpdateReader): Promise<string>;
export {};
