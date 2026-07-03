import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BridgeStateData, CallbackAction } from "./types.js";

export class BridgeState {
  data: BridgeStateData;

  constructor(data?: Partial<BridgeStateData>) {
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

  callback(action: CallbackAction): string {
    const id = crypto.randomBytes(6).toString("base64url");
    this.data.callbackActions[id] = action;
    return `cb:${id}`;
  }

  resolveCallback(data: string): CallbackAction | undefined {
    const id = data.startsWith("cb:") ? data.slice(3) : data;
    return this.data.callbackActions[id];
  }
}

export class StateStore {
  readonly filePath: string;

  constructor(readonly stateDir: string) {
    this.filePath = path.join(stateDir, "state.json");
  }

  load(): BridgeState {
    if (!fs.existsSync(this.filePath)) return new BridgeState();
    const raw = fs.readFileSync(this.filePath, "utf8");
    return new BridgeState(JSON.parse(raw) as Partial<BridgeStateData>);
  }

  save(state: BridgeState): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state.data, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }
}
