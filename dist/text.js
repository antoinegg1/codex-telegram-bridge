import path from "node:path";
export function truncateText(text, max = 3000) {
    const clean = text.replace(/\r\n/g, "\n").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 4)} ...`;
}
export function titleForThread(thread) {
    if (thread.title?.trim())
        return thread.title.trim();
    if (thread.preview?.trim())
        return truncateText(thread.preview, 80);
    if (thread.cwd?.trim())
        return path.basename(thread.cwd);
    return thread.id.slice(0, 12);
}
export function formatThreadStatus(thread) {
    const flags = thread.activeFlags.length > 0 ? ` (${thread.activeFlags.join(", ")})` : "";
    return `${thread.status}${flags}`;
}
export function formatStopMessage(thread, status, summary) {
    return truncateText(`Codex: ${titleForThread(thread)}\nStatus: ${status}\n\nSummary:\n${summary || "No summary was provided."}`);
}
export function formatThreadList(threads) {
    if (threads.length === 0)
        return "No recent Codex threads found.";
    const lines = threads.map((thread, index) => `${index + 1}. ${titleForThread(thread)}\n   ${formatThreadStatus(thread)}${thread.cwd ? `\n   ${thread.cwd}` : ""}`);
    return truncateText(`Recent Codex threads:\n\n${lines.join("\n\n")}`);
}
//# sourceMappingURL=text.js.map