import fs from "node:fs";
import path from "node:path";
export class BridgeLogger {
    stateDir;
    constructor(stateDir) {
        this.stateDir = stateDir;
    }
    log(event, payload) {
        const logsDir = path.join(this.stateDir, "logs");
        fs.mkdirSync(logsDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        fs.appendFileSync(path.join(logsDir, `${day}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), event, payload })}\n`, "utf8");
    }
}
//# sourceMappingURL=logger.js.map