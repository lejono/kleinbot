import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTranscript } from "../src/ai.js";
import type { ChatMessage, MessageAttachment } from "../src/types.js";

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1", chatJid: "+15551234567",
    timestamp: new Date(2026, 5, 20, 10, 30).getTime() / 1000,
    sender: "Sender", senderJid: "+15551234567", text: "text",
    ...overrides,
  };
}

function att(filename: string | null, contentType = "image/jpeg"): MessageAttachment {
  return { id: "a1", contentType, filename, size: 123, localPath: "/tmp/a1" };
}

describe("formatTranscript", () => {
  it("preserves the format of messages without attachments", () => {
    assert.equal(formatTranscript([msg()]), "[10:30] Sender: text");
  });

  it("describes an image sent without message text", () => {
    assert.equal(
      formatTranscript([msg({ text: "", attachments: [att("photo.jpg")] })]),
      "[10:30] Sender:  [sent file: photo.jpg, image/jpeg]",
    );
  });

  it("removes filename newlines and control characters", () => {
    assert.equal(
      formatTranscript([msg({ attachments: [att("pho\n\r\t\x00\x1b\x7f\x85\u2028\u2029to.jpg")] })]),
      "[10:30] Sender: text [sent file: photo.jpg, image/jpeg]",
    );
  });

  it("caps displayed filenames at 80 characters", () => {
    assert.equal(
      formatTranscript([msg({ attachments: [att("x".repeat(100))] })]),
      `[10:30] Sender: text [sent file: ${"x".repeat(80)}, image/jpeg]`,
    );
  });

  it("describes each attachment and uses unnamed for null filenames", () => {
    assert.equal(
      formatTranscript([msg({ attachments: [att(null), att("note.md", "text/markdown")] })]),
      "[10:30] Sender: text [sent file: unnamed, image/jpeg] [sent file: note.md, text/markdown]",
    );
  });

  it("preserves quoted text and separates messages with newlines", () => {
    assert.equal(
      formatTranscript([msg({ quotedText: "earlier" }), msg({ text: "next" })]),
      '[10:30] Sender: text (replying to: "earlier")\n[10:30] Sender: next',
    );
  });

  it("uses unnamed for empty and sanitised-to-empty filenames", () => {
    assert.equal(
      formatTranscript([msg({ attachments: [att(""), att("\n\r\t\x00\x1b\x7f\x85\u2028\u2029")] })]),
      "[10:30] Sender: text [sent file: unnamed, image/jpeg] [sent file: unnamed, image/jpeg]",
    );
  });
});
