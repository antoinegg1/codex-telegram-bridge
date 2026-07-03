import fs from "node:fs";
import path from "node:path";

export class BridgeLogger {
  constructor(readonly stateDir: string) {}

  log(event: string, payload: unknown): void {
    const logsDir = path.join(this.stateDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(logsDir, `${day}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), event, payload })}\n`, "utf8");
  }
}
