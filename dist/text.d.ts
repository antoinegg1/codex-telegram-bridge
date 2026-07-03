import type { ThreadRecord } from "./types.js";
export declare function truncateText(text: string, max?: number): string;
export declare function titleForThread(thread: Partial<ThreadRecord> & {
    id: string;
}): string;
export declare function formatThreadStatus(thread: ThreadRecord): string;
export declare function formatStopMessage(thread: ThreadRecord, status: string, summary: string): string;
export declare function formatThreadList(threads: ThreadRecord[]): string;
