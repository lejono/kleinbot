import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MoltbookPost } from "../src/moltbook/types.js";

it("captures the complete briefing feed before filtering and tolerates capture failures", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-capture-"));
  const originalRuntime = process.env.KLEINBOT_RUNTIME_DIR;
  process.env.KLEINBOT_RUNTIME_DIR = dir;
  t.after(() => {
    if (originalRuntime === undefined) delete process.env.KLEINBOT_RUNTIME_DIR;
    else process.env.KLEINBOT_RUNTIME_DIR = originalRuntime;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { initConfig, modelConfig, researchConfig, promptsDir } = await import("../src/config.js");
  const { runMorningBriefing, runMoltbookCycle } = await import("../src/moltbook/cycle.js");
  const { loadMoltbookState, saveMoltbookState } = await import("../src/moltbook/state.js");
  const config = initConfig("roam");
  config.moltbookApiKey = "synthetic-key";
  fs.mkdirSync(path.dirname(config.moltbookStateFile), { recursive: true });
  fs.mkdirSync(promptsDir);
  fs.writeFileSync(path.join(promptsDir, "briefing.md"), "Synthetic briefing instructions.");
  fs.writeFileSync(path.join(promptsDir, "moltbook.md"), "Synthetic cycle instructions.");
  const bin = path.join(dir, "model");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf 'call\\n' >> '${dir}/calls'\ncat > '${dir}/stdin'\nprintf '{"message":"Synthetic briefing"}'\n`, { mode: 0o700 });
  Object.assign(modelConfig, { claudeBin: bin, briefingBackend: "claude", moltbookBackend: "claude" });
  Object.assign(researchConfig, { capture: true, maxCommentFetch: 1 });
  const post = (id: string): MoltbookPost => ({ id, title: "Synthetic title", content: "x".repeat(800),
    created_at: "2026-01-01", author: null, submolt: { id: "test", name: "test", display_name: "Test" },
    upvotes: 0, downvotes: 0, comment_count: 1 });
  let posts = [post("already-seen"), post("briefing-only")];
  const state = loadMoltbookState();
  state.seenPostIds = ["already-seen"];
  saveMoltbookState(state);
  const commentRequests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.includes("/posts/") && !endpoint.search) {
      commentRequests.push(endpoint.pathname);
      return new Response(JSON.stringify({ comments: [] }));
    }
    return new Response(JSON.stringify({ posts }));
  });
  const records = () => fs.readdirSync(researchConfig.dir).filter(f => f.endsWith(".jsonl"))
    .flatMap(f => fs.readFileSync(path.join(researchConfig.dir, f), "utf8").trim().split("\n").map(line => JSON.parse(line)));

  assert.equal(await runMorningBriefing(), "Synthetic briefing");
  assert.ok(fs.existsSync(researchConfig.dir), "briefing must create the corpus");
  assert.deepEqual(records().filter(r => r.type === "post").map(r => r.id), ["already-seen", "briefing-only"]);
  assert.ok(records().filter(r => r.type === "post").every(r => r.content.length === 800));
  assert.equal(commentRequests.length, 1);
  assert.match(fs.readFileSync(path.join(dir, "stdin"), "utf8"), /briefing-only/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "stdin"), "utf8"), /already-seen/);
  assert.ok(loadMoltbookState().seenPostIds.includes("briefing-only"));
  await runMorningBriefing();
  assert.equal(records().filter(r => r.type === "post").length, 2);
  assert.equal(commentRequests.length, 1);

  // Later cycles still capture seen posts that reappear, even if an earlier capture was missed.
  researchConfig.capture = false;
  posts = [post("later-cycle")];
  await runMorningBriefing();
  assert.equal(records().filter(r => r.type === "post").length, 2);
  researchConfig.capture = true;
  const calls = fs.readFileSync(path.join(dir, "calls"), "utf8");
  await runMoltbookCycle();
  assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), calls);
  const activityFile = fs.readdirSync(researchConfig.wikiDir).find(f => /^log-/.test(f))!;
  const activity = fs.readFileSync(path.join(researchConfig.wikiDir, activityFile), "utf8");
  assert.match(activity, /cycle · fetched=1 captured=1 commentTrees=1 paused=false/);
  assert.doesNotMatch(activity, /Synthetic title|xxxxxxxx/);
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes("log-")) throw Error("Synthetic log failure");
    return open(...args);
  });
  await runMoltbookCycle();
  assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), calls);
  assert.deepEqual(records().filter(r => r.type === "post").map(r => r.id), ["already-seen", "briefing-only", "later-cycle"]);

  researchConfig.dir = path.join(dir, "unwritable-corpus");
  fs.writeFileSync(researchConfig.dir, "Synthetic obstruction");
  posts = [post("capture-failure")];
  const log = t.mock.method(console, "error", () => {});
  assert.equal(await runMorningBriefing(), "Synthetic briefing");
  assert.ok(log.mock.calls.some(call => call.arguments[0] === "[research] Post capture failed"));
  assert.match(fs.readFileSync(path.join(dir, "stdin"), "utf8"), /capture-failure/);
  assert.ok(loadMoltbookState().seenPostIds.includes("capture-failure"));
});
