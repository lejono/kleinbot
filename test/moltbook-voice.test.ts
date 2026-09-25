import assert from "node:assert/strict";
import { after, beforeEach, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
process.env.KLEINBOT_RUNTIME_DIR = dir;
const { initConfig, dataDir, modelConfig, moltbookPresenceConfig, roamConfig, researchConfig, promptsDir } = await import("../src/config.js");
initConfig("roam");
const { reflectVoice, readVoice, resetVoice, voiceContext } = await import("../src/moltbook/voice.js");
const { loadMoltbookState } = await import("../src/moltbook/state.js");
const { answerInbox } = await import("../src/roam/answer.js");
const { appendChat } = await import("../src/roam/chat-log.js");
const { writeRoamControl } = await import("../src/roam/control.js");
const now = new Date("2026-07-02T12:00:00Z");
const profile: any = { agent: { id: "self", name: "SyntheticBot", description: "PROFILE_SENTINEL" },
  recentPosts: [{ id: "own-post", title: "Own title", content_preview: "Own post text", created_at: now.toISOString(),
    upvotes: 3, comment_count: 2, submolt: { name: "SUBMOLT_SENTINEL" } }],
  recentComments: [{ id: "own-comment", content: "Own comment text", created_at: now.toISOString(), upvotes: 4,
    post: { id: "thread", title: "FEED_SENTINEL" }, replies: [{content:"REPLY_SENTINEL"}], reply_count: "COUNT_SENTINEL" }] };
const calls = () => fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
const flags = () => fs.readdirSync(path.join(roamConfig.outboxDir, "research")).filter(x => x.endsWith(".json")).map(x =>
  JSON.parse(fs.readFileSync(path.join(roamConfig.outboxDir, "research", x), "utf8")));
function output(value: unknown) { fs.writeFileSync(path.join(dir, "result"), JSON.stringify(value)); }
beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
  roamConfig.outboxDir = path.join(dir, "outbox"); roamConfig.inboxDir = path.join(dir, "inbox");
  moltbookPresenceConfig.voiceMaxChars = 2000;
  modelConfig.moltbookBackend = "claude"; modelConfig.moltbookModel = "synthetic-model";
  modelConfig.claudeBin = path.join(dir, "model");
  fs.writeFileSync(modelConfig.claudeBin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(path.join(root,'calls'), JSON.stringify({args, input:fs.readFileSync(0,'utf8')})+'\\n');
process.stdout.write(JSON.stringify({result:fs.readFileSync(path.join(root,'result'),'utf8')}));
`, { mode: 0o700 });
  output({ voice: "I like small examples.", changed: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
it("reflects only on own writing and numeric trends, once per UK day, with no tools", async () => {
  fs.mkdirSync(researchConfig.dir, { recursive: true }); fs.mkdirSync(researchConfig.wikiDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(researchConfig.dir, "corpus.jsonl"), "CORPUS_SENTINEL");
  fs.writeFileSync(path.join(researchConfig.wikiDir, "summary.md"), "WIKI_SENTINEL");
  fs.writeFileSync(path.join(promptsDir, "moltbook.md"), "PERSONA_SENTINEL");
  fs.writeFileSync(path.join(dataDir, "voice.md"), "I used to write long posts.");
  appendChat({ timestamp: now.getTime(), role: "operator", text: "OPERATOR_SENTINEL" });
  writeRoamControl({ directives: "FOCUS_SENTINEL" });
  fs.writeFileSync(path.join(researchConfig.dir, "presence.jsonl"), JSON.stringify({date:"2026-07-02",karma:5,followers:2,following:1,posts:3,comments:4,extra:"TREND_SENTINEL"})+"\n");
  const state = loadMoltbookState();
  await reflectVoice(state, profile, now);
  await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-02T22:59:00Z"));
  assert.equal(calls().length, 1);
  const call = calls()[0], text = call.input + call.args.join(" ");
  assert.doesNotMatch(text, /\w+_SENTINEL/);
  assert.match(text, /Own post text|Own comment text/);
  const input = JSON.parse(call.input);
  assert.equal(input.writing.length, 2);
  assert.equal(input.writing[0].upvotes, 3);
  assert.equal(input.writing[0].replyCount, 2);
  assert.equal(input.writing[1].replyCount, undefined);
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
  assert.equal(call.args[call.args.indexOf("--model") + 1], "synthetic-model");
  assert.match(text, /These are your notes on your own voice and interests on this platform/);
  assert.equal(readVoice(), "I like small examples.");
  assert.match(fs.readFileSync(path.join(dataDir, "voice-history.md"), "utf8"), /2026-07-02[\s\S]*I used to write long posts/);
  assert.equal(fs.statSync(path.join(dataDir,"voice.md")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataDir,"voice-history.md")).mode & 0o777, 0o600);
  assert.equal(flags()[0].text, "Voice notes updated: I like small examples.");
  const usage = JSON.parse(fs.readFileSync(path.join(dataDir,"usage.jsonl"),"utf8"));
  assert.equal(usage.step, "voice");
  await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-02T23:01:00Z"));
  assert.equal(calls().length, 2, "midnight UK allows the next day's attempt");
});
it("caps and strips voice text, appends history, and refuses configured secrets before truncating", async () => {
  moltbookPresenceConfig.voiceMaxChars = 30;
  output({voice:"I\u0000 like details. " + "x".repeat(100),changed:true});
  await reflectVoice(loadMoltbookState(), profile, now);
  assert.equal(readVoice().length, 30); assert.doesNotMatch(readVoice(), /\u0000/);
  const previous = readVoice();
  process.env.MOLTBOOK_API_KEY = "synthetic-voice-secret";
  try {
    output({voice:"x".repeat(100)+process.env.MOLTBOOK_API_KEY,changed:true});
    await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-03T12:00:00Z"));
    assert.equal(readVoice(), previous);
    output({voice:"I try shorter posts.",changed:true});
    await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-04T12:00:00Z"));
    const history = fs.readFileSync(path.join(dataDir,"voice-history.md"),"utf8");
    assert.match(history, /2026-07-04/); assert.ok(history.includes(previous));
    resetVoice(new Date("2026-07-05T12:00:00Z"));
    assert.equal(readVoice(), "");
    assert.ok(fs.readFileSync(path.join(dataDir,"voice-history.md"),"utf8").startsWith(history));
    assert.match(fs.readFileSync(path.join(dataDir,"voice-history.md"),"utf8"), /I try shorter posts/);
  } finally { delete process.env.MOLTBOOK_API_KEY; }
});
it("excludes old, future and explicitly foreign writing; caps the own-writing sample", async () => {
  const old = {...profile.recentComments[0], content:"OLD_SENTINEL",created_at:"2000-01-01T00:00:00Z"};
  const foreign = {...profile.recentComments[0], content:"FOREIGN_SENTINEL",author:{id:"other"}};
  const future = {...old,content:"FUTURE_SENTINEL",created_at:"2100-01-01T00:00:00Z"};
  const sample = { ...profile, recentPosts: [], recentComments: [old,foreign,future,...Array(70).fill({...profile.recentComments[0],content:"x".repeat(3000)})] };
  await reflectVoice(loadMoltbookState(), sample, now);
  assert.doesNotMatch(calls()[0].input, /\w+_SENTINEL/);
  const writing = JSON.parse(calls()[0].input).writing;
  assert.equal(writing.length, 40); assert.ok(writing.every((x: any) => x.text.length <= 2000));
});
it("does not change notes for unchanged/invalid responses or without a safe backend and outbox", async () => {
  fs.writeFileSync(path.join(dataDir,"voice.md"), "Existing notes");
  for (const [i,value] of [{voice:"discard",changed:false},{voice:42,changed:true},{voice:"   ",changed:true}].entries()) {
    output(value); await reflectVoice(loadMoltbookState(), profile, new Date(`2026-07-0${i+2}T12:00:00Z`));
    assert.equal(readVoice(), "Existing notes");
  }
  const count = calls().length;
  modelConfig.moltbookBackend = "codex";
  await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-05T12:00:00Z"));
  assert.equal(calls().length, count);
  modelConfig.moltbookBackend = "claude"; roamConfig.outboxDir = "";
  await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-06T12:00:00Z"));
  assert.equal(calls().length, count);
});
it("serves /voice and /resetvoice without model calls and keeps history", async () => {
  fs.mkdirSync(roamConfig.inboxDir, { recursive: true });
  async function command(text: string, id: string) {
    fs.writeFileSync(path.join(roamConfig.inboxDir, id+".json"), JSON.stringify({ id, timestamp: Date.now()/1000,
      senderName:"Synthetic Operator",text,attachments:[] }));
    await answerInbox();
  }
  await command("/voice", "empty");
  assert.equal(flags()[0].text, "No voice notes yet.");
  fs.writeFileSync(path.join(dataDir,"voice.md"), "I like specific examples.");
  assert.match(voiceContext(), /Your own notes on your voice \(written by you from your own posts\). Operator instructions above take priority/);
  await command("/voice", "read"); await command("/resetvoice", "reset");
  assert.ok(flags().some(f => f.text === "I like specific examples."));
  assert.ok(flags().some(f => f.text === "Voice notes reset."));
  assert.equal(readVoice(), ""); assert.equal(calls().length, 0);
  assert.match(fs.readFileSync(path.join(dataDir,"voice-history.md"),"utf8"), /I like specific examples/);
});
it("/voicehistory attaches a page with the current notes first and earlier versions newest first", async () => {
  fs.mkdirSync(roamConfig.inboxDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir,"voice-history.md"), "## 2026-06-01\nFirst voice.\n\n## 2026-06-10\nSecond voice.\n\n");
  fs.writeFileSync(path.join(dataDir,"voice.md"), "Third voice.");
  fs.writeFileSync(path.join(roamConfig.inboxDir, "vh.json"), JSON.stringify({ id: "vh", timestamp: Date.now()/1000,
    senderName: "Synthetic Operator", text: "/voicehistory", attachments: [] }));
  await answerInbox();
  const flag = flags().find(f => f.text === "Voice notes history attached.");
  assert.ok(flag && flag.attachmentPath, "history attached");
  const page = fs.readFileSync(path.join(roamConfig.outboxDir, "research", path.basename(flag.attachmentPath)), "utf8");
  assert.ok(page.indexOf("Third voice.") < page.indexOf("Second voice.") && page.indexOf("Second voice.") < page.indexOf("First voice."));
  assert.match(page, /### Until 2026-06-10/);
  assert.equal(calls().length, 0);
});

it("rolls back an update if the outbox cannot publish it and bounds its notice", async t => {
  const previousLimit = roamConfig.maxTextChars;
  fs.writeFileSync(path.join(dataDir,"voice.md"), "Old notes");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith(".json") && String(to).includes("outbox")) throw new Error("Synthetic publication failure");
    return rename(from, to);
  });
  await reflectVoice(loadMoltbookState(), profile, now);
  assert.equal(readVoice(), "Old notes");
  t.mock.restoreAll();
  try {
    roamConfig.maxTextChars = 50;
    output({voice:"I like details. "+"x".repeat(500),changed:true});
    await reflectVoice(loadMoltbookState(), profile, new Date("2026-07-03T12:00:00Z"));
    assert.ok(flags()[0].text.length <= 50);
    assert.match(flags()[0].text, /^Voice notes updated:/);
  } finally { roamConfig.maxTextChars = previousLimit; }
});
it("refuses symlinked voice reads and history writes", async () => {
  const target = path.join(dir,"target"); fs.writeFileSync(target,"Unrelated synthetic file");
  fs.symlinkSync(target,path.join(dataDir,"voice.md"));
  assert.equal(readVoice(), "");
  fs.unlinkSync(path.join(dataDir,"voice.md")); fs.writeFileSync(path.join(dataDir,"voice.md"),"Old notes");
  fs.symlinkSync(target,path.join(dataDir,"voice-history.md"));
  await reflectVoice(loadMoltbookState(),profile,now);
  assert.equal(readVoice(),"Old notes"); assert.equal(fs.readFileSync(target,"utf8"),"Unrelated synthetic file");
});
