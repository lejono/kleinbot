import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("documents a usage record matching the writer and the default summary byte limit", () => {
  const docs = fs.readFileSync("CLAUDE.md", "utf8");
  const section = docs.split("## Model usage\n")[1]?.split("\n## ")[0];
  assert.ok(section, "usage storage and privacy contract must be documented");
  const example = JSON.parse(section.match(/```json\n([^`]+)\n```/)![1]);
  const limit = Number(fs.readFileSync(".env.example", "utf8").match(/^# USAGE_SUMMARY_MAX_BYTES=(\d+)$/m)?.[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-docs-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, usageSummaryMaxBytes } from './src/config.ts';
import { recordUsage } from './src/usage-log.ts';
const example = ${JSON.stringify(example)};
recordUsage(example);
const actual = JSON.parse(fs.readFileSync(path.join(dataDir,'usage.jsonl'),'utf8'));
assert.deepEqual({...actual,timestamp:example.timestamp},example);
assert.equal(usageSummaryMaxBytes,${limit});
`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, USAGE_SUMMARY_MAX_BYTES: "" }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.match(section, /never contains prompt text, reply text, chat IDs or names/);
  assert.match(section, /0600/);
  assert.match(section, /0700/);
  assert.match(section, /never pruned/);
  assert.match(section, /24 hours/);
  assert.match(section, /7 days/);
});
