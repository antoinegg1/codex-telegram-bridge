import { EventEmitter } from "node:events";
import type { CodexController, JsonValue, RequestQuestion, ThreadRecord } from "./types.js";
type JsonRecord = Record<string, JsonValue | undefined>;
export declare class CodexAppServerClient extends EventEmitter implements CodexController {
    readonly codexCliPath: string;
    private child?;
    private nextId;
    private pending;
    private buffer;
    constructor(codexCliPath: string);
    start(): Promise<void>;
    stop(): void;
    listThreads(limit?: number): Promise<ThreadRecord[]>;
    readThread(threadId: string): Promise<ThreadRecord | null>;
    resumeThread(threadId: string): Promise<void>;
    startTurn(threadId: string, text: string): Promise<void>;
    interruptThread(threadId: string, turnId?: string): Promise<void>;
    answerUserInput(serverRequestId: string | number, answers: Record<string, {
        answers: string[];
    }>): Promise<void>;
    cancelApproval(serverRequestId: string | number, method: string): Promise<void>;
    private request;
    private notify;
    private respond;
    private write;
    private onStdout;
    private onMessage;
    private threadFromProtocol;
}
export declare function lastAssistantText(turn: JsonRecord): string;
export declare function requestQuestionsFromProtocol(value: unknown): RequestQuestion[];
export {};
