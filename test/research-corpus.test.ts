import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initConfig, researchConfig } from "../src/config.js";
import { capturePosts, captureComments, captureMoltbookFeed } from "../src/research/corpus.js";
import type { MoltbookPost } from "../src/moltbook/types.js";

const syntheticPost = (id: string): MoltbookPost => ({ id, title: "Synthetic post", content: "Synthetic content",
  created_at: "2026-01-01", author: null, submolt: { id: "test", name: "test", display_name: "Test" },
  upvotes: 0, downvotes: 0, comment_count: 0 });

for (const [label, contents] of [["missing", undefined], ["truncated", '["old"'], ["malformed", "invalid"],
  ["object", "{}"], ["null", "null"], ["string", '"old"']] as const) {
  it(`rebuilds a ${label} seen file from platform posts across months`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-recovery-"));
    const original = { ...researchConfig };
    researchConfig.dir = dir;
    try {
      const record = (id: string, platform = "moltbook", type = "post") => JSON.stringify({ type, platform, id });
      fs.writeFileSync(path.join(dir, "moltbook-2026-01.jsonl"), [record("old"), "broken line", "null",
        record("comment-only", "moltbook", "comments"), record("foreign", "other")].join("\n") + "\n");
      fs.writeFileSync(path.join(dir, "moltbook-2026-02.jsonl"), record("recent") + "\n");
      fs.writeFileSync(path.join(dir, "other-2026-01.jsonl"), record("other-file", "other") + "\n");
      const seenFile = path.join(dir, "moltbook-seen.json");
      if (contents !== undefined) fs.writeFileSync(seenFile, contents);
      const log = t.mock.method(console, "error", () => {});
      const posts = ["old", "recent", "new", "comment-only", "foreign", "other-file"].map(syntheticPost);
      const now = new Date("2026-03-01T00:00:00Z");
      assert.deepEqual(capturePosts("moltbook", posts, now).map(p => p.id), ["new", "comment-only", "foreign", "other-file"]);
      assert.equal(log.mock.callCount(), 1);
      assert.match(log.mock.calls[0].arguments.join(" "), /Rebuilt.*seen/);
      assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, "utf8")).sort(), posts.map(p => p.id).sort());
      assert.deepEqual(capturePosts("moltbook", posts, now), []);
      assert.equal(log.mock.callCount(), 1);
      assert.equal(fs.readFileSync(path.join(dir, "moltbook-2026-03.jsonl"), "utf8").trim().split("\n").length, 4);
      assert.equal(fs.statSync(seenFile).mode & 0o777, 0o600);
    } finally {
      Object.assign(researchConfig, original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

it("replaces the seen file atomically and preserves it if rename fails", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-atomic-"));
  const original = { ...researchConfig };
  researchConfig.dir = dir;
  try {
    const seenFile = path.join(dir, "moltbook-seen.json");
    fs.writeFileSync(seenFile, '["old"]\n', { mode: 0o600 });
    const rename = fs.renameSync;
    let fail = false;
    const replacement = t.mock.method(fs, "renameSync", (from, to) => {
      assert.equal(to, seenFile);
      assert.equal(path.dirname(String(from)), dir);
      assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, "utf8")), fail ? ["old", "new"] : ["old"]);
      assert.deepEqual(JSON.parse(fs.readFileSync(from, "utf8")), fail ? ["old", "new", "later"] : ["old", "new"]);
      assert.equal(fs.statSync(from).mode & 0o777, 0o600);
      if (fail) throw new Error("Synthetic rename failure");
      rename(from, to);
    });
    capturePosts("moltbook", [syntheticPost("new")]);
    assert.equal(replacement.mock.callCount(), 1);
    fail = true;
    assert.throws(() => capturePosts("moltbook", [syntheticPost("later")]), /Synthetic rename failure/);
    assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, "utf8")), ["old", "new"]);
    assert.equal(fs.readdirSync(dir).some(f => f.endsWith(".tmp")), false);
  } finally {
    Object.assign(researchConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("captures full posts once, rotates months, flattens comments and caps fetching", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-test-"));
  const original = { ...researchConfig };
  initConfig("signal");
  Object.assign(researchConfig, { dir: path.join(dir, "research"), capture: true, maxCommentFetch: 2 });
  const post = (id: string, count = 0): MoltbookPost => ({ id, title: "Example", content: "x".repeat(800),
    created_at: "2026-01-01", author: null, submolt: { id: "test", name: "test", display_name: "Test" },
    upvotes: 0, downvotes: 0, comment_count: count });
  const jan = new Date("2026-01-31T23:59:00Z"), feb = new Date("2026-02-01T00:00:00Z");
  try {
    assert.equal(capturePosts("moltbook", [post("a"), post("a")], jan).length, 1);
    assert.equal(capturePosts("moltbook", [post("a"), post("b")], feb).length, 1);
    const file = path.join(researchConfig.dir, "moltbook-2026-01.jsonl");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).content.length, 800);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(researchConfig.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(researchConfig.dir, "moltbook-seen.json")).mode & 0o777, 0o600);
    const c = { id: "c", content: "Comment", upvotes: 1, downvotes: 0, created_at: "", parent_id: null, author: null };
    captureComments("moltbook", "a", [{ ...c, replies: [{ ...c, id: "d" }] }], jan);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(s => JSON.parse(s));
    assert.equal(lines[1].comments[1].parentId, "c");
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ comments: [] }));
    });
    await captureMoltbookFeed([post("c", 2), post("d", 8), post("e", 5)], feb);
    assert.deepEqual(requests.map(url => url.split("/").at(-1)), ["d", "e"]);
    await captureMoltbookFeed([post("c"), post("d")], feb);
    assert.equal(requests.length, 2);
    researchConfig.dir = file;
    await assert.doesNotReject(captureMoltbookFeed([post("f")], feb));
    researchConfig.capture = false;
    await assert.doesNotReject(captureMoltbookFeed([post("g")], feb));
    assert.equal(requests.length, 2);
  } finally {
    Object.assign(researchConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
