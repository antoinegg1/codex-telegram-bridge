import path from "node:path";
import type { ThreadRecord } from "./types.js";

export function truncateText(text: string, max = 3000): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 4)} ...`;
}

export function titleForThread(thread: Partial<ThreadRecord> & { id: string }): string {
  if (thread.title?.trim()) return thread.title.trim();
  if (thread.preview?.trim()) return truncateText(thread.preview, 80);
  if (thread.cwd?.trim()) return path.basename(thread.cwd);
  return thread.id.slice(0, 12);
}

export function formatThreadStatus(thread: ThreadRecord): string {
  const flags = thread.activeFlags.length > 0 ? ` (${thread.activeFlags.join(", ")})` : "";
  return `${thread.status}${flags}`;
}

export function formatStopMessage(thread: ThreadRecord, status: string, summary: string): string {
  return truncateText(`Codex: ${titleForThread(thread)}\nStatus: ${status}\n\nSummary:\n${summary || "No summary was provided."}`);
}

export function formatThreadList(threads: ThreadRecord[]): string {
  if (threads.length === 0) return "No recent Codex threads found.";
  const lines = threads.map((thread, index) => `${index + 1}. ${titleForThread(thread)}\n   ${formatThreadStatus(thread)}${thread.cwd ? `\n   ${thread.cwd}` : ""}`);
  return truncateText(`Recent Codex threads:\n\n${lines.join("\n\n")}`);
}
