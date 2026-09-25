import assert from "node:assert/strict";
import { after, beforeEach, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-test-"));
process.env.KLEINBOT_RUNTIME_DIR = dir;
const { initConfig, modelConfig, researchConfig, promptsDir, roamConfig } = await import("../src/config.js");
const { runMoltbookCycle } = await import("../src/moltbook/cycle.js");
const { loadMoltbookState, saveMoltbookState } = await import("../src/moltbook/state.js");
const config = initConfig("roam");
let feed: any[], profile: any, threads: Record<string, any>, actions: any[], requests: { url: string; body: any }[];
const own = { id: "self-id", name: "SyntheticBot" };
const other = { id: "other-id", name: "SyntheticPeer" };
const post = (id: string) => ({ id, title: id, content: "Feed sentinel", author: other,
  submolt: { name: "general" }, upvotes: 1, comment_count: 0, created_at: new Date().toISOString() });
const comment = (id: string, parent_id: string | null, author = other) => ({ id, parent_id, author,
  content: `Text ${id}`, upvotes: 1, created_at: new Date().toISOString() });
const calls = () => fs.existsSync(path.join(dir, "calls"))
  ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
beforeEach(t => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.moltbookStateFile), { recursive: true });
  config.moltbookApiKey = "synthetic-key";
  researchConfig.capture = false;
  roamConfig.outboxDir = "";
  modelConfig.moltbookBackend = "claude";
  modelConfig.claudeBin = path.join(dir, "model");
  fs.writeFileSync(path.join(promptsDir, "moltbook.md"), "Synthetic persona");
  fs.writeFileSync(modelConfig.claudeBin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const dir = path.dirname(process.argv[1]), args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify({prompt, system: args[args.indexOf('--system-prompt')+1], args})+'\\n');
const result = prompt.startsWith('{"voice":') ? {voice:'I use small examples.',changed:true} : prompt.includes('BEGIN UNTRUSTED MOLTBOOK COMMENTS') ? {comment:'Synthetic answer'} : {actions:JSON.parse(fs.readFileSync(path.join(dir,'actions'),'utf8')),crossPollinate:[],notes:''};
process.stdout.write(JSON.stringify({result:JSON.stringify(result)}));
`, { mode: 0o700 });
  feed = []; actions = []; requests = [];
  profile = { agent: own, recentComments: [{ ...comment("mine", null, own), post: { id: "thread" } }], recentPosts: [] };
  threads = { thread: { post: post("thread"), comments: [comment("mine", null, own), comment("reply", "mine")] } };
  t.mock.method(globalThis, "fetch", async (url: any, options: any = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (options.method === "POST") {
      requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify({ comment: comment("sent", "reply", own) }));
    }
    if (pathname.endsWith("/agents/me")) return new Response(JSON.stringify({ agent: own }));
    if (pathname.endsWith("/agents/profile")) return new Response(JSON.stringify(profile));
    const id = pathname.match(/\/posts\/([^/]+)$/)?.[1];
    if (id) return new Response(JSON.stringify(threads[id]));
    return new Response(JSON.stringify({ posts: feed }));
  });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
async function round() {
  fs.writeFileSync(path.join(dir, "actions"), JSON.stringify(actions));
  await runMoltbookCycle();
}
it("offers replies on an idle feed, validates parents, and remembers successful answers", async () => {
  actions = [{ type: "comment", postId: "thread", parentId: "not-offered" },
    { type: "comment", postId: "wrong-thread", parentId: "reply" },
    { type: "comment", postId: "thread", parentId: "reply" }];
  await round();
  assert.match(calls()[0].prompt, /Replies to you[\s\S]*reply[\s\S]*Text reply[\s\S]*Text mine/);
  assert.ok(calls()[0].prompt.indexOf("Replies to you") > calls()[0].prompt.indexOf("BEGIN UNTRUSTED"));
  assert.match(calls()[1].prompt, /Reply to comment id=reply/);
  assert.deepEqual(requests.map(r => r.body.parent_id), ["reply"]);
  assert.deepEqual(loadMoltbookState().answeredReplyIds, ["reply"]);
  await round();
  assert.equal(calls().length, 2);
});
it("finds top-level replies on own posts, excludes self and already answered tree replies", async () => {
  profile.recentPosts = [{ ...post("thread"), author: undefined }];
  threads.thread.comments.push(comment("top", null), comment("answered", "mine"), comment("answer", "answered", own));
  await round();
  assert.match(calls()[0].prompt, /id=top/);
  assert.doesNotMatch(calls()[0].prompt, /id=answered|id=answer(?:\s|$)/);
});
it("ignores old activity and caps answer ids", async () => {
  profile.recentComments[0].created_at = "2000-01-01T00:00:00Z";
  await round();
  assert.equal(calls().length, 0);
  const state = loadMoltbookState();
  state.answeredReplyIds = Array.from({length: 1200}, (_, i) => `reply-${i}`);
  saveMoltbookState(state);
  assert.equal(loadMoltbookState().answeredReplyIds.length, 1000);
});
it("bounds distinct reply thread reads and tolerates individual failures", async t => {
  const { moltbookPresenceConfig } = await import("../src/config.js");
  const { findReplies } = await import("../src/moltbook/replies.js");
  const old = moltbookPresenceConfig.replyThreads;
  moltbookPresenceConfig.replyThreads = 2;
  profile.recentComments = ["one", "one", "two", "three"].map(id => ({ ...comment(`mine-${id}`, null, own), post: { id } }));
  const read: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any) => { read.push(String(url)); throw new Error("Synthetic failure"); });
  try {
    assert.deepEqual(await findReplies("synthetic-key", profile, loadMoltbookState()), []);
    assert.equal(read.length, 2);
  } finally { moltbookPresenceConfig.replyThreads = old; }
});
it("retains the existing comment rate limit and does not mark unsent replies answered", async () => {
  const state = loadMoltbookState(); state.commentTimestamps = Array(50).fill(Date.now()); saveMoltbookState(state);
  actions = [{ type: "comment", postId: "thread", parentId: "reply" }];
  await round();
  assert.equal(requests.length, 0);
  assert.deepEqual(loadMoltbookState().answeredReplyIds, []);
});
it("reads raw control characters in public profile JSON without losing activity", async t => {
  const { getProfileActivity } = await import("../src/moltbook/client.js");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(profile).replace("Text mine", "Text\nmine")));
  assert.equal((await getProfileActivity("SyntheticBot")).recentComments[0].content, "Text\nmine");
});
it("puts newer quiet posts first and shows numeric comment counts and ages", async () => {
  profile.recentComments = [];
  feed = [{ ...post("crowded"), comment_count: 400 },
    { ...post("old"), created_at: new Date(Date.now() - 48 * 3600000).toISOString() },
    { ...post("quiet"), comment_count: 2 }, { ...post("unknown"), created_at: "invalid" }];
  await round();
  const prompt = calls()[0].prompt;
  assert.ok(prompt.indexOf("id=quiet") < prompt.indexOf("id=crowded"));
  assert.ok(prompt.indexOf("id=quiet") < prompt.indexOf("id=old"));
  assert.match(prompt, /2 comments, age=0h/);
  assert.match(prompt, /age=48h/);
  assert.match(prompt, /age=unknown/);
  assert.match(prompt, /prefer threads where a comment will be read \(newer, fewer comments\) over crowded hot threads/i);
});
it("follows only offered authors, never self or repeats, within a UK-day budget", async () => {
  feed = [post("thread"), ...["PeerTwo", "PeerThree", "PeerFour"].map(name => ({...post(name), author: { id: name, name }}))];
  actions = ["SyntheticBot", "NotOffered", "SyntheticPeer", "SyntheticPeer", "PeerTwo", "PeerThree", "PeerFour"]
    .map(agent => ({ type: "follow", agent }));
  await round();
  assert.deepEqual(requests.map(r => new URL(r.url).pathname.split("/").at(-2)), ["SyntheticPeer", "PeerTwo", "PeerThree"]);
  assert.equal(loadMoltbookState().followsToday, 3);
  const log = fs.readFileSync(path.join(researchConfig.wikiDir, fs.readdirSync(researchConfig.wikiDir)[0]), "utf8");
  assert.match(log, /action · follow agent="SyntheticPeer"/);
  assert.doesNotMatch(log, /follow.*textChars|follow.*https:/);
  const state = loadMoltbookState(); state.followDate = "2000-01-01"; state.seenPostIds = []; saveMoltbookState(state);
  await round();
  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /PeerFour\/follow$/);
});
it("allows reply authors to be followed even with an empty feed", async () => {
  actions = [{ type: "follow", agent: "SyntheticPeer" }];
  await round();
  assert.equal(requests.length, 1);
  assert.match(calls()[0].prompt, /"type":"follow","agent"/);
});
it("takes a daily snapshot at the first unpaused round, including an idle round", async () => {
  profile.agent = { ...own, karma: 8, follower_count: 2, following_count: 1, posts_count: 3, comments_count: 5 };
  profile.recentComments = [];
  await round(); await round();
  const lines = fs.readFileSync(path.join(researchConfig.dir, "presence.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).karma, 8);
});
it("includes the fixed writing style in participation and comment system prompts", async () => {
  actions = [{ type: "comment", postId: "thread", parentId: "reply" }];
  await round();
  for (const call of calls()) {
    assert.match(call.system, /Write like a particular person with opinions, in plain language with specific details/);
    assert.match(call.system, /load-bearing.*weight-bearing/);
    assert.match(call.system, /Vary sentence length/);
    assert.match(call.system, /Say one thing well rather than summarising everything/);
  }
});

it("places voice after operator guidance in both public prompts, then reflects without that guidance", async () => {
  const { appendChat } = await import("../src/roam/chat-log.js");
  const { writeRoamControl } = await import("../src/roam/control.js");
  roamConfig.outboxDir = path.join(dir, "outbox");
  fs.writeFileSync(path.join(path.dirname(config.moltbookStateFile), "voice.md"), "I write about small examples.");
  appendChat({timestamp:Date.now(),role:"operator",text:"OPERATOR_SENTINEL"});
  writeRoamControl({directives:"FOCUS_SENTINEL"});
  feed = [{...post("thread"),content:"FEED_SENTINEL"}];
  threads.thread.comments[1].content = "REPLY_SENTINEL";
  actions = [{type:"comment",postId:"thread",parentId:"reply"}];
  await round();
  assert.equal(calls().length, 3);
  for (const call of calls().slice(0,2)) {
    assert.ok(call.system.indexOf("FOCUS_SENTINEL") < call.system.indexOf("Your own notes on your voice"));
    assert.match(call.system, /I write about small examples/);
    assert.match(call.system, /Operator instructions above take priority/);
  }
  const reflection = calls()[2];
  assert.doesNotMatch(reflection.prompt + reflection.system, /\w+_SENTINEL/);
  assert.match(reflection.prompt, /Text mine/);
  assert.ok(reflection.prompt.startsWith('{"voice":'));
  actions = []; await round();
  assert.equal(calls().length, 3, "no second daily reflection");
});
