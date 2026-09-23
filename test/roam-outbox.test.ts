import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { roamConfig, researchConfig } from "../src/config.js";
import { writeOutboxMessage } from "../src/roam/outbox.js";
import { claimResearchRun } from "../src/roam/schedule.js";
import { validateFlag, resolveAttachment } from "../src/entourage-watcher.js";

it("makes shared channels and files group readable despite a restrictive umask", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-modes-"));
  const original = { ...roamConfig };
  const umask = process.umask(0o077);
  try {
    const md = path.join(dir, "summary.md");
    fs.writeFileSync(md, "Synthetic summary");
    for (const groupReadable of [false, true]) {
      Object.assign(roamConfig, { outboxDir: path.join(dir, String(groupReadable)), groupReadable });
      for (const channel of ["briefing", "research"] as const) {
        assert.equal(writeOutboxMessage(channel, "Synthetic message", md), "published");
        const folder = path.join(roamConfig.outboxDir, channel);
        assert.equal(fs.statSync(folder).mode & 0o777, groupReadable ? 0o770 : 0o700);
        const files = fs.readdirSync(folder);
        assert.deepEqual(files.map(f => path.extname(f)).sort(), [".json", ".md"]);
        for (const file of files) {
          assert.equal(fs.statSync(path.join(folder, file)).mode & 0o777, groupReadable ? 0o640 : 0o600);
        }
      }
    }
  } finally {
    process.umask(umask);
    Object.assign(roamConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("writes atomic recipient-free flags and copies only bounded regular markdown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-test-"));
  const original = { ...roamConfig };
  try {
    roamConfig.outboxDir = path.join(dir, "outbox");
    const md = path.join(dir, "summary.md");
    fs.writeFileSync(md, "Summary");
    assert.equal(writeOutboxMessage("research", "x".repeat(5000), md), "published");
    const folder = path.join(roamConfig.outboxDir, "research");
    const files = fs.readdirSync(folder);
    assert.equal(files.length, 2);
    assert.equal(files.some(f => f.endsWith(".tmp")), false);
    const raw = fs.readFileSync(path.join(folder, files.find(f => f.endsWith(".json"))!), "utf8");
    const flag = JSON.parse(raw);
    assert.deepEqual(Object.keys(flag).sort(), ["attachmentPath", "id", "text", "timestamp", "type"]);
    assert.equal(flag.text.length, 4000);
    assert.ok(flag.text.endsWith("[truncated]"));
    // The existing receiver requires its own pinned target before validation.
    assert.equal(validateFlag(raw, Date.now(), new Set()).ok, false);
    assert.equal(validateFlag(JSON.stringify({ ...flag, targetChatJid: "synthetic-recipient" }), Date.now(), new Set()).ok, true);
    assert.equal(path.dirname(flag.attachmentPath), folder);
    fs.unlinkSync(md);
    const attachment = resolveAttachment(flag.attachmentPath, { allowRoots: [folder], maxBytes: roamConfig.maxMdBytes });
    assert.equal(attachment.ok, true);
    if (attachment.ok) assert.equal(attachment.buffer.toString(), "Summary");
    fs.symlinkSync(flag.attachmentPath, md);
    assert.equal(writeOutboxMessage("research", "Test", md), "failed");
    const txt = path.join(dir, "test.txt");
    fs.writeFileSync(txt, "Test");
    assert.equal(writeOutboxMessage("research", "Test", txt), "failed");
    fs.unlinkSync(md);
    fs.writeFileSync(md, "x".repeat(roamConfig.maxMdBytes + 1));
    assert.equal(writeOutboxMessage("research", "Test", md), "failed");
    assert.deepEqual(fs.readdirSync(folder), files);
    assert.equal(writeOutboxMessage("briefing", '"'.repeat(9000)), "published");
    roamConfig.outboxDir = "";
    assert.equal(writeOutboxMessage("briefing", "Test"), "failed");
  } finally {
    Object.assign(roamConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("claims research once per UK day, including summer time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-test-"));
  const original = { ...researchConfig };
  Object.assign(researchConfig, { dir, hourUK: 3 });
  try {
    assert.equal(claimResearchRun(new Date("2026-07-01T01:59:00Z")), false);
    assert.equal(claimResearchRun(new Date("2026-07-01T02:00:00Z")), true);
    assert.equal(claimResearchRun(new Date("2026-07-01T20:00:00Z")), false);
    assert.equal(claimResearchRun(new Date("2026-07-02T02:00:00Z")), true);
  } finally {
    Object.assign(researchConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("roam imports no transport or chat state and refuses an empty key", () => {
  const source = fs.readFileSync(new URL("../src/index-roam.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from|import\()[^\n]*(?:whatsapp|signal|daemon|discord|slack|transport|\.\/state\.js)/);
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index-roam.ts"], {
    env: { ...process.env, MOLTBOOK_API_KEY: "" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 78, result.error?.message || result.stderr);
  assert.match(result.stderr, /MOLTBOOK_API_KEY is required/);
});

it("replaces research run state atomically and recovers malformed JSON", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-atomic-"));
  const original = { ...researchConfig }; const rename = fs.renameSync;
  try {
    Object.assign(researchConfig, { dir, hourUK: 0 });
    const file = path.join(dir, "run-state.json"); fs.writeFileSync(file, "{");
    let replaced = false;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      assert.equal(fs.readFileSync(file, "utf8"), "{"); assert.equal(String(to), file);
      assert.ok(String(from).endsWith(".tmp")); replaced = true; rename(from, to);
    });
    assert.equal(claimResearchRun(new Date("2026-01-01T12:00:00Z")), true);
    assert.equal(replaced, true); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["run-state.json"]);
    const source = fs.readFileSync(new URL("../src/index-roam.ts", import.meta.url), "utf8");
    assert.match(source, /if \(!canWriteOutbox\("briefing"\)\) return;[\s\S]*?await runMorningBriefing\(\)/);
  } finally { t.mock.restoreAll(); Object.assign(researchConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});
