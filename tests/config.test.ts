import { describe, expect, it } from "vitest";
import { loadConfig, parseChatIds } from "../src/config.js";

describe("config", () => {
  it("parses comma-separated chat ids", () => {
    expect(parseChatIds("1, 2,,3")).toEqual(["1", "2", "3"]);
  });

  it("loads required environment without exposing token in errors", () => {
    const config = loadConfig({ CODEX_TG_BOT_TOKEN: "secret-token", CODEX_TG_CHAT_ID: "42" });
    expect(config.allowedChatIds).toEqual(["42"]);
    expect(config.timeoutSeconds).toBe(900);
  });

  it("rejects missing token with a generic message", () => {
    expect(() => loadConfig({ CODEX_TG_CHAT_ID: "42" })).toThrow("Missing CODEX_TG_BOT_TOKEN");
  });
});
