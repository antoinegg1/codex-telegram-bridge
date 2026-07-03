import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export class BridgeState {
    data;
    constructor(data) {
        this.data = {
            selectedThreadByChat: {},
            threads: {},
            pendingRequests: {},
            callbackActions: {},
            activeTurns: {},
            sentEvents: {},
            ...data
        };
    }
    callback(action) {
        const id = crypto.randomBytes(6).toString("base64url");
        this.data.callbackActions[id] = action;
        return `cb:${id}`;
    }
    resolveCallback(data) {
        const id = data.startsWith("cb:") ? data.slice(3) : data;
        return this.data.callbackActions[id];
    }
}
export class StateStore {
    stateDir;
    filePath;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.filePath = path.join(stateDir, "state.json");
    }
    load() {
        if (!fs.existsSync(this.filePath))
            return new BridgeState();
        const raw = fs.readFileSync(this.filePath, "utf8");
        return new BridgeState(JSON.parse(raw));
    }
    save(state) {
        fs.mkdirSync(this.stateDir, { recursive: true });
        const temp = `${this.filePath}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(state.data, null, 2)}\n`, "utf8");
        fs.renameSync(temp, this.filePath);
    }
}
//# sourceMappingURL=state.js.map