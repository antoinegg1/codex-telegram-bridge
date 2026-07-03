import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { defaultStateDir } from "./config.js";
export async function enqueueHookEvent(argv, stdin, cwd = process.cwd()) {
    const stateDir = defaultStateDir();
    const inbox = path.join(stateDir, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
    const raw = stdin.trim() || argv.at(-1) || "";
    let payload = raw;
    if (raw) {
        try {
            payload = JSON.parse(raw);
        }
        catch {
            payload = { raw };
        }
    }
    const event = { id, receivedAt: Date.now(), cwd, argv, payload };
    fs.writeFileSync(path.join(inbox, `${id}.json`), `${JSON.stringify(event)}\n`, "utf8");
    return id;
}
export class HookInbox {
    stateDir;
    onEvent;
    inboxDir;
    constructor(stateDir, onEvent) {
        this.stateDir = stateDir;
        this.onEvent = onEvent;
        this.inboxDir = path.join(stateDir, "inbox");
    }
    async drain() {
        fs.mkdirSync(this.inboxDir, { recursive: true });
        const files = fs.readdirSync(this.inboxDir).filter((file) => file.endsWith(".json")).sort();
        for (const file of files) {
            const fullPath = path.join(this.inboxDir, file);
            const processing = path.join(this.inboxDir, `${file}.${process.pid}.${os.hostname()}.processing`);
            try {
                fs.renameSync(fullPath, processing);
            }
            catch {
                continue;
            }
            try {
                const event = JSON.parse(fs.readFileSync(processing, "utf8"));
                await this.onEvent(event);
                fs.unlinkSync(processing);
            }
            catch {
                fs.renameSync(processing, fullPath);
            }
        }
    }
}
//# sourceMappingURL=hooks.js.map