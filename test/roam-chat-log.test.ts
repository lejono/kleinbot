import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { researchConfig, roamConfig } from "../src/config.js";
import { appendChat, readRecentChat } from "../src/roam/chat-log.js";

it("appends private bounded chat entries and tolerates malformed tail records", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-log-test-"));
  const original = { ...researchConfig }, settings = { ...roamConfig };
  try {
    researchConfig.dir = dir;
    roamConfig.chatContextMessages = 2;
    assert.deepEqual(readRecentChat(), []);
    appendChat({ timestamp: 1, role: "operator", senderName: "Synthetic Member", text: "Earlier question" });
    const file = path.join(dir, "chat-log.jsonl");
    const first = fs.readFileSync(file, "utf8");
    fs.chmodSync(file, 0o644);
    appendChat({ timestamp: 2, role: "assistant", text: "Earlier answer" });
    assert.ok(fs.readFileSync(file, "utf8").startsWith(first));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.appendFileSync(file, 'invalid JSON\n{"role":"invalid","text":"skip"}\nnull\n');
    appendChat({ timestamp: 3, role: "operator", text: "x".repeat(5000) });
    assert.deepEqual(readRecentChat().map(e => [e.timestamp, e.role, e.text.length]),
      [[2, "assistant", 14], [3, "operator", 4000]]);
    assert.equal(readRecentChat(3)[0].senderName, "Synthetic Member");
    assert.deepEqual(readRecentChat(0), []);
    // Force a tail cut inside a large malformed line; no whole-file read is allowed.
    fs.appendFileSync(file, "x".repeat(300000) + "\n");
    appendChat({ timestamp: 4, role: "assistant", text: "Tail answer" });
    t.mock.method(fs, "readFileSync", () => { throw Error("Whole-file read forbidden"); });
    const read = fs.readSync;
    let bytes = 0;
    t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args); bytes += count; return count;
    });
    assert.deepEqual(readRecentChat(20), [{ timestamp: 4, role: "assistant", text: "Tail answer" }]);
    assert.ok(bytes > 0 && bytes <= 262144);
  } finally {
    t.mock.restoreAll(); Object.assign(researchConfig, original); Object.assign(roamConfig, settings);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
