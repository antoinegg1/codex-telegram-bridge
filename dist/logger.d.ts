export declare class BridgeLogger {
    readonly stateDir: string;
    constructor(stateDir: string);
    log(event: string, payload: unknown): void;
}
