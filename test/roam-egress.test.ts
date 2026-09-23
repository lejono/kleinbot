import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("refuses env secrets in outbox text, platform posts and generated comments", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-test-"));
  const oldRuntime = process.env.KLEINBOT_RUNTIME_DIR;
  process.env.KLEINBOT_RUNTIME_DIR = dir;
  const keys = ["MOLTBOOK_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const previous = keys.map(key => process.env[key]);
  try {
    const { initConfig, modelConfig, roamConfig, promptsDir } = await import("../src/config.js");
    const { writeOutboxMessage } = await import("../src/roam/outbox.js");
    const { runMoltbookCycle } = await import("../src/moltbook/cycle.js");
    const config = initConfig("roam"); config.moltbookApiKey = "synthetic";
    roamConfig.outboxDir = path.join(dir, "outbox");
    for (const key of keys) {
      process.env[key] = 'synthetic-secret-' + key.toLowerCase();
      assert.equal(writeOutboxMessage("research", 'prefix ' + process.env[key] + ' suffix'), "refused");
    }
    assert.equal(writeOutboxMessage("research", "Safe synthetic text"), "published");
    fs.mkdirSync(promptsDir); fs.mkdirSync(path.dirname(config.moltbookStateFile), { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "moltbook.md"), "Synthetic instructions");
    const bin = path.join(dir, "model");
    fs.writeFileSync(bin, `#!${process.execPath}
const input = require('fs').readFileSync(0,'utf8');
const secret = ${JSON.stringify(process.env.OPENAI_API_KEY)};
process.stdout.write(JSON.stringify(input.includes('Write a comment') ? {comment:secret} : {actions:[{type:'post',submolt:'synthetic',title:'Title',content:secret},{type:'post',submolt:'synthetic',title:secret,content:'Safe'},{type:'comment',postId:'synthetic-post'}],crossPollinate:[],notes:''}));
`, { mode: 0o700 });
    modelConfig.claudeBin = bin; modelConfig.moltbookBackend = "claude";
    const post = { id: "synthetic-post", title: "Synthetic", content: "Text", submolt: { name: "synthetic" }, author: null, upvotes: 0, comment_count: 0 };
    const writes: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, opts: RequestInit) => {
      if (opts?.method && opts.method !== "GET") writes.push(opts.body);
      return new Response(JSON.stringify({ posts: [post], post, comments: [] }));
    });
    await runMoltbookCycle(); assert.deepEqual(writes, []);
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    if (oldRuntime === undefined) delete process.env.KLEINBOT_RUNTIME_DIR; else process.env.KLEINBOT_RUNTIME_DIR = oldRuntime;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
