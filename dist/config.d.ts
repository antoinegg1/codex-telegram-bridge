export interface BridgeConfig {
    botToken: string;
    allowedChatIds: string[];
    timeoutSeconds: number;
    codexCliPath: string;
    stateDir: string;
}
export declare function defaultStateDir(): string;
export declare function parseChatIds(value: string | undefined): string[];
export declare function loadConfig(env?: NodeJS.ProcessEnv): BridgeConfig;
