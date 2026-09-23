import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roamConfig } from "../src/config.js";
import { readInboxMessages, shouldPipeMessage, writeInboxMessage } from "../src/roam/inbox.js";
import type { ChatMessage } from "../src/types.js";

it("pipes only the configured chat, including normalized JIDs", () => {
  const settings = { ...roamConfig, inboxDir: "synthetic-inbox", pipeChatJid: "synthetic@g.us" };
  assert.equal(shouldPipeMessage("synthetic@g.us", settings), true);
  assert.equal(shouldPipeMessage("different@g.us", settings), false);
  assert.equal(shouldPipeMessage("synthetic@g.us", { ...settings, inboxDir: "" }), false);
  assert.equal(shouldPipeMessage("synthetic@g.us", { ...settings, pipeChatJid: "" }), false);
  assert.equal(shouldPipeMessage("member:2@s.whatsapp.net", { ...settings, pipeChatJid: "member@s.whatsapp.net" }), true);
  assert.equal(shouldPipeMessage("member@lid", { ...settings, pipeChatJid: "member@s.whatsapp.net" }), false);
});

it("publishes only inbox fields atomically, strips identity fallbacks, and sets explicit modes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
  const original = { ...roamConfig };
  const umask = process.umask(0o077);
  try {
    Object.assign(roamConfig, { inboxDir: dir, pipeChatJid: "synthetic-group", inboxMaxTextChars: 12 });
    const msg: ChatMessage = { id: "synthetic-sender-id-message", chatJid: "synthetic-group", timestamp: 123,
      sender: "Synthetic Member", senderJid: "synthetic-sender-id", text: "a\x00\x1b\u202eb" + "c".repeat(30),
      attachments: [{ id: "attachment-id", contentType: "text/plain", filename: "../../folder\\note.txt",
        localPath: "/synthetic/private/note.txt", size: 10 }] };
    const rename = fs.renameSync;
    let renames = 0;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      assert.ok(String(from).endsWith(".tmp"));
      assert.ok(String(to).endsWith(".json"));
      assert.equal(readInboxMessages().some(m => m.message.timestamp === msg.timestamp), false);
      renames++;
      rename(from, to);
    });
    for (const shared of [false, true]) {
      roamConfig.inboxGroupReadable = shared;
      assert.equal(writeInboxMessage(msg, dir), true);
      const [{ file, message }] = readInboxMessages();
      const raw = fs.readFileSync(file, "utf8");
      assert.deepEqual(Object.keys(message).sort(), ["attachments", "id", "senderName", "text", "timestamp"]);
      assert.equal(message.senderName, "Synthetic Member");
      assert.equal(message.text, "ab" + "c".repeat(10));
      assert.deepEqual(message.attachments, [{ filename: "file-1.txt", contentType: "text/plain" }]);
      for (const secret of [msg.senderJid, msg.chatJid, msg.id, msg.attachments![0].localPath, "attachment-id"])
        assert.ok(!raw.includes(secret));
      assert.equal(fs.statSync(file).mode & 0o777, shared ? 0o640 : 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, shared ? 0o770 : 0o700);
      fs.unlinkSync(file);
    }
    t.mock.restoreAll();
    for (const sender of [msg.senderJid, "+" + "0".repeat(12), "", "opaque@lid"]) {
      assert.equal(writeInboxMessage({ ...msg, sender }, dir), true);
      assert.equal(readInboxMessages()[0].message.senderName, "member");
      assert.ok(!fs.readFileSync(readInboxMessages()[0].file, "utf8").includes(sender || "absent-sentinel"));
    }
    fs.writeFileSync(path.join(dir, "ignored.json.tmp"), "{}");
    assert.equal(readInboxMessages().length, 1);
    assert.equal(renames, 2);
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith(".tmp")).length, 1);
    roamConfig.inboxDir = path.join(dir, "blocked");
    fs.writeFileSync(roamConfig.inboxDir, "blocked");
    assert.equal(writeInboxMessage(msg, dir), false);
  } finally {
    t.mock.restoreAll();
    process.umask(umask);
    Object.assign(roamConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("masks numbers and mentions, generates filenames, and keys ids with a private persistent secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-private-"));
  const original = { ...roamConfig };
  try {
    Object.assign(roamConfig, { inboxDir: path.join(dir, "inbox"), pipeChatJid: "synthetic" });
    const msg: ChatMessage = { id: "synthetic-id", chatJid: "synthetic", sender: "Synthetic", senderJid: "synthetic-sender", timestamp: 1,
      text: '+' + '12 (345) 678-90' + ' @12345678 @opaque@server ' + '12.345.678' + ' +' + '1'.repeat(7),
      attachments: [{ id: "synthetic-file", filename: "private-title.PDF", contentType: "bad/type;private", localPath: "", size: 0 }] };
    assert.equal(writeInboxMessage(msg, dir), true);
    const first = readInboxMessages()[0].message;
    assert.equal(first.text, "[number] [mention] [mention] [number] [number]");
    assert.deepEqual(first.attachments, [{ filename: "file-1.pdf", contentType: "application/octet-stream" }]);
    assert.ok(!fs.readFileSync(readInboxMessages()[0].file, "utf8").includes("private-title"));
    const secret = path.join(dir, "roam-pipe-secret");
    assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(secret).length, 32);
    writeInboxMessage(msg, dir); assert.equal(readInboxMessages()[0].message.id, first.id);
    fs.unlinkSync(readInboxMessages()[0].file);
    writeInboxMessage(msg, path.join(dir, "other")); assert.notEqual(readInboxMessages()[0].message.id, first.id);
  } finally { Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});
