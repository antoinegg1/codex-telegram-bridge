import type { TelegramUpdate } from "./types.js";

interface TelegramUpdateReader {
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
}

export function chatIdFromUpdate(update: TelegramUpdate): string | undefined {
  const id = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  return id === undefined ? undefined : String(id);
}

export async function discoverChatId(client: TelegramUpdateReader): Promise<string> {
  const deadline = Date.now() + 60000;
  let offset: number | undefined;
  while (Date.now() < deadline) {
    const updates = await client.getUpdates(offset);
    let found: string | undefined;
    for (const update of updates) {
      offset = update.update_id + 1;
      found = chatIdFromUpdate(update) ?? found;
    }
    if (found) return found;
  }
  throw new Error("No Telegram chat id found. Send any message to your bot and run this command again.");
}
