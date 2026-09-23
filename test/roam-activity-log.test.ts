import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { researchConfig, roamConfig, initConfig } from "../src/config.js";
import { logActivity } from "../src/roam/activity-log.js";
import { answerInbox } from "../src/roam/answer.js";

it("appends private UK-month logs, caps excerpts and ignores unknown prose", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-test-"));
  const original = { ...researchConfig }, roam = { ...roamConfig };
  try {
    researchConfig.wikiDir = path.join(dir, "wiki"); roamConfig.logExcerptChars = 6;
    logActivity("inbox", { sender: "Member", text: "ab\x00\ncd\x1befghij", status: "answered" }, new Date("2026-03-31T22:59:00Z"));
    logActivity("cycle", { fetched: 2, captured: 1, commentTrees: 1, paused: true, text: "HOSTILE FEED" } as any, new Date("2026-03-31T23:01:00Z"));
    const march = fs.readFileSync(path.join(researchConfig.wikiDir, "log-2026-03.md"), "utf8");
    const april = fs.readFileSync(path.join(researchConfig.wikiDir, "log-2026-04.md"), "utf8");
    assert.match(march, /- 2026-03-31 23:59 UK · inbox ·.*abcdef/);
    assert.doesNotMatch(march, /ghij|\x00|\x1b/);
    assert.match(april, /- 2026-04-01 00:01 UK · cycle · fetched=2 captured=1 commentTrees=1 paused=true/);
    assert.doesNotMatch(april, /HOSTILE FEED/);
    logActivity("briefing", { status: "failed" }, new Date("2026-04-01T00:00:00Z"));
    assert.ok(fs.readFileSync(path.join(researchConfig.wikiDir, "log-2026-04.md"), "utf8").startsWith(april));
    assert.equal(fs.statSync(researchConfig.wikiDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(researchConfig.wikiDir, "log-2026-04.md")).mode & 0o777, 0o600);
  } finally { Object.assign(researchConfig, original); Object.assign(roamConfig, roam); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("a throwing log filesystem does not break inbox handling", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-failure-"));
  const original = { ...researchConfig }, roam = { ...roamConfig };
  const open = fs.openSync;
  let interceptedOpens = 0;
  try {
    initConfig("roam");
    Object.assign(researchConfig, { dir: path.join(dir, "research"), wikiDir: path.join(dir, "wiki") });
    Object.assign(roamConfig, { inboxDir: path.join(dir, "inbox"), outboxDir: path.join(dir, "outbox") });
    fs.mkdirSync(roamConfig.inboxDir);
    fs.writeFileSync(path.join(roamConfig.inboxDir, "synthetic.json"), JSON.stringify({ id: "synthetic", timestamp: Math.floor(Date.now()/1000), senderName: "Member", text: "/pause", attachments: [] }));
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (/log-\d{4}-\d{2}\.md$/.test(String(args[0]))) { interceptedOpens++; throw Error("Synthetic failure"); }
      return open(...args);
    });
    await answerInbox();
    assert.ok(interceptedOpens >= 1, "the logging failure must actually be injected");
    assert.equal(fs.readdirSync(roamConfig.inboxDir).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(researchConfig.dir, "control.json"), "utf8")).paused, true);
  } finally { t.mock.restoreAll(); Object.assign(researchConfig, original); Object.assign(roamConfig, roam); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("logs action facts without bot prose and withholds secret-bearing operator excerpts before capping", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-facts-"));
  const original = { ...researchConfig }, roam = { ...roamConfig };
  const secretBefore = process.env.OPENAI_API_KEY;
  try {
    researchConfig.wikiDir = dir; roamConfig.logExcerptChars = 8;
    process.env.OPENAI_API_KEY = "synthetic-log-secret";
    const now = new Date("2026-01-01T00:00:00Z");
    logActivity("action", { type: "comment", postId: "synthetic-post", textChars: 21, ownText: "BOTQUOTE hostile text" } as any, now);
    logActivity("inbox", { sender: "Member", text: "ordinary prefix " + process.env.OPENAI_API_KEY, status: "answered" }, now);
    const log = fs.readFileSync(path.join(dir, "log-2026-01.md"), "utf8");
    assert.doesNotMatch(log, /BOTQUOTE|hostile|synthetic-log-secret|ordinary/);
    assert.match(log, /comment https:\/\/www\.moltbook\.com\/post\/synthetic-post textChars=21/);
    assert.match(log, /text="\[excerpt withheld\]"/);
  } finally {
    if (secretBefore === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = secretBefore;
    Object.assign(researchConfig, original); Object.assign(roamConfig, roam); fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, separator] of [["newline", "\n"], ["spaces", "  "], ["tab", "\t"]]) {
  it(`withholds operator excerpts containing a secret split by ${label}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-split-"));
    const original = { ...researchConfig }, roam = { ...roamConfig };
    const previous = process.env.OPENAI_API_KEY;
    try {
      researchConfig.wikiDir = dir; roamConfig.logExcerptChars = 120;
      process.env.OPENAI_API_KEY = "synthetic-excerpt-secret";
      const split = "synthetic-" + separator + "excerpt-secret";
      const now = new Date("2026-01-01T00:00:00Z");
      logActivity("inbox", { sender: "Member", text: "Operator text " + split, status: "answered" }, now);
      logActivity("inbox", { sender: "Member", text: "Ordinary operator text", status: "answered" }, now);
      const lines = fs.readFileSync(path.join(dir, "log-2026-01.md"), "utf8").trim().split("\n");
      assert.match(lines[1], /text="\[excerpt withheld\]"/);
      assert.doesNotMatch(lines[1], /synthetic-|excerpt-secret/);
      assert.match(lines[2], /text="Ordinary operator text"/);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
      Object.assign(researchConfig, original); Object.assign(roamConfig, roam); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
