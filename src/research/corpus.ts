import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, researchConfig } from "../config.js";
import { getPostWithComments } from "../moltbook/client.js";
import type { MoltbookPost, MoltbookComment } from "../moltbook/types.js";

export interface PostRecord {
  type: "post"; platform: string; id: string; capturedAt: string; createdAt: string;
  title: string; content: string; author: string; submolt: string;
  upvotes: number; commentCount: number;
}

function logPath(platform: string, now: Date): string {
  if (!/^[a-z][a-z0-9-]*$/.test(platform)) throw new Error("Invalid platform");
  fs.mkdirSync(researchConfig.dir, { recursive: true, mode: 0o700 });
  return path.join(researchConfig.dir, `${platform}-${now.toISOString().slice(0, 7)}.jsonl`);
}

function loadSeen(platform: string, seenFile: string): Set<string> {
  try {
    const ids = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    if (Array.isArray(ids)) return new Set(ids);
  } catch (err: any) {
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
  }
  const seen = new Set<string>();
  for (const file of fs.readdirSync(researchConfig.dir).filter(f => f.startsWith(`${platform}-`) && f.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(researchConfig.dir, file), "utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record?.type === "post" && record.platform === platform && typeof record.id === "string") seen.add(record.id);
      } catch { /* Ignore incomplete or malformed corpus lines while rebuilding. */ }
    }
  }
  console.error("[research] Rebuilt seen ids from corpus");
  return seen;
}

export function capturePosts(platform: string, posts: MoltbookPost[], now = new Date()): MoltbookPost[] {
  const file = logPath(platform, now);
  const seenFile = path.join(researchConfig.dir, `${platform}-seen.json`);
  const seen = loadSeen(platform, seenFile);
  const captured: MoltbookPost[] = [];
  for (const post of posts) {
    if (seen.has(post.id)) continue;
    const record: PostRecord = {
      type: "post", platform, id: post.id, capturedAt: now.toISOString(), createdAt: post.created_at,
      title: post.title, content: post.content || "", author: post.author?.name || "unknown",
      submolt: post.submolt?.name || "unknown", upvotes: post.upvotes, commentCount: post.comment_count,
    };
    fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    seen.add(post.id);
    captured.push(post);
  }
  const temp = `${seenFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify([...seen]) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, seenFile);
  } finally { fs.rmSync(temp, { force: true }); }
  return captured;
}

export function captureComments(platform: string, postId: string, comments: MoltbookComment[], now = new Date()): void {
  const flat: { id: string; author: string; content: string; upvotes: number; parentId: string | null }[] = [];
  function visit(tree: MoltbookComment[], parentId: string | null = null): void {
    for (const c of tree) {
      flat.push({ id: c.id, author: c.author?.name || "unknown", content: c.content, upvotes: c.upvotes, parentId: c.parent_id ?? parentId });
      visit(c.replies || [], c.id);
    }
  }
  visit(comments);
  fs.appendFileSync(logPath(platform, now), JSON.stringify({
    type: "comments", platform, postId, capturedAt: now.toISOString(), comments: flat,
  }) + "\n", { mode: 0o600 });
}

export async function captureMoltbookFeed(posts: MoltbookPost[], now = new Date()): Promise<{ captured: number; commentTrees: number }> {
  const counts = { captured: 0, commentTrees: 0 };
  if (!researchConfig.capture) return counts;
  try {
    const captured = capturePosts("moltbook", posts, now);
    counts.captured = captured.length;
    const selected = captured.sort((a, b) => b.comment_count - a.comment_count)
      .slice(0, Math.max(0, researchConfig.maxCommentFetch));
    for (const post of selected) {
      try {
        const { comments } = await getPostWithComments(config.moltbookApiKey, post.id);
        captureComments("moltbook", post.id, comments, now);
        counts.commentTrees++;
      } catch {
        console.error("[research] Comment capture failed");
      }
    }
  } catch {
    console.error("[research] Post capture failed");
  }
  return counts;
}
