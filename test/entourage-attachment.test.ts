import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mimeForPath,
  resolveAttachment,
  relayFlag,
} from "../src/entourage-watcher.js";

function fakeTransport() {
  const calls: any[] = [];
  return {
    calls,
    async sendText(chatId: string, text: string) {
      calls.push({ kind: "text", chatId, text });
    },
    async sendFile(
      chatId: string,
      buffer: Buffer,
      fileName: string,
      mimetype: string,
      caption?: string,
    ) {
      calls.push({ kind: "file", chatId, buffer, fileName, mimetype, caption });
      return true;
    },
  };
}

describe("mimeForPath", () => {
  it("maps .png to image/png", () => {
    assert.equal(mimeForPath("/x/a.png"), "image/png");
  });
  it("maps .PDF case-insensitively", () => {
    assert.equal(mimeForPath("/x/a.PDF"), "application/pdf");
  });
  it("falls back to application/octet-stream for unknown extensions", () => {
    assert.equal(mimeForPath("/x/a.xyz"), "application/octet-stream");
  });
});

describe("resolveAttachment", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ent-"));
    file = path.join(dir, "shot.png");
    fs.writeFileSync(file, Buffer.from("PNGDATA"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a file inside an allowed root", () => {
    const r = resolveAttachment(file, { allowRoots: [dir], maxBytes: 1000 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.fileName, "shot.png");
      assert.equal(r.mimetype, "image/png");
      assert.equal(r.buffer.toString(), "PNGDATA");
    }
  });
  it("rejects a path outside the allowed roots", () => {
    const r = resolveAttachment("/etc/hosts", { allowRoots: [dir], maxBytes: 1000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /allow|outside/i);
  });
  it("rejects a missing file", () => {
    const r = resolveAttachment(path.join(dir, "nope.png"), {
      allowRoots: [dir],
      maxBytes: 1000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not found|exist/i);
  });
  it("rejects an oversized file", () => {
    const r = resolveAttachment(file, { allowRoots: [dir], maxBytes: 3 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /large|size/i);
  });
});

describe("relayFlag", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ent-"));
    file = path.join(dir, "shot.png");
    fs.writeFileSync(file, Buffer.from("PNGDATA"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const opts = () => ({ allowRoots: [dir], maxBytes: 1000 });

  // relayFlag pins the destination by configuration and refuses to send
  // without one, so every case here supplies it. targetChatJid is left
  // pointing elsewhere to show it is ignored.
  const PINNED = "+44";

  it("sends a file when the flag has a valid attachmentPath", async () => {
    const t = fakeTransport();
    await relayFlag(
      t as any,
      { targetChatJid: "+4999ATTACKER", text: "PO screenshot", attachmentPath: file } as any,
      opts(),
      PINNED,
    );
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].kind, "file");
    assert.equal(t.calls[0].chatId, "+44");
    assert.equal(t.calls[0].fileName, "shot.png");
    assert.equal(t.calls[0].mimetype, "image/png");
    assert.equal(t.calls[0].caption, "PO screenshot");
  });

  it("falls back to text with a note when the attachment is unavailable", async () => {
    const t = fakeTransport();
    await relayFlag(
      t as any,
      { targetChatJid: "+4999ATTACKER", text: "PO screenshot", attachmentPath: "/etc/hosts" } as any,
      opts(),
      PINNED,
    );
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].kind, "text");
    assert.match(t.calls[0].text, /PO screenshot/);
    assert.match(t.calls[0].text, /unavailable/i);
  });

  it("sends plain text when there is no attachment", async () => {
    const t = fakeTransport();
    await relayFlag(
      t as any,
      { targetChatJid: "+4999ATTACKER", text: "just text" } as any,
      opts(),
      PINNED,
    );
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].kind, "text");
    assert.equal(t.calls[0].text, "just text");
  });
});
