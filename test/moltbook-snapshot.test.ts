import assert from "node:assert/strict";
import { after, beforeEach, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
process.env.KLEINBOT_RUNTIME_DIR = dir;
const { initConfig, researchConfig, roamConfig } = await import("../src/config.js");
initConfig("roam");
const { loadMoltbookState } = await import("../src/moltbook/state.js");
const { capturePresence, presenceSummary } = await import("../src/moltbook/presence.js");
const { answerInbox } = await import("../src/roam/answer.js");
const profile: any = { agent: { karma: 20, follower_count: 4, following_count: 3, posts_count: 6, comments_count: 10 } };
beforeEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "data"), { recursive: true }); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));
it("appends one private snapshot per UK day and computes a seven-day delta", () => {
  const state = loadMoltbookState();
  capturePresence(state, profile, new Date("2026-07-01T23:30:00Z"));
  capturePresence(state, profile, new Date("2026-07-02T12:00:00Z"));
  const file = path.join(researchConfig.dir, "presence.jsonl");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { date: "2026-07-02", karma: 20, followers: 4, following: 3, posts: 6, comments: 10 });
  capturePresence(state, { ...profile, agent: { ...profile.agent, karma: 23, comments_count: 12 } }, new Date("2026-07-09T12:00:00Z"));
  assert.match(presenceSummary(), /karma 23 \(\+3\).*followers 4 \(\+0\).*posts 6 \(\+0\).*comments 12 \(\+2\).*7d/);
});
it("contains failures, marks the daily attempt, and reports missing baseline honestly", () => {
  const state = loadMoltbookState();
  capturePresence(state, null, new Date("2026-07-02T12:00:00Z"));
  assert.equal(state.presenceAttemptDate, "2026-07-02");
  assert.match(presenceSummary(), /unavailable/);
  capturePresence(state, profile, new Date("2026-07-03T12:00:00Z"));
  assert.match(presenceSummary(), /7d change unavailable/);
  fs.rmSync(researchConfig.dir, { recursive: true }); fs.writeFileSync(researchConfig.dir, "blocked");
  assert.doesNotThrow(() => capturePresence(state, profile, new Date("2026-07-04T12:00:00Z")));
});
it("includes presence in the code-only status reply", async () => {
  capturePresence(loadMoltbookState(), profile);
  roamConfig.inboxDir = path.join(dir, "inbox"); roamConfig.outboxDir = path.join(dir, "outbox");
  fs.mkdirSync(roamConfig.inboxDir, { recursive: true });
  fs.writeFileSync(path.join(roamConfig.inboxDir, "status.json"), JSON.stringify({ id: "synthetic-status", timestamp: Date.now()/1000,
    senderName: "Synthetic Operator", text: "/status", attachments: [] }));
  await answerInbox();
  const channel = path.join(roamConfig.outboxDir, "research");
  const reply = JSON.parse(fs.readFileSync(path.join(channel, fs.readdirSync(channel)[0]), "utf8")).text;
  assert.match(reply, /Presence: karma 20.*followers 4.*posts 6.*comments 10/);
});
