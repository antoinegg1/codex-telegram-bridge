import type { BridgeStateData, CallbackAction } from "./types.js";
export declare class BridgeState {
    data: BridgeStateData;
    constructor(data?: Partial<BridgeStateData>);
    callback(action: CallbackAction): string;
    resolveCallback(data: string): CallbackAction | undefined;
}
export declare class StateStore {
    readonly stateDir: string;
    readonly filePath: string;
    constructor(stateDir: string);
    load(): BridgeState;
    save(state: BridgeState): void;
}
