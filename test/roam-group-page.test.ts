import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { researchConfig, roamConfig } from "../src/config.js";
import { appendGroupNotes, readGroupPage } from "../src/roam/group-page.js";

it("appends dated capped notes and reads only complete entries from a bounded tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-page-"));
  const original = { ...researchConfig }, roam = { ...roamConfig };
  try {
    researchConfig.wikiDir = path.join(dir, "wiki"); roamConfig.groupNoteMaxChars = 8;
    appendGroupNotes("ab\x00\ncd\x1befghijk", new Date("2026-01-01T12:00:00Z"));
    const file = path.join(researchConfig.wikiDir, "group.md");
    const first = fs.readFileSync(file, "utf8");
    assert.match(first, /2026-01-01T12:00:00.000Z\] abcdefgh\n$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(researchConfig.wikiDir).mode & 0o777, 0o700);
    appendGroupNotes("é".repeat(20), new Date("2026-01-02T12:00:00Z"));
    const whole = fs.readFileSync(file, "utf8");
    assert.ok(whole.startsWith(first));
    roamConfig.groupPageContextBytes = Buffer.byteLength(whole) - 20;
    const tail = readGroupPage();
    assert.match(tail, /^- \[2026-01-02/);
    assert.doesNotMatch(tail, /2026-01-01|�/);
    assert.ok(Buffer.byteLength(tail) <= roamConfig.groupPageContextBytes);
    roamConfig.groupPageContextBytes = 5;
    assert.equal(readGroupPage(), "");
    assert.equal(fs.readFileSync(file, "utf8"), whole);
  } finally { Object.assign(researchConfig, original); Object.assign(roamConfig, roam); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("retains an entry exactly at the tail boundary and rejects incomplete or invalid date entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-boundary-"));
  const original = { ...researchConfig }, roam = { ...roamConfig };
  try {
    researchConfig.wikiDir = dir;
    const file = path.join(dir, "group.md");
    const first = "- [2026-01-01T12:00:00.000Z] First synthetic entry\n";
    const second = "- [2026-01-02T12:00:00.000Z] Second synthetic entry\n";
    fs.writeFileSync(file, "# Group notes\n" + first + second);
    roamConfig.groupPageContextBytes = Buffer.byteLength(second);
    assert.equal(readGroupPage(), second.trimEnd());
    roamConfig.groupPageContextBytes--;
    assert.equal(readGroupPage(), "");
    roamConfig.groupPageContextBytes = 10000;
    fs.writeFileSync(file, first + "malformed entry\n"
      + "- [2026-02-30T12:00:00.000Z] Invalid calendar date\n"
      + "- [2026-01-02Tgarbage] Invalid time\n"
      + "- [2026-01-02T25:00:00.000Z] Invalid hour\n"
      + second + "- [2026-01-03T12:00:00.000Z] Truncated note");
    assert.equal(readGroupPage(), first.trimEnd() + "\n" + second.trimEnd());
    fs.writeFileSync(file, "- [2026-01-03T12:00:00.000Z] Truncated note");
    assert.equal(readGroupPage(), "");
    fs.writeFileSync(file, "malformed\n- [unfinished\n");
    assert.equal(readGroupPage(), "");
  } finally { Object.assign(researchConfig, original); Object.assign(roamConfig, roam); fs.rmSync(dir, { recursive: true, force: true }); }
});
