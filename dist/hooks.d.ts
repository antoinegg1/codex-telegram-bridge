import type { HookInboxEvent } from "./types.js";
export declare function enqueueHookEvent(argv: string[], stdin: string, cwd?: string): Promise<string>;
export declare class HookInbox {
    readonly stateDir: string;
    readonly onEvent: (event: HookInboxEvent) => Promise<void>;
    readonly inboxDir: string;
    constructor(stateDir: string, onEvent: (event: HookInboxEvent) => Promise<void>);
    drain(): Promise<void>;
}
