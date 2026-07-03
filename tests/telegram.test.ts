import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores expired callback query acknowledgements", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":false,"description":"Bad Request: query is too old"}', { status: 400 })));
    await expect(new TelegramClient("token").answerCallbackQuery("old")).resolves.toBeUndefined();
  });

  it("throws detailed errors for non-callback Telegram failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":false,"description":"Bad Request"}', { status: 400 })));
    await expect(new TelegramClient("token").sendMessage("42", "hello")).rejects.toThrow("HTTP 400");
  });
});
