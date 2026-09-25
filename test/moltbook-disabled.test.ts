import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import { initConfig, config } from "../src/config.js";
import { isMoltbookEnabled } from "../src/moltbook/enabled.js";
import { handleMoltbookAction } from "../src/moltbook/transport-bridge.js";

it("does not schedule briefings or dispatch model actions without a key", async (t) => {
  initConfig("signal");
  config.moltbookApiKey = "";
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network call"); });
  const sent: string[] = [];
  const enabled = isMoltbookEnabled(config.moltbookApiKey);
  assert.equal(enabled, false);
  if (enabled) {
    const result = await handleMoltbookAction({ type: "post", title: "Test", content: "Synthetic post" });
    if (result) sent.push(result);
  }
  await handleMoltbookAction({ type: "hot" });
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(sent, []);
  const daemon = fs.readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  assert.match(daemon, /if \(isMoltbookEnabled\(config.moltbookApiKey, enableMoltbook\) && decision.moltbookAction\)/);
  assert.match(daemon, /const moltbookEnabled = isMoltbookEnabled\(config.moltbookApiKey, enableMoltbook\)/);
  assert.match(daemon, /if \(enableBriefing && moltbookEnabled\) \{[\s\S]*setInterval\(checkMorningBriefing/);
  assert.equal(isMoltbookEnabled("synthetic-key"), true);
  assert.equal(isMoltbookEnabled("synthetic-key", false), false);
});

it("omits Moltbook instructions from the actual chat model prompt without a key", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-gate-"));
  try {
    const bin = path.join(dir, "model");
    fs.writeFileSync(bin, `#!${process.execPath}
const fs=require('fs'); fs.readFileSync(0,'utf8');
fs.writeFileSync(${JSON.stringify(path.join(dir, "args"))},JSON.stringify(process.argv));
process.stdout.write(JSON.stringify({result:'{"shouldRespond":false}'}));
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
      import { initConfig, runtimeDir } from './src/config.ts'; import { askClaude } from './src/ai.ts';
      const config=initConfig('signal'); fs.writeFileSync(path.join(runtimeDir,'prompt.md'),'Synthetic instructions');
      for (const key of ['', 'synthetic-key']) {
        config.moltbookApiKey=key;
        await askClaude([],[],{prompt:'prompt.md',model:'synthetic',moltbook:true},'synthetic-chat');
        const args=JSON.parse(fs.readFileSync(path.join(runtimeDir,'args'),'utf8'));
        assert.equal(args[args.indexOf('--system-prompt')+1].includes('## Moltbook integration'),!!key);
      }
    `], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, CLAUDE_BIN: bin }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
