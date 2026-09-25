import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const backend of ["claude"]) {
  it(`answers trusted inbox messages with ${backend}, bounds controls and retains deduplication`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-test-"));
    try {
      const bin = path.join(dir, "model");
      fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
const reply = input.includes('ROAM_CONTROL_INTENT') ? (fs.existsSync(path.join(root, 'intent')) ? fs.readFileSync(path.join(root, 'intent'), 'utf8') : '{"control":null,"confidence":1}') : fs.readFileSync(path.join(root, 'reply'), 'utf8');
if (reply === 'FAIL') process.exit(9);
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], reply);
else process.stdout.write(JSON.stringify({result:reply}));
`, { mode: 0o700 });
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, initConfig, runtimeDir, promptsDir, roamConfig, researchConfig, modelConfig } from './src/config.ts';
import { answerInbox } from './src/roam/answer.ts';
import { writeInboxMessage } from './src/roam/inbox.ts';
import { readRoamControl } from './src/roam/control.ts';
import { readRecentChat } from './src/roam/chat-log.ts';
import { runMoltbookCycle } from './src/moltbook/cycle.ts';
initConfig('roam');
fs.mkdirSync(promptsDir, {recursive:true});
fs.mkdirSync(researchConfig.wikiDir, {recursive:true});
fs.writeFileSync(path.join(researchConfig.wikiDir, 'summary.md'), 'Synthetic wiki');
const reply = value => fs.writeFileSync(path.join(runtimeDir, 'reply'), typeof value === 'string' ? value : JSON.stringify(value));
const calls = () => fs.readFileSync(path.join(runtimeDir, 'calls'), 'utf8').trim().split('\\n').map(JSON.parse);
const inbox = (id, timestamp = Math.floor(Date.now() / 1000)) => {
  assert.equal(writeInboxMessage({id, timestamp, chatJid:'synthetic-group', sender:'Synthetic Member', senderJid:'synthetic-sender', text:'Synthetic question'}),true);
  return fs.readdirSync(roamConfig.inboxDir).find(f => f.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(roamConfig.inboxDir,f),'utf8')).timestamp === timestamp);
};
const flags = () => fs.readdirSync(path.join(roamConfig.outboxDir,'research')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(roamConfig.outboxDir,'research',f),'utf8')));
const seen = () => JSON.parse(fs.readFileSync(path.join(researchConfig.dir,'inbox-seen.json'),'utf8'));
reply({reply:'Synthetic answer',attachMd:'summary.md',control:{paused:true,directives:'Guidance\\x00'+'x'.repeat(2100)}});
const originalFile = inbox('first');
const originalRaw = fs.readFileSync(path.join(roamConfig.inboxDir,originalFile),'utf8');
await answerInbox();
assert.equal(flags().length,1);
assert.equal(flags()[0].text,'Synthetic answer');
assert.equal(fs.readFileSync(flags()[0].attachmentPath,'utf8'),'Synthetic wiki');
assert.equal(fs.readdirSync(roamConfig.inboxDir).length,0);
assert.equal(seen().length,1);
assert.deepEqual(readRoamControl(), {});
assert.deepEqual(readRecentChat().map(e=>[e.role,e.text]), [['operator','Synthetic question'],['assistant','Synthetic answer']]);
const first = calls()[1];
assert.equal(first.cwd,researchConfig.dir);
const a=first.args;
const assertParticipation = system => {
  assert.match(system, /Write like a particular person with opinions, in plain language with specific details/);
  assert.match(system, /Say one thing well rather than summarising everything/);
  assert.match(system, /You cannot act on the platform yourself/);
  assert.match(system, /what to post, comment on, pursue or avoid/);
  assert.match(system, /carried automatically into the next participation round/);
  assert.match(system, /about every 2 hours/);
  assert.match(system, /Reply briefly acknowledging/);
  assert.match(system, /rather than saying you are a different bot or refusing/);
};
assertParticipation(a[a.indexOf('--system-prompt')+1]);
if(roamConfig.chatBackend==='claude') {
  assert.deepEqual(a,['--print','--model','synthetic-model','--no-session-persistence','--system-prompt',a[5],'--output-format','json',
    '--tools','Read,Grep,Glob','--allowedTools','Read,Grep,Glob','--restricted','--safe-mode',
    '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands',
    '--permission-mode','dontAsk','--add-dir',researchConfig.dir,researchConfig.wikiDir]);
  assert.match(a[5],/untrusted text written by other agents/);
  assert.ok(!a.includes('WebSearch,WebFetch'));
} else {
  const output=a[a.indexOf('-o')+1];
  assert.deepEqual(a,['exec','-m','synthetic-model','--sandbox','read-only','--skip-git-repo-check','--ephemeral',
    ...modelConfig.codexDisableFeatures.flatMap(f=>['--disable',f]),'-C',researchConfig.dir,'-o',output,'-']);
  assert.equal(fs.existsSync(path.dirname(output)),false);
}
assert.match(first.input,/Trusted operator message/);
fs.writeFileSync(path.join(roamConfig.inboxDir,'duplicate.json'),originalRaw);
await answerInbox();
assert.equal(calls().length,2);
assert.equal(flags().length,1);
assert.equal(readRecentChat().length,2);
// Commands run entirely in code and confirm through the research outbox.
const command = async (text) => {
  const before = calls().length;
  const beforeFlags = flags().length;
  writeInboxMessage({id:'cmd-'+text, timestamp:Math.floor(Date.now() / 1000), chatJid:'synthetic-group', sender:'Member', senderJid:'synthetic-sender', text});
  await answerInbox(); assert.equal(calls().length, before);
  assert.equal(flags().length, beforeFlags + 1);
  const expected = text.startsWith('/pause') ? 'Paused participation.' : text.startsWith('/resume') ? 'Resumed participation.'
    : text.startsWith('/focus') ? 'Focus updated.' : text.startsWith('/clearfocus') ? 'Focus cleared.' : 'Paused:';
  assert.ok(flags().some(f=>f.text.startsWith(expected)));
  if (text === '/status') {
    const status = flags().find(f=>f.text.startsWith('Paused:')).text;
    assert.match(status,/Usage \\(last 24h\\):/);
    assert.match(status,/Usage \\(last 7d\\):/);
    assert.match(status,/claude\\/synthetic-model:.*input unknown/);
  }
  assert.equal(readRecentChat().at(-2).text,text.slice(0,4000));
  assert.ok(readRecentChat().at(-1).text.startsWith(expected));
};
await command('/pause'); assert.equal(readRoamControl().paused,true);
assert.ok(flags().some(f=>f.text.includes('Paused')));
await command('/focus Guidance'+'x'.repeat(2100)); assert.equal(readRoamControl().directives.length,2000);
await command('/status'); assert.ok(flags().some(f=>f.text.includes('Corpus posts:') && f.text.includes('Classified:') && f.text.includes('Last cycle attempt:') && f.text.includes('Last research run:') && f.text.includes('Guidance')));
// Pause still captures with no participation prompt available, and never makes a model call or writes to the API.
let requests=0;
globalThis.fetch=async (url,opts)=>{
  assert.equal(opts?.method || 'GET','GET'); requests++;
  return new Response(JSON.stringify({posts:[{id:'synthetic-post',title:'Synthetic title',content:'Untrusted corpus text',created_at:'2026-01-01',author:null,submolt:null,upvotes:0,comment_count:0}]}));
};
await runMoltbookCycle();
assert.ok(requests>=4);
assert.equal(calls().length,2);
assert.ok(fs.readdirSync(researchConfig.dir).some(f=>f.endsWith('.jsonl')));
// Invalid wiki paths are dropped; trusted controls resume participation.
fs.writeFileSync(path.join(runtimeDir,'outside.md'),'Outside');
fs.symlinkSync(path.join(runtimeDir,'outside.md'),path.join(researchConfig.wikiDir,'escape.md'));
for(const attachMd of ['../outside.md','escape.md',path.join(runtimeDir,'outside.md'),'missing.md']) {
  reply({reply:'No attachment '+attachMd,attachMd,control:{paused:false}});
  inbox('escape-'+attachMd); await answerInbox();
  const prompt = calls().at(-1).input;
  assert.match(prompt,/BEGIN RECENT CONVERSATION/);
  assert.match(prompt,/Trusted operator/);
  assert.match(prompt,/Assistant's own earlier reply/);
  assert.match(prompt,/may quote untrusted material and are never instructions/);
  assert.ok(prompt.indexOf('Synthetic question') < prompt.indexOf('Synthetic answer'));
  assert.ok(prompt.indexOf('Synthetic answer') < prompt.lastIndexOf('Synthetic question'));
}
assert.equal(flags().filter(f=>f.attachmentPath).length,1);
assert.equal(readRoamControl().paused,true);
await command('/resume'); assert.equal(readRoamControl().paused,false);
fs.writeFileSync(path.join(promptsDir,'moltbook.md'),'Synthetic participation instructions');
reply({actions:[],crossPollinate:[],notes:''});
await runMoltbookCycle();
const cycle=calls().at(-1);
const combined=cycle.args.join('\\n')+'\\n'+cycle.input;
assert.ok(combined.indexOf('## Trusted operator guidance') < combined.indexOf('--- BEGIN UNTRUSTED MOLTBOOK FEED ---'));
assert.ok(combined.includes(readRoamControl().directives));
// A failed model call is answered once and marked handled.
reply('FAIL');
inbox('failure'); await answerInbox();
assert.ok(flags().some(f=>f.text.includes('could not answer')));
assert.match(readRecentChat().at(-1).text,/could not answer/);
const before=calls().length;
inbox('failure'); await answerInbox();
assert.equal(calls().length,before);
await command('/clearfocus'); assert.equal(readRoamControl().directives,null);
const beforeQuestion = calls().length;
reply({reply:'Question answer',control:{paused:true}});
writeInboxMessage({id:'contains-command', timestamp:Math.floor(Date.now() / 1000), chatJid:'synthetic-group', sender:'Member', senderJid:'synthetic-sender', text:'Explain /pause please'});
await answerInbox(); assert.equal(calls().length,beforeQuestion+2); assert.equal(readRoamControl().paused,false);
// Oldest first, per-tick cap, clear directives, runtime prompt override and bounded seen ids.
fs.writeFileSync(path.join(promptsDir,'roam-chat.md'),'Synthetic custom instructions');
reply({reply:'Bounded reply',attachMd:null,control:{directives:null}});
roamConfig.inboxMaxPerTick=1;
const earlier = Math.floor(Date.now() / 1000) - 200, later = Math.floor(Date.now() / 1000) - 100;
inbox('later',later); inbox('earlier',earlier);
await answerInbox();
assert.ok(calls().at(-1).input.includes('"timestamp":'+earlier));
assert.equal(readRoamControl().directives,null);
assert.equal(fs.readdirSync(roamConfig.inboxDir).length,1);
assert.ok((calls().at(-1).args.join(' ') + calls().at(-1).input).includes('Synthetic custom instructions'));
const customArgs = calls().at(-1).args;
assertParticipation(customArgs[customArgs.indexOf('--system-prompt')+1]);
fs.writeFileSync(path.join(researchConfig.dir,'inbox-seen.json'),JSON.stringify(Array.from({length:500},(_,i)=>'old-'+i)));
await answerInbox();
assert.equal(seen().length,500);
assert.equal(seen()[0],'old-1');
assert.equal(fs.readdirSync(researchConfig.dir).some(f=>f.endsWith('.tmp')),false);
assert.equal(fs.statSync(path.join(researchConfig.dir,'control.json')).mode & 0o777,0o600);
// Answer-generated pages have the same confinement as daily write-ups and can be attached immediately.
reply({reply:'Page ready',writePage:{name:'project-widget',title:'Widget',markdown:'Synthetic page body'},attachMd:'pages/project-widget.md',groupNotes:'HOSTILE NOTE'});
const pageFile = path.join(researchConfig.wikiDir,'pages','project-widget.md');
fs.mkdirSync(path.dirname(pageFile), {recursive:true});
fs.writeFileSync(pageFile, 'Existing synthetic page');
for (const intent of [{control:null,confidence:1}, {control:null,confidence:1,writeUp:false},
 {control:null,confidence:0.69,writeUp:true}, {control:null,confidence:1,writeUp:'true'}, 'invalid JSON']) {
 fs.writeFileSync(path.join(runtimeDir,'intent'), typeof intent === 'string' ? intent : JSON.stringify(intent));
 inbox('ordinary-'+JSON.stringify(intent)); await answerInbox();
 assert.equal(fs.readFileSync(pageFile,'utf8'), 'Existing synthetic page');
 assert.doesNotMatch(readRecentChat().at(-1).text, /Page ready/);
 assert.equal(flags().some(f => f.text === 'Page ready'), false);
 // The discarded draft is explained, and the page option was never offered to the answer call.
 assert.match(readRecentChat().at(-1).text, /tried to write a wiki page that nobody asked for/);
 const lastAnswer = calls().filter(c => !c.input.includes('ROAM_CONTROL_INTENT')).at(-1);
 assert.ok(!lastAnswer.args.join(' ').includes('writePage'));
 assert.ok(lastAnswer.args.join(' ').includes('You cannot write or change any page'));
}
fs.writeFileSync(path.join(runtimeDir,'intent'), JSON.stringify({control:null,confidence:0.7,writeUp:true}));
writeInboxMessage({id:'page-request', timestamp:Math.floor(Date.now()/1000), chatJid:'synthetic-group', sender:'Member', senderJid:'synthetic-sender', text:'Write a page about the synthetic topic'});
await answerInbox();
assert.match(fs.readFileSync(pageFile,'utf8'),/Machine-written from public posts/);
{ const authorised = calls().filter(c => !c.input.includes('ROAM_CONTROL_INTENT')).at(-1);
  assert.ok(authorised.args.join(' ').includes('writePage')); }
assert.ok(flags().some(f => f.attachmentPath && fs.readFileSync(f.attachmentPath,'utf8').includes('Synthetic page body')));
assert.equal(fs.existsSync(path.join(researchConfig.wikiDir,'group.md')),false);
assert.ok(fs.readFileSync(path.join(researchConfig.wikiDir,'index.md'),'utf8').includes('pages/project-widget.md'));
const controlBefore = fs.readFileSync(path.join(researchConfig.dir,'control.json'),'utf8');
for (const name of ['../control.json','group','/etc/x']) {
 reply({reply:'Synthetic reply',writePage:{name,title:'Escape',markdown:'HOSTILE PAGE'}});
 inbox('invalid-page-'+name); await answerInbox();
}
assert.equal(fs.readFileSync(path.join(researchConfig.dir,'control.json'),'utf8'),controlBefore);
assert.equal(fs.existsSync(path.join(researchConfig.wikiDir,'group.md')),false);
assert.deepEqual(fs.readdirSync(path.join(researchConfig.wikiDir,'pages')),['project-widget.md']);
fs.writeFileSync(path.join(researchConfig.wikiDir,'group.md'),'# Synthetic group notes');
const logName = fs.readdirSync(researchConfig.wikiDir).find(n=>n.startsWith('log-'));
for (const attachMd of ['group.md',logName]) {
 reply({reply:'Attached '+attachMd,attachMd}); inbox('attach-'+attachMd); await answerInbox();
 assert.ok(flags().some(f=>f.text==='Attached '+attachMd && f.attachmentPath));
}

`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, MOLTBOOK_API_KEY: "synthetic-key",
        CLAUDE_BIN: bin, CODEX_BIN: bin, ROAM_INBOX_DIR: path.join(dir, "inbox"), ROAM_PIPE_CHAT_JID: "synthetic-group",
        ROAM_OUTBOX_DIR: path.join(dir, "outbox"), ROAM_CHAT_BACKEND: backend, ROAM_CHAT_MODEL: "synthetic-model",
        MOLTBOOK_BACKEND: backend, MOLTBOOK_HEARTBEAT_INTERVAL: "7200000", RESEARCH_CAPTURE: "1", RESEARCH_MAX_COMMENT_FETCH: "0" }, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

it("runs the answerer before other roam jobs", () => {
  const source = fs.readFileSync(new URL("../src/index-roam.ts", import.meta.url), "utf8");
  assert.match(source, /const jobs = \[\s*answerInbox,/);
});

it("publishes copied answer attachments through a temporary file", async (t) => {
  const { roamConfig } = await import("../src/config.js");
  const { writeOutboxMessage } = await import("../src/roam/outbox.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-atomic-"));
  const original = { ...roamConfig };
  const rename = fs.renameSync;
  const destinations: string[] = [];
  try {
    roamConfig.outboxDir = dir;
    const md = path.join(dir, "source.md");
    fs.writeFileSync(md, "Synthetic attachment");
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      assert.ok(String(from).endsWith(".tmp"));
      assert.equal(fs.existsSync(to), false);
      destinations.push(path.extname(String(to)));
      rename(from, to);
    });
    assert.equal(writeOutboxMessage("research", "Answer", md), "published");
    assert.deepEqual(destinations, [".md", ".json"]);
  } finally {
    t.mock.restoreAll(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses non-Claude answer backends after the isolated Claude intent call", async (t) => {
  const { initConfig, roamConfig, researchConfig, modelConfig } = await import("../src/config.js");
  const { answerInbox } = await import("../src/roam/answer.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-backend-"));
  const original = { ...roamConfig }; const originalResearch = { ...researchConfig };
  const originalModel = { ...modelConfig };
  try {
    initConfig("roam");
    Object.assign(roamConfig, { inboxDir: path.join(dir, "inbox"), outboxDir: path.join(dir, "outbox"), chatBackend: "codex" });
    researchConfig.wikiDir = path.join(dir, "wiki");
    researchConfig.dir = path.join(dir, "research");
    modelConfig.codexBin = path.join(dir, "must-not-run");
    modelConfig.claudeBin = path.join(dir, "intent");
    fs.writeFileSync(modelConfig.claudeBin, `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
if (!input.includes('ROAM_CONTROL_INTENT')) process.exit(9);
fs.appendFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), 'calls'), 'intent\\n');
process.stdout.write(JSON.stringify({result:'{"control":null,"confidence":1}'}));
`, { mode: 0o700 });
    fs.mkdirSync(roamConfig.inboxDir);
    const logs = t.mock.method(console, "error", () => {});
    for (const backend of ["codex", "unsupported"]) {
      roamConfig.chatBackend = backend as typeof roamConfig.chatBackend;
      fs.writeFileSync(path.join(roamConfig.inboxDir, backend + ".json"), JSON.stringify({ id: backend, timestamp: Math.floor(Date.now() / 1000), text: "Question", senderName: "Member", attachments: [] }));
      await answerInbox();
    }
    const flags = fs.readdirSync(path.join(roamConfig.outboxDir, "research")).map(n => JSON.parse(fs.readFileSync(path.join(roamConfig.outboxDir, "research", n), "utf8")));
    assert.equal(flags.length, 2); assert.ok(flags.every(f => f.text.includes("backend is misconfigured")));
    assert.equal(logs.mock.callCount(), 1);
    assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), "intent\nintent\n");
  } finally { Object.assign(roamConfig, original); Object.assign(researchConfig, originalResearch); Object.assign(modelConfig, originalModel); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("keeps messages when the outbox is unavailable and deletes expired or future inbox entries", async (t) => {
  const { roamConfig, researchConfig } = await import("../src/config.js");
  const { answerInbox } = await import("../src/roam/answer.js");
  const { MAX_AGE_MS } = await import("../src/entourage-watcher.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-fresh-"));
  const original = { ...roamConfig }, researchOriginal = { ...researchConfig };
  try {
    Object.assign(roamConfig, { inboxDir: path.join(dir, "inbox"), outboxDir: path.join(dir, "blocked") });
    researchConfig.wikiDir = path.join(dir, "wiki");
    researchConfig.dir = path.join(dir, "research"); fs.mkdirSync(roamConfig.inboxDir);
    fs.writeFileSync(roamConfig.outboxDir, "Obstruction");
    const put = (id: string, timestamp: number, text = "/pause") => fs.writeFileSync(path.join(roamConfig.inboxDir, id + ".json"), JSON.stringify({ id, timestamp, text, senderName: "Member", attachments: [] }));
    put("fresh", Math.floor(Date.now() / 1000)); await answerInbox();
    assert.ok(fs.existsSync(path.join(roamConfig.inboxDir, "fresh.json")));
    assert.equal(fs.existsSync(path.join(researchConfig.dir, "inbox-seen.json")), false);
    fs.unlinkSync(roamConfig.outboxDir);
    // Exercise access failures even when tests run with elevated filesystem privileges.
    t.mock.method(fs, "accessSync", () => { throw Error("Denied"); });
    await answerInbox(); assert.ok(fs.existsSync(path.join(roamConfig.inboxDir, "fresh.json")));
    t.mock.restoreAll();
    put("old", Math.floor(Date.now() / 1000) - MAX_AGE_MS / 1000 - 1, "/resume"); put("future", Math.floor(Date.now() / 1000) + 301, "/resume");
    await answerInbox();
    assert.equal(fs.readdirSync(roamConfig.inboxDir).length, 0);
    const control = JSON.parse(fs.readFileSync(path.join(researchConfig.dir, "control.json"), "utf8"));
    assert.equal(control.paused, true);
    assert.equal(fs.readdirSync(path.join(roamConfig.outboxDir, "research")).length, 1);
  } finally { t.mock.restoreAll(); Object.assign(roamConfig, original); Object.assign(researchConfig, researchOriginal); fs.rmSync(dir, { recursive: true, force: true }); }
});
