import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { defaultStateDir } from "./config.js";
import type { HookInboxEvent } from "./types.js";

export async function enqueueHookEvent(argv: string[], stdin: string, cwd = process.cwd()): Promise<string> {
  const stateDir = defaultStateDir();
  const inbox = path.join(stateDir, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const raw = stdin.trim() || argv.at(-1) || "";
  let payload: unknown = raw;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  const event: HookInboxEvent = { id, receivedAt: Date.now(), cwd, argv, payload };
  fs.writeFileSync(path.join(inbox, `${id}.json`), `${JSON.stringify(event)}\n`, "utf8");
  return id;
}

export class HookInbox {
  readonly inboxDir: string;

  constructor(readonly stateDir: string, readonly onEvent: (event: HookInboxEvent) => Promise<void>) {
    this.inboxDir = path.join(stateDir, "inbox");
  }

  async drain(): Promise<void> {
    fs.mkdirSync(this.inboxDir, { recursive: true });
    const files = fs.readdirSync(this.inboxDir).filter((file) => file.endsWith(".json")).sort();
    for (const file of files) {
      const fullPath = path.join(this.inboxDir, file);
      const processing = path.join(this.inboxDir, `${file}.${process.pid}.${os.hostname()}.processing`);
      try {
        fs.renameSync(fullPath, processing);
      } catch {
        continue;
      }
      try {
        const event = JSON.parse(fs.readFileSync(processing, "utf8")) as HookInboxEvent;
        await this.onEvent(event);
        fs.unlinkSync(processing);
      } catch {
        fs.renameSync(processing, fullPath);
      }
    }
  }
}
