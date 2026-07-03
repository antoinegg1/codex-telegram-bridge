import { describe, expect, it } from "vitest";
import { chatIdFromUpdate } from "../src/chat-id.js";

describe("chatIdFromUpdate", () => {
  it("reads a private message chat id", () => {
    expect(chatIdFromUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 12345 }, text: "hello" } })).toBe("12345");
  });

  it("reads a callback message chat id", () => {
    expect(chatIdFromUpdate({
      update_id: 2,
      callback_query: {
        id: "callback",
        from: { id: 999 },
        message: { message_id: 11, chat: { id: "-100123" } },
        data: "action"
      }
    })).toBe("-100123");
  });

  it("ignores callback queries without message context", () => {
    expect(chatIdFromUpdate({ update_id: 3, callback_query: { id: "inline", from: { id: 999 } } })).toBeUndefined();
  });
});
