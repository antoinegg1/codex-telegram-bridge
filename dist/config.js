import os from "node:os";
import path from "node:path";
export function defaultStateDir() {
    if (process.platform === "win32")
        return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "codex-telegram-bridge");
    if (process.platform === "darwin")
        return path.join(os.homedir(), "Library", "Application Support", "codex-telegram-bridge");
    return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "codex-telegram-bridge");
}
export function parseChatIds(value) {
    return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
export function loadConfig(env = process.env) {
    const botToken = env.CODEX_TG_BOT_TOKEN;
    if (!botToken)
        throw new Error("Missing CODEX_TG_BOT_TOKEN");
    const allowedChatIds = parseChatIds(env.CODEX_TG_CHAT_IDS ?? env.CODEX_TG_CHAT_ID);
    if (allowedChatIds.length === 0)
        throw new Error("Missing CODEX_TG_CHAT_ID");
    const timeoutSeconds = Number(env.CODEX_TG_TIMEOUT_SECONDS ?? "900");
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
        throw new Error("CODEX_TG_TIMEOUT_SECONDS must be a positive number");
    return {
        botToken,
        allowedChatIds,
        timeoutSeconds,
        codexCliPath: env.CODEX_CLI_PATH ?? "codex",
        stateDir: defaultStateDir()
    };
}
//# sourceMappingURL=config.js.map