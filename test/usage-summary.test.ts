import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("summarises usage by model over 24 hours and seven days from a bounded complete tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-summary-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, usageSummaryMaxBytes } from './src/config.ts';
import { usageSummary } from './src/usage-log.ts';
assert.equal(usageSummaryMaxBytes,4096);
assert.match(usageSummary(), /Usage \\(last 24h\\): none/);
fs.mkdirSync(dataDir,{recursive:true});
const file = path.join(dataDir,'usage.jsonl');
const now = Date.now(), day = 86400000;
const row = (timestamp, model='opus', extra={}) => JSON.stringify({timestamp,backend:'claude',model,ok:true,inputTokens:10,outputTokens:4,cacheReadTokens:3,cacheCreationTokens:2,...extra})+'\\n';
fs.writeFileSync(file, row(now)+row(now-day,'opus',{ok:false})+row(now-7*day)+row(now-7*day-1)+row(now+1)+row(now,'sonnet')+row(now,'synthetic',{backend:'codex',inputTokens:null,cacheReadTokens:null,cacheCreationTokens:null})+'bad\\nnull\\n'+row('invalid')+row(now,'bad',{backend:'invalid'})+row(now,'unfinished').trimEnd());
let text = usageSummary(now);
assert.match(text,/Usage \\(last 24h\\):\\n  claude\\/opus: 2 calls; input 20; output 8; cache read 6; cache creation 4/);
assert.match(text,/Usage \\(last 7d\\):\\n  claude\\/opus: 3 calls; input 30; output 12; cache read 9; cache creation 6/);
assert.match(text,/claude\\/sonnet: 1 calls; input 10/);
assert.match(text,/codex\\/synthetic: 1 calls; input unknown; output 4; cache read unknown; cache creation unknown/);
assert.doesNotMatch(text,/unfinished|invalid|claude\\/bad/);
// A recorded answering model is shown instead of the configured alias.
fs.appendFileSync(file,'\\n'+row(now,'opus',{resolvedModel:'synthetic-opus-9'}));
assert.match(usageSummary(now),/claude\\/synthetic-opus-9: 1 calls/);
fs.appendFileSync(file,'\\n'+row(now,'opus',{inputTokens:null}));
assert.match(usageSummary(now),/input 20 \\(partial\\)/);
// A large log must never be read in full, and partial boundary lines are discarded.
fs.writeFileSync(file, row(now,'outside')+'x'.repeat(8192)+'\\n'+row(now,'inside')+row(now,'unfinished').trimEnd());
const read = fs.readSync;
let bytesRead = 0;
fs.readSync = (...args) => { const n=read(...args); bytesRead+=n; return n; };
text = usageSummary(now);
fs.readSync = read;
assert.ok(bytesRead<=4096);
assert.match(text,/claude\\/inside: 1 calls/);
assert.doesNotMatch(text,/outside|unfinished/);
assert.match(text,/partial.*tail/i);
fs.unlinkSync(file); fs.mkdirSync(file);
assert.match(usageSummary(now), /unavailable/);
`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, USAGE_SUMMARY_MAX_BYTES: "4096" }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("defaults the usage tail limit to 4 MiB for missing or invalid configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-config-"));
  try {
    for (const value of ["", "0", "-1", "1.5", "bad"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
        `import assert from 'node:assert/strict'; import { usageSummaryMaxBytes } from './src/config.ts'; assert.equal(usageSummaryMaxBytes,4194304);`],
      { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, USAGE_SUMMARY_MAX_BYTES: value }, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
