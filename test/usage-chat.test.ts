import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("extracts chat result JSON, preserves flags and records prompt basenames without chat identifiers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-chat-"));
  try {
    const bin = path.join(dir, "model");
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(process.argv[1]);
fs.readFileSync(0);
fs.writeFileSync(path.join(root,'args'),JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(path.join(root,'reply')));
if (fs.existsSync(path.join(root,'exit'))) process.exit(9);
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './src/ai.ts';
import { initConfig, runtimeDir, dataDir, promptsDir } from './src/config.ts';
initConfig('signal');
fs.mkdirSync(promptsDir,{recursive:true});
fs.writeFileSync(path.join(promptsDir,'default.md'),'Synthetic prompt.');
const cfg = {prompt:'prompts/default.md',model:'synthetic-chat-model'};
const chat = 'synthetic-chat-id';
const rows = () => fs.readFileSync(path.join(dataDir,'usage.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
const response = {shouldRespond:true,response:'Synthetic reply',notes:'Synthetic note',poll:{question:'Synthetic?',options:['A','B']},calendarEvent:null,sheetActions:[{op:'list',list:'synthetic'}]};
const reply = value => fs.writeFileSync(path.join(runtimeDir,'reply'), JSON.stringify(value));
const envelope = {result:'Text before\\n'+JSON.stringify(response)+'\\nText after',usage:{input_tokens:20,output_tokens:8,cache_read_input_tokens:6,cache_creation_input_tokens:4},total_cost_usd:0.5};
reply(envelope);
assert.deepEqual(await askClaude([],[],cfg,chat),response);
const args = JSON.parse(fs.readFileSync(path.join(runtimeDir,'args'),'utf8'));
assert.deepEqual(args,['--print','--output-format','json','--model',cfg.model,'--no-session-persistence','--system-prompt',args[7],'--allowedTools','WebSearch,WebFetch']);
let entry = rows().at(-1);
assert.deepEqual([entry.step,entry.backend,entry.model,entry.ok,entry.inputTokens,entry.outputTokens,entry.cacheReadTokens,entry.cacheCreationTokens,entry.costUsd],['default','claude',cfg.model,true,20,8,6,4,0.5]);
reply({result:'{"shouldRespond":false}',usage:'bad'});
assert.deepEqual(await askClaude([],[],cfg,chat),{shouldRespond:false});
assert.equal(rows().at(-1).inputTokens,null);
assert.equal(rows().at(-1).ok,true);
for (const result of ['no JSON','{invalid}']) {
  reply({result});
  assert.deepEqual(await askClaude([],[],cfg,chat),{shouldRespond:false});
  assert.equal(rows().at(-1).ok,false);
}
reply({...envelope,is_error:true});
await assert.rejects(askClaude([],[],cfg,chat), /error result/);
assert.equal(rows().at(-1).ok,false);
assert.equal(rows().at(-1).inputTokens,20);
fs.writeFileSync(path.join(runtimeDir,'exit'),'');
await assert.rejects(askClaude([],[],cfg,chat), /code 9/);
assert.equal(rows().at(-1).ok,false);
fs.unlinkSync(path.join(runtimeDir,'exit'));
reply(envelope);
for (const basename of ['briefing',chat,'group-000000000000']) {
  fs.writeFileSync(path.join(promptsDir,basename+'.md'),'Synthetic prompt.');
  await askClaude([],[],{...cfg,prompt:'prompts/'+basename+'.md'},chat);
  assert.equal(rows().at(-1).step,basename==='briefing' ? 'briefing' : 'default');
}
fs.unlinkSync(path.join(runtimeDir,'model'));
await assert.rejects(askClaude([],[],cfg,chat));
assert.equal(rows().at(-1).ok,false);
assert.equal(rows().length,10);
assert.doesNotMatch(fs.readFileSync(path.join(dataDir,'usage.jsonl'),'utf8'),/synthetic-chat-id|000000000000|Synthetic reply|Synthetic note|Synthetic prompt/);
// Node's spawn timeout can remain live after ENOENT; all assertions have completed.
process.exit(0);
`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, CLAUDE_BIN: bin }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
