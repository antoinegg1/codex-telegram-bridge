import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const promptBlock = `\n<!-- codex-telegram-bridge:start -->\nWhen you are about to stop, need a user decision, or are using request_user_input, make your final visible message Telegram-friendly: include a concise summary of the current situation, clearly numbered choices when a decision is needed, a terminate option when relevant, and enough thread/session context for a remote phone reply to continue the work. Do not ask Telegram to approve commands or file edits.\n<!-- codex-telegram-bridge:end -->\n`;
export function codexHome() {
    return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}
export function installCodexHooks(home = codexHome(), notifyCommand = ["codex-telegram-bridge", "hook", "notify"]) {
    fs.mkdirSync(home, { recursive: true });
    const changed = [];
    const configPath = path.join(home, "config.toml");
    const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const nextConfig = ensureConfig(previousConfig, notifyCommand);
    if (nextConfig !== previousConfig) {
        backup(configPath);
        fs.writeFileSync(configPath, nextConfig, "utf8");
        changed.push(configPath);
    }
    const agentsPath = path.join(home, "AGENTS.md");
    const previousAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
    if (!previousAgents.includes("codex-telegram-bridge:start")) {
        backup(agentsPath);
        fs.writeFileSync(agentsPath, `${previousAgents.trimEnd()}${promptBlock}`, "utf8");
        changed.push(agentsPath);
    }
    const hooksPath = path.join(home, "hooks.json");
    if (fs.existsSync(hooksPath)) {
        const previousHooks = fs.readFileSync(hooksPath, "utf8");
        const nextHooks = removeLegacyTelegramApprovalHooks(previousHooks);
        if (nextHooks !== previousHooks) {
            backup(hooksPath);
            fs.writeFileSync(hooksPath, nextHooks, "utf8");
            changed.push(hooksPath);
        }
    }
    return changed;
}
export function ensureConfig(config, notifyCommand = ["codex-telegram-bridge", "hook", "notify"]) {
    const notifyLine = `notify = [ ${notifyCommand.map(tomlString).join(", ")} ]`;
    const lines = config.split(/\r?\n/);
    const notifyIndex = lines.findIndex((line) => /^\s*notify\s*=/.test(line));
    if (notifyIndex >= 0)
        lines[notifyIndex] = notifyLine;
    else
        lines.unshift(notifyLine);
    const featuresIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
    if (featuresIndex >= 0) {
        let insertAt = featuresIndex + 1;
        let hooksIndex = -1;
        for (let index = featuresIndex + 1; index < lines.length; index++) {
            if (/^\s*\[/.test(lines[index]))
                break;
            if (/^\s*hooks\s*=/.test(lines[index]))
                hooksIndex = index;
            insertAt = index + 1;
        }
        if (hooksIndex >= 0)
            lines[hooksIndex] = "hooks = true";
        else
            lines.splice(insertAt, 0, "hooks = true");
    }
    else {
        lines.push("", "[features]", "hooks = true");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}
export function removeLegacyTelegramApprovalHooks(raw) {
    try {
        const parsed = JSON.parse(raw);
        const permission = parsed.hooks?.PermissionRequest;
        if (!Array.isArray(permission))
            return raw;
        const filtered = permission.map((entry) => {
            const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
            return { ...entry, hooks: hooks.filter((hook) => !JSON.stringify(hook).includes("telegram-notify.ps1") && !JSON.stringify(hook).includes("codex-notify-wrapper.ps1")) };
        }).filter((entry) => entry.hooks.length > 0);
        if (filtered.length > 0)
            parsed.hooks.PermissionRequest = filtered;
        else
            delete parsed.hooks.PermissionRequest;
        return `${JSON.stringify(parsed, null, 2)}\n`;
    }
    catch {
        return raw;
    }
}
function backup(filePath) {
    if (fs.existsSync(filePath))
        fs.copyFileSync(filePath, `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}
function tomlString(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
//# sourceMappingURL=install.js.map