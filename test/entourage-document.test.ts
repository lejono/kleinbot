import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, MessageAttachment } from "../src/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ent-document-"));
const flagsDir = path.join(tmp, "flags");
const admin = "+15551234567";
const previousFlagsDir = process.env.ENTOURAGE_FLAGS_DIR;
const adminGroup = "test-admin-group";
const previousAdminGroup = process.env.SIGNAL_ADMIN_GROUP_JID;
const previousAdmin = process.env.SIGNAL_ADMIN_NUMBER;
process.env.ENTOURAGE_FLAGS_DIR = flagsDir;
process.env.SIGNAL_ADMIN_NUMBER = admin;
const { isAdminChannel, isVoiceNote, writeVoiceNoteFlag, isDocument, writeDocumentFlag, documentAck, handleDocument } = await import("../src/entourage.js");

beforeEach(() => {
  delete process.env.SIGNAL_ADMIN_GROUP_JID;
  fs.rmSync(flagsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(flagsDir, "incoming"), { recursive: true });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (previousFlagsDir === undefined) delete process.env.ENTOURAGE_FLAGS_DIR;
  else process.env.ENTOURAGE_FLAGS_DIR = previousFlagsDir;
  if (previousAdminGroup === undefined) delete process.env.SIGNAL_ADMIN_GROUP_JID;
  else process.env.SIGNAL_ADMIN_GROUP_JID = previousAdminGroup;
  if (previousAdmin === undefined) delete process.env.SIGNAL_ADMIN_NUMBER;
  else process.env.SIGNAL_ADMIN_NUMBER = previousAdmin;
});

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1", chatJid: admin, timestamp: 1781071204,
    sender: "Test User", senderJid: admin, text: "",
    ...overrides,
  };
}

function att(contentType: string, filename: string | null = null): MessageAttachment {
  const localPath = path.join(tmp, filename || "attachment");
  fs.writeFileSync(localPath, "test data");
  return { id: "a1", contentType, filename, size: 9, localPath };
}

function missingAttachment(): MessageAttachment {
  return {
    id: "missing", contentType: "text/plain", filename: "missing.txt", size: 0,
    localPath: path.join(tmp, "missing.txt"),
  };
}

async function checkFlag(message: ChatMessage, expected: MessageAttachment[]) {
  assert.equal(isDocument(message), true);
  await writeDocumentFlag(message);
  const incoming = path.join(flagsDir, "incoming");
  const files = fs.readdirSync(incoming);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith(".json"));
  const flag = JSON.parse(fs.readFileSync(path.join(incoming, files[0]), "utf8"));
  assert.equal(typeof flag.id, "string");
  assert.equal(typeof flag.timestamp, "number");
  assert.deepEqual(flag, {
    id: flag.id, type: "document", timestamp: flag.timestamp, source: "kleinbot",
    sender: message.sender, senderJid: message.senderJid, chatJid: message.chatJid,
    text: message.text,
    attachments: expected.map((a, index) => ({
      path: path.join(flagsDir, "attachments", `${flag.id}-${index + 1}-${path.basename(a.localPath)}`),
      contentType: a.contentType, filename: a.filename, size: a.size,
    })),
  });
  for (const [index, attachment] of flag.attachments.entries()) {
    assert.deepEqual(fs.readFileSync(attachment.path), fs.readFileSync(expected[index].localPath));
  }
}

describe("document flags", () => {
  it("gives persisted attachments the group of a setgid attachments directory", async t => {
    const shared = process.getgroups?.().find(gid => gid !== process.getgid?.());
    if (process.platform === "win32" || shared === undefined) { t.skip("needs a supplementary group"); return; }
    const attachments = path.join(flagsDir, "attachments");
    fs.mkdirSync(attachments);
    fs.chownSync(attachments, process.getuid!(), shared);
    fs.chmodSync(attachments, 0o2770);
    const image = att("image/jpeg");
    assert.notEqual(fs.statSync(image.localPath).gid, shared);
    await checkFlag(msg({ attachments: [image] }), [image]);
    for (const name of fs.readdirSync(attachments)) {
      assert.equal(fs.statSync(path.join(attachments, name)).gid, shared, `${name} kept the source group`);
    }
  });

  it("flags an admin DM image without a caption and persists its file", async () => {
    const image = att("image/jpeg");
    await checkFlag(msg({ attachments: [image] }), [image]);
  });

  it("flags an admin image in the configured group with the group chatJid", async () => {
    process.env.SIGNAL_ADMIN_GROUP_JID = adminGroup;
    const image = att("image/jpeg");
    await checkFlag(msg({ chatJid: adminGroup, attachments: [image] }), [image]);
  });

  it("limits document groups to the configured group and admin sender", () => {
    process.env.SIGNAL_ADMIN_GROUP_JID = adminGroup;
    const attachments = [att("image/jpeg")];
    assert.equal(isDocument(msg({ chatJid: adminGroup, senderJid: "test-other-user", attachments })), false);
    assert.equal(isDocument(msg({ chatJid: "test-other-group", attachments })), false);
    assert.equal(isDocument(msg({ attachments })), true);
  });

  it("flags a markdown file and preserves its caption and filename", async () => {
    const note = att("text/markdown", "note.md");
    await checkFlag(msg({ text: "File this note.", attachments: [note] }), [note]);
  });

  it("persists separate copies when attachments have the same basename", async () => {
    const attachments = [Buffer.from([0, 1, 2]), Buffer.from([255, 254, 253])].map((bytes, index) => {
      const dir = path.join(tmp, `source-${index}`);
      fs.mkdirSync(dir, { recursive: true });
      const localPath = path.join(dir, "document.bin");
      fs.writeFileSync(localPath, bytes);
      return {
        id: `attachment-${index}`, contentType: "application/octet-stream",
        filename: "document.bin", size: bytes.length, localPath,
      };
    });
    await checkFlag(msg({ attachments }), attachments);
    assert.equal(fs.readdirSync(path.join(flagsDir, "attachments")).length, 2);
  });

  it("rejects a missing source without writing a flag", async () => {
    await assert.rejects(writeDocumentFlag(msg({ attachments: [missingAttachment()] })), { code: "ENOENT" });
    assert.deepEqual(fs.readdirSync(path.join(flagsDir, "incoming")), []);
    assert.deepEqual(fs.readdirSync(path.join(flagsDir, "attachments")), []);
  });

  it("removes the first copy when the second attachment is missing", async () => {
    const first = att("text/plain", "first.txt");
    await assert.rejects(writeDocumentFlag(msg({ attachments: [first, missingAttachment()] })), { code: "ENOENT" });
    assert.deepEqual(fs.readdirSync(path.join(flagsDir, "incoming")), []);
    assert.deepEqual(fs.readdirSync(path.join(flagsDir, "attachments")), []);
    assert.equal(fs.readFileSync(first.localPath, "utf8"), "test data");
  });

  it("does not classify audio-only messages as documents", () => {
    assert.equal(isDocument(msg({ attachments: [att("audio/aac")] })), false);
  });

  it("includes only the image when audio and an image arrive together", async () => {
    const audio = att("audio/aac", "voice.aac");
    const image = att("image/jpeg", "photo.jpg");
    await checkFlag(msg({ attachments: [audio, image] }), [image]);
  });

  it("rejects images in group chats even from the admin", () => {
    assert.equal(isDocument(msg({ chatJid: "test-group", attachments: [att("image/jpeg")] })), false);
  });

  it("rejects images from non-admin senders", () => {
    const attachments = [att("image/jpeg")];
    assert.equal(isDocument(msg({ senderJid: "+15557654321", attachments })), false);
    assert.equal(isDocument(msg({ senderJid: "+15557654321", chatJid: "+15557654321", attachments })), false);
  });

  it("rejects messages without attachments", () => {
    assert.equal(isDocument(msg()), false);
    assert.equal(isDocument(msg({ attachments: [] })), false);
  });
});

describe("admin channels and voice notes", () => {
  for (const configured of [false, true]) {
    for (const chatJid of [admin, adminGroup, "test-other-group"]) {
      it(`preserves voice-note behavior in ${chatJid === admin ? "DM" : chatJid} with group configured=${configured}`, async () => {
        if (configured) process.env.SIGNAL_ADMIN_GROUP_JID = adminGroup;
        const message = msg({ chatJid, attachments: [att("audio/aac")] });
        assert.equal(isAdminChannel(message), chatJid === admin || (configured && chatJid === adminGroup));
        assert.equal(isVoiceNote(message), true);
        assert.equal(isVoiceNote({ ...message, senderJid: "test-other-user" }), false);
        assert.equal(isAdminChannel({ ...message, senderJid: "test-other-user" }), false);
        if (!configured && chatJid !== admin) {
          assert.equal(isDocument({ ...message, attachments: [att("image/jpeg")] }), false);
        }
        await writeVoiceNoteFlag(message);
        const incoming = path.join(flagsDir, "incoming");
        const [file] = fs.readdirSync(incoming);
        const flag = JSON.parse(fs.readFileSync(path.join(incoming, file), "utf8"));
        assert.equal(flag.type, "voicenote");
        assert.equal(flag.chatJid, chatJid);
      });
    }
  }

  it("requires audio attachments", () => {
    process.env.SIGNAL_ADMIN_GROUP_JID = adminGroup;
    for (const chatJid of [admin, adminGroup]) {
      assert.equal(isVoiceNote(msg({ chatJid })), false);
      assert.equal(isVoiceNote(msg({ chatJid, attachments: [] })), false);
      assert.equal(isVoiceNote(msg({ chatJid, attachments: [att("image/jpeg")] })), false);
    }
  });
});

describe("document handling", () => {
  it("acknowledges a document in the configured admin group", async () => {
    process.env.SIGNAL_ADMIN_GROUP_JID = adminGroup;
    const message = msg({ chatJid: adminGroup, attachments: [att("image/jpeg", "photo.jpg")] });
    const calls: { chatJid: string; text: string }[] = [];
    await handleDocument(message, async (chatJid, text) => { calls.push({ chatJid, text }); });
    assert.deepEqual(calls, [{ chatJid: adminGroup, text: "Got photo.jpg, filing it." }]);
  });

  it("sends one acknowledgement after writing the flag", async () => {
    const message = msg({ attachments: [att("text/plain", "note.txt")] });
    const calls: { chatJid: string; text: string }[] = [];
    await handleDocument(message, async (chatJid, text) => {
      assert.equal(fs.readdirSync(path.join(flagsDir, "incoming")).length, 1);
      calls.push({ chatJid, text });
    });
    assert.deepEqual(calls, [{ chatJid: message.chatJid, text: "Got note.txt, filing it." }]);
  });

  it("sends one failure notice when the source is missing", async (t) => {
    t.mock.method(console, "error", () => {});
    const message = msg({ attachments: [missingAttachment()] });
    const calls: { chatJid: string; text: string }[] = [];
    await handleDocument(message, async (chatJid, text) => { calls.push({ chatJid, text }); });
    assert.deepEqual(calls, [{
      chatJid: message.chatJid, text: "Got your file but could not file it; please resend.",
    }]);
    assert.deepEqual(fs.readdirSync(path.join(flagsDir, "incoming")), []);
  });

  it("does not retry or throw when the acknowledgement send fails", async (t) => {
    t.mock.method(console, "error", () => {});
    const message = msg({ attachments: [att("text/plain", "note.txt")] });
    const calls: { chatJid: string; text: string }[] = [];
    await assert.doesNotReject(handleDocument(message, async (chatJid, text) => {
      calls.push({ chatJid, text });
      throw new Error("Send failed");
    }));
    assert.deepEqual(calls, [{ chatJid: message.chatJid, text: "Got note.txt, filing it." }]);
    assert.equal(fs.readdirSync(path.join(flagsDir, "incoming")).length, 1);
    assert.equal(fs.readdirSync(path.join(flagsDir, "attachments")).length, 1);
  });

  it("does not retry or throw when the failure notice send fails", async (t) => {
    t.mock.method(console, "error", () => {});
    const calls: string[] = [];
    await assert.doesNotReject(handleDocument(msg({ attachments: [missingAttachment()] }), async (_chatJid, text) => {
      calls.push(text);
      throw new Error("Send failed");
    }));
    assert.deepEqual(calls, ["Got your file but could not file it; please resend."]);
    assert.deepEqual(fs.readdirSync(path.join(flagsDir, "incoming")), []);
  });
});

describe("document acknowledgements", () => {
  function attachment(contentType: string, filename: string | null): MessageAttachment {
    return { id: "attachment", contentType, filename, size: 0, localPath: "unused" };
  }

  it("uses the sanitised filename for a single document and ignores audio", () => {
    assert.equal(documentAck(msg({ attachments: [
      attachment("audio/aac", "voice.aac"),
      attachment("text/markdown", "no\n\r\t\x00\x1b\x7f\x85\u2028\u2029te.md"),
    ] })), "Got note.md, filing it.");
  });

  it("caps the filename at 80 characters", () => {
    assert.equal(documentAck(msg({ attachments: [attachment("text/plain", "x".repeat(100))] })),
      `Got ${"x".repeat(80)}, filing it.`);
  });

  for (const [label, filename] of [
    ["null", null], ["empty", ""], ["all-control-character", "\n\r\t\x00\x1b\x7f\x85\u2028\u2029"],
  ] as const) {
    for (const [contentType, name] of [
      ["image/jpeg", "an image"], ["application/pdf", "a PDF"], ["text/plain", "a file"],
    ]) {
      it(`uses ${name} for a ${label} filename`, () => {
        assert.equal(documentAck(msg({ attachments: [attachment(contentType, filename)] })),
          `Got ${name}, filing it.`);
      });
    }
  }

  it("counts only documents when acknowledging two files", () => {
    assert.equal(documentAck(msg({ attachments: [
      attachment("image/jpeg", "photo.jpg"),
      attachment("audio/aac", "voice.aac"),
      attachment("application/pdf", "document.pdf"),
    ] })), "Got 2 files, filing them.");
  });
});
