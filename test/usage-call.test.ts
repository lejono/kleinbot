import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("records one private usage line per model call, preserving text and tolerating absent or invalid counters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-call-"));
  try {
    const bin = path.join(dir, "model");
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.readFileSync(0);
fs.writeFileSync(path.join(root, 'args'), JSON.stringify(args));
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], '  answer\\n');
process.stdout.write(fs.readFileSync(path.join(root, 'reply')));
if (fs.existsSync(path.join(root, 'exit'))) process.exit(9);
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callModel } from './src/moltbook/model-call.ts';
import { runtimeDir, dataDir, modelConfig } from './src/config.ts';
const file = path.join(dataDir, 'usage.jsonl');
const reply = value => fs.writeFileSync(path.join(runtimeDir, 'reply'), typeof value === 'string' ? value : JSON.stringify(value));
const rows = () => fs.readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
const opts = {step:'answer', backend:'claude', model:'synthetic-model', tools:'none', prompt:'PRIVATE PROMPT', systemPrompt:'PRIVATE SYSTEM', timeoutMs:2000};
const counts = {input_tokens:11,output_tokens:7,cache_read_input_tokens:5,cache_creation_input_tokens:3};
reply({result:'  answer\\n', usage:counts, total_cost_usd:0.25, session_id:'PRIVATE SESSION'});
assert.equal(await callModel(opts), 'answer');
assert.ok(JSON.parse(fs.readFileSync(path.join(runtimeDir,'args'),'utf8')).includes('--output-format'));
const first = rows()[0];
assert.deepEqual(Object.keys(first).sort(), ['timestamp','step','backend','model','resolvedModel','ok','inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens','costUsd','durationMs'].sort());
assert.deepEqual({...first,timestamp:0,durationMs:0}, {timestamp:0,step:'answer',backend:'claude',model:'synthetic-model',resolvedModel:null,ok:true,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheCreationTokens:3,costUsd:0.25,durationMs:0});
assert.ok(first.timestamp <= Date.now() && first.timestamp > Date.now()-5000);
assert.ok(first.durationMs >= 0);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
for (const usage of [undefined, null, 'bad', {input_tokens:'3',output_tokens:-1,cache_read_input_tokens:1.5,cache_creation_input_tokens:{}}]) {
  reply({result:'answer',usage,total_cost_usd:'bad'});
  assert.equal(await callModel(opts),'answer');
  for (const key of ['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens','costUsd']) assert.equal(rows().at(-1)[key],null);
}
// The answering model is the one with most output; helper calls on other models are ignored.
reply({result:'answer',usage:counts,modelUsage:{'synthetic-helper-1':{outputTokens:2},'synthetic-main-2':{outputTokens:40},'bad name!':{outputTokens:99}}});
assert.equal(await callModel(opts),'answer');
assert.equal(rows().at(-1).resolvedModel,'synthetic-main-2');
reply({result:'failure',is_error:true,usage:counts});
await assert.rejects(callModel(opts));
assert.equal(rows().at(-1).ok,false);
assert.equal(rows().at(-1).inputTokens,11);
fs.writeFileSync(path.join(runtimeDir,'exit'),'');
await assert.rejects(callModel(opts), /code 9/);
assert.equal(rows().at(-1).ok,false);
assert.equal(rows().at(-1).outputTokens,7);
fs.unlinkSync(path.join(runtimeDir,'exit'));
reply('broken envelope');
await assert.rejects(callModel(opts));
assert.equal(rows().at(-1).ok,false);
modelConfig.claudeBin += '-missing';
await assert.rejects(callModel(opts), /failed to start/);
assert.equal(rows().at(-1).ok,false);
modelConfig.claudeBin = modelConfig.codexBin;
reply('noise\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:40,output_tokens:9,cached_input_tokens:12}})+'\\n');
assert.equal(await callModel({...opts, backend:'codex', step:'classify'}),'answer');
assert.ok(JSON.parse(fs.readFileSync(path.join(runtimeDir,'args'),'utf8')).includes('--json'));
assert.deepEqual([rows().at(-1).inputTokens,rows().at(-1).outputTokens,rows().at(-1).cacheReadTokens,rows().at(-1).cacheCreationTokens,rows().at(-1).costUsd],[40,9,12,null,null]);
reply('malformed events');
assert.equal(await callModel({...opts,backend:'codex'}),'answer');
assert.equal(rows().at(-1).inputTokens,null);
assert.equal(rows().length,12);
const slow = path.join(runtimeDir,'slow');
fs.writeFileSync(slow,'#!/bin/sh\\nsleep 2\\n',{mode:0o700});
modelConfig.claudeBin = slow;
await assert.rejects(callModel({...opts,timeoutMs:20}), /timed out/);
assert.equal(rows().at(-1).ok,false);
assert.equal(rows().at(-1).inputTokens,null);
assert.equal(rows().length,13);
modelConfig.claudeBin = modelConfig.codexBin;
assert.doesNotMatch(fs.readFileSync(file,'utf8'), /PRIVATE|failure|session_id/);
const original = fs.readFileSync(file,'utf8');
fs.chmodSync(file,0o666); fs.chmodSync(dataDir,0o777);
reply({result:'answer'});
await callModel(opts);
assert.ok(fs.readFileSync(file,'utf8').startsWith(original));
assert.equal(fs.statSync(file).mode & 0o777,0o600);
assert.equal(fs.statSync(dataDir).mode & 0o777,0o700);
fs.unlinkSync(file); fs.mkdirSync(file);
assert.equal(await callModel(opts),'answer');
`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, CLAUDE_BIN: bin, CODEX_BIN: bin }, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("summarises Claude's own failure reason briefly, without control characters", async () => {
  const { claudeErrorSummary } = await import("../src/usage-log.ts");
  assert.equal(claudeErrorSummary(JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "API Error: output\ntoo long" })),
    "error_during_execution: API Error: output too long");
  assert.equal(claudeErrorSummary(JSON.stringify({ is_error: false, subtype: "success", result: "a normal reply" })), "success");
  assert.equal(claudeErrorSummary(JSON.stringify({ is_error: true, result: "x".repeat(500) })).length, 200);
  assert.equal(claudeErrorSummary(""), "no output");
  assert.equal(claudeErrorSummary("not json"), "unreadable output");
});
