export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type ThreadRuntimeStatus = "notLoaded" | "idle" | "systemError" | "active";
export interface ThreadRecord {
    id: string;
    title: string;
    preview?: string;
    cwd?: string;
    status: ThreadRuntimeStatus;
    activeFlags: string[];
    source?: string;
    lastTurnId?: string;
    lastSummary?: string;
    updatedAt: number;
    continuable: boolean;
}
export interface RequestQuestion {
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{
        label: string;
        description: string;
    }> | null;
}
export interface PendingRequest {
    id: string;
    serverRequestId: string | number;
    threadId: string;
    turnId?: string;
    itemId?: string;
    questions: RequestQuestion[];
    answers: Record<string, string[]>;
    chatId: string;
    messageId?: number;
    createdAt: number;
    expiresAt: number;
    status: "open" | "answered" | "terminated" | "timed_out";
}
export type CallbackAction = {
    type: "selectThread";
    threadId: string;
} | {
    type: "continueThread";
    threadId: string;
} | {
    type: "terminateThread";
    threadId: string;
    requestId?: string;
} | {
    type: "answerChoice";
    requestId: string;
    questionId: string;
    answer: string;
};
export interface BridgeStateData {
    selectedThreadByChat: Record<string, string>;
    threads: Record<string, ThreadRecord>;
    pendingRequests: Record<string, PendingRequest>;
    callbackActions: Record<string, CallbackAction>;
    activeTurns: Record<string, string>;
    sentEvents: Record<string, number>;
    telegramOffset?: number;
}
export interface TelegramButton {
    text: string;
    callback_data: string;
}
export interface TelegramReplyMarkup {
    inline_keyboard: TelegramButton[][];
}
export interface TelegramMessage {
    message_id: number;
    chat: {
        id: number | string;
        type?: string;
    };
    text?: string;
}
export interface TelegramCallbackQuery {
    id: string;
    from?: {
        id: number | string;
    };
    message?: TelegramMessage;
    data?: string;
}
export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}
export interface TelegramTransport {
    sendMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup): Promise<{
        message_id: number;
    }>;
    editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: TelegramReplyMarkup): Promise<void>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}
export interface CodexController {
    listThreads(limit?: number): Promise<ThreadRecord[]>;
    readThread(threadId: string): Promise<ThreadRecord | null>;
    resumeThread(threadId: string): Promise<void>;
    startTurn(threadId: string, text: string): Promise<void>;
    interruptThread(threadId: string, turnId?: string): Promise<void>;
    answerUserInput(serverRequestId: string | number, answers: Record<string, {
        answers: string[];
    }>): Promise<void>;
    cancelApproval?(serverRequestId: string | number, method: string): Promise<void>;
}
export interface HookInboxEvent {
    id: string;
    receivedAt: number;
    cwd: string;
    argv: string[];
    payload: unknown;
}
