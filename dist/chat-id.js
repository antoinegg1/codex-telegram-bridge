export function chatIdFromUpdate(update) {
    const id = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    return id === undefined ? undefined : String(id);
}
export async function discoverChatId(client) {
    const deadline = Date.now() + 60000;
    let offset;
    while (Date.now() < deadline) {
        const updates = await client.getUpdates(offset);
        let found;
        for (const update of updates) {
            offset = update.update_id + 1;
            found = chatIdFromUpdate(update) ?? found;
        }
        if (found)
            return found;
    }
    throw new Error("No Telegram chat id found. Send any message to your bot and run this command again.");
}
//# sourceMappingURL=chat-id.js.map