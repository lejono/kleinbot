import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyMessage,
  buildRawRecord,
  rawLogPath,
  appendRawMessage,
} from "../src/raw-capture.js";
import type { ChatMessage } from "../src/types.js";

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    chatJid: "+15551234567",
    timestamp: 1781071204,
    sender: "Test User",
    senderJid: "+15551234567",
    text: "hello",
    ...overrides,
  };
}

function att(contentType: string) {
  return { id: "a1", contentType, filename: null, size: 123, localPath: "/tmp/a1" };
}

describe("classifyMessage", () => {
  it("plain text with no attachments → text", () => {
    assert.equal(classifyMessage(msg()), "text");
  });
  it("audio attachment → voicenote", () => {
    assert.equal(classifyMessage(msg({ attachments: [att("audio/aac")] })), "voicenote");
  });
  it("image attachment → image", () => {
    assert.equal(classifyMessage(msg({ attachments: [att("image/jpeg")] })), "image");
  });
  it("pdf attachment → pdf", () => {
    assert.equal(classifyMessage(msg({ attachments: [att("application/pdf")] })), "pdf");
  });
  it("other attachment → doc", () => {
    assert.equal(classifyMessage(msg({ attachments: [att("application/zip")] })), "doc");
  });
  it("audio wins over image when both present (voicenote priority)", () => {
    assert.equal(
      classifyMessage(msg({ attachments: [att("image/jpeg"), att("audio/aac")] })),
      "voicenote",
    );
  });
});

describe("buildRawRecord", () => {
  it("maps all fields and stamps capturedAt as ISO", () => {
    const when = new Date("2026-06-20T10:30:00.000Z");
    const r = buildRawRecord("signal", msg({ text: "  keep raw  " }), when);
    assert.equal(r.capturedAt, "2026-06-20T10:30:00.000Z");
    assert.equal(r.messageTs, 1781071204);
    assert.equal(r.transport, "signal");
    assert.equal(r.id, "m1");
    assert.equal(r.chatJid, "+15551234567");
    assert.equal(r.senderJid, "+15551234567");
    assert.equal(r.sender, "Test User");
    assert.equal(r.type, "text");
    assert.equal(r.text, "  keep raw  "); // preserved verbatim, not trimmed
    assert.deepEqual(r.attachments, []);
  });
  it("maps attachment localPath → path and keeps metadata", () => {
    const r = buildRawRecord("signal", msg({ attachments: [att("audio/aac")] }), new Date());
    assert.equal(r.type, "voicenote");
    assert.deepEqual(r.attachments, [
      { path: "/tmp/a1", contentType: "audio/aac", filename: null, size: 123 },
    ]);
  });
  it("missing text becomes empty string", () => {
    const r = buildRawRecord("signal", msg({ text: undefined as unknown as string }), new Date());
    assert.equal(r.text, "");
  });
});

describe("rawLogPath", () => {
  it("is <dataDir>/<transport>/raw/YYYY-MM.jsonl with zero-padded month", () => {
    const p = rawLogPath("/data", "signal", new Date("2026-06-20T00:00:00Z"));
    assert.equal(p, path.join("/data", "signal", "raw", "2026-06.jsonl"));
    const p2 = rawLogPath("/data", "whatsapp", new Date("2026-01-05T00:00:00Z"));
    assert.equal(p2, path.join("/data", "whatsapp", "raw", "2026-01.jsonl"));
  });
});

describe("appendRawMessage", () => {
  it("creates the monthly file and appends one JSONL line per call (append-only)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-raw-"));
    const when = new Date("2026-06-20T10:30:00.000Z");
    await appendRawMessage(dir, "signal", msg({ id: "m1", text: "first" }), when);
    await appendRawMessage(dir, "signal", msg({ id: "m2", text: "second" }), when);

    const file = path.join(dir, "signal", "raw", "2026-06.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.id, "m1");
    assert.equal(first.text, "first");
    assert.equal(second.id, "m2");
    assert.equal(second.text, "second");
    assert.equal(first.transport, "signal");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
