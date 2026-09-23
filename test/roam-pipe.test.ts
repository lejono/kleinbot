import assert from "node:assert/strict";
import { it } from "node:test";
import { roamConfig } from "../src/config.js";
import { createInboxPipe } from "../src/roam/pipe.js";
import type { ChatMessage } from "../src/types.js";

it("retains failed pipe writes without marking them processed or exposing them to the model queue", () => {
  const original = { ...roamConfig };
  try {
    Object.assign(roamConfig, { inboxDir: "synthetic", pipeChatJid: "synthetic-chat" });
    const msg: ChatMessage = { id: "synthetic", chatJid: "synthetic-chat", sender: "Member", senderJid: "synthetic-sender", timestamp: 1, text: "Question" };
    const pending = new Map([[msg.chatJid, [msg]]]); const processed: string[] = []; let fail = true;
    const pipe = createInboxPipe(pending, m => processed.push(m.id), () => !fail);
    assert.equal(pending.size, 0); assert.deepEqual(processed, []);
    assert.deepEqual(pipe.persisted().get(msg.chatJid), [msg]);
    assert.equal(pipe.route({ ...msg, id: "live" }), true); assert.deepEqual(processed, []);
    assert.equal(pending.size, 0);
    fail = false; pipe.route({ ...msg, id: "next" });
    assert.deepEqual(processed, ["synthetic", "live", "next"]);
    assert.equal(pipe.persisted().size, 0);
  } finally { Object.assign(roamConfig, original); }
});

it("routes real daemon live and persisted messages away from the model, including failed writes", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-daemon-"));
  try {
    const bin = path.join(dir, "model");
    fs.writeFileSync(bin, `#!${process.execPath}
const fs=require('fs'); const input=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))},JSON.stringify(input)+'\\n');
process.stdout.write('{"shouldRespond":false}');
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { initConfig, roamConfig, runtimeDir, promptsDir } from './src/config.ts';
import { loadPending, savePending } from './src/pending.ts';
import { loadState } from './src/state.ts';
import { readInboxMessages } from './src/roam/inbox.ts';
import { startDaemon } from './src/daemon.ts';
const config=initConfig('signal');
fs.mkdirSync(promptsDir,{recursive:true});
fs.writeFileSync(path.join(promptsDir,'default.md'),'Synthetic instructions');
fs.writeFileSync(config.chatsConfigFile,JSON.stringify({default:{prompt:'prompts/default.md',model:'synthetic'}}));
const msg=(id,chatJid,text)=>({id,chatJid,text,timestamp:Math.floor(Date.now()/1000),sender:'Member',senderJid:'synthetic-sender'});
const piped=msg('startup-pipe','pipe-chat','PIPE_STARTUP_MARKER');
const ordinary=msg('startup-other','other-chat','OTHER_STARTUP_MARKER');
savePending(new Map([[piped.chatJid,[piped]],[ordinary.chatJid,[ordinary]]]));
fs.writeFileSync(roamConfig.inboxDir,'Synthetic obstruction');
const intervals=new Map(); globalThis.setInterval=(fn,ms)=>{intervals.set(ms,fn);return 0;};
let receive;
const transport={name:'synthetic',start:async cb=>{receive=cb;},isConnected:()=>true,isDm:()=>false,isGroup:()=>false,
  sendText:async()=>{},sendFile:async()=>true,shutdown:()=>{},fetchGroupDescription:async()=>null};
await startDaemon({createTransport:()=>transport,dmAccessControl:false,enableMoltbook:false,enableBriefing:false});
const tick=intervals.get(12345); assert.equal(typeof tick,'function');
assert.deepEqual(loadPending().get('pipe-chat'),[piped]);
await tick();
const calls=()=>fs.readFileSync(path.join(runtimeDir,'calls'),'utf8').trim().split('\\n').map(JSON.parse);
assert.equal(calls().length,1); assert.ok(calls()[0].includes('OTHER_STARTUP_MARKER'));
assert.ok(!loadState().processedMessageIds.includes(piped.id));
assert.deepEqual(loadPending().get('pipe-chat'),[piped]);
fs.unlinkSync(roamConfig.inboxDir);
receive([msg('live-pipe','pipe-chat','PIPE_LIVE_MARKER'),msg('live-other','other-chat','OTHER_LIVE_MARKER')]);
assert.deepEqual(readInboxMessages().map(x=>x.message.text).sort(),['PIPE_LIVE_MARKER','PIPE_STARTUP_MARKER']);
assert.equal(loadPending().has('pipe-chat'),false);
await tick(); assert.equal(calls().length,2); assert.ok(calls()[1].includes('OTHER_LIVE_MARKER'));
// A live failure is neither processed nor passed to the model; a later pipe write retries it.
fs.renameSync(roamConfig.inboxDir,roamConfig.inboxDir+'-saved'); fs.writeFileSync(roamConfig.inboxDir,'Obstruction');
receive([msg('failed-live','pipe-chat','PIPE_FAILED_MARKER')]);
assert.ok(!loadState().processedMessageIds.includes('failed-live'));
await tick(); assert.equal(calls().length,2);
fs.unlinkSync(roamConfig.inboxDir); fs.renameSync(roamConfig.inboxDir+'-saved',roamConfig.inboxDir);
receive([msg('next-live','pipe-chat','PIPE_NEXT_MARKER')]);
await tick(); assert.equal(calls().length,2); assert.equal(readInboxMessages().length,4);
assert.ok(loadState().processedMessageIds.includes('failed-live'));
assert.ok(calls().every(input=>!input.includes('PIPE_')));
process.exit(0);
`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir, CLAUDE_BIN: bin, PROCESS_INTERVAL: "12345",
      ROAM_INBOX_DIR: path.join(dir, "inbox"), ROAM_PIPE_CHAT_JID: "pipe-chat", ROAM_OUTBOX_DIR: "",
      ENTOURAGE_FLAGS_DIR: path.join(dir, "flags"), MOLTBOOK_API_KEY: "" }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("documents the command contract and inbox privacy boundary", async () => {
  const fs = await import("node:fs");
  const doc = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  for (const term of ["/pause", "/resume", "/focus", "/clearfocus", "HMAC-SHA-256", "[number]", "[mention]", "file-1.pdf"])
    assert.ok(doc.includes(term), term);
  assert.ok(!doc.includes("{reply, attachMd, control}"));
});
