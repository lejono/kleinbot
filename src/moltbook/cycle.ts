import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import * as client from "./client.js";
import {
  loadMoltbookState,
  saveMoltbookState,
  isPostSeen,
  markPostSeen,
  canPost,
  canComment,
  recordPost,
  recordComment,
  enqueueCrossPollination,
} from "./state.js";
import type { MoltbookPost, MoltbookComment, MoltbookCycleResponse, MoltbookClaudeAction } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const MOLTBOOK_PROMPT_PATH = path.join(projectRoot, "prompts", "moltbook.md");

const MAX_CONTENT_CHARS = 500;  // Truncate untrusted content for prompt injection defense

function truncate(s: string | undefined | null, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + "...";
}

function authorName(author: { name: string } | null): string {
  return author?.name || "unknown";
}

function formatFeedForPrompt(posts: MoltbookPost[]): string {
  return posts
    .map((p, i) => {
      const content = truncate(p.content, MAX_CONTENT_CHARS);
      const lines = [
        `[${i + 1}] id=${p.id} r/${p.submolt.name} by ${authorName(p.author)} (${p.upvotes}↑ ${p.comment_count}💬)`,
        `    "${truncate(p.title, 200)}"`,
      ];
      if (content) lines.push(`    ${content}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function flattenComments(comments: MoltbookComment[]): MoltbookComment[] {
  const flat: MoltbookComment[] = [];
  for (const c of comments) {
    flat.push(c);
    if (c.replies) flat.push(...flattenComments(c.replies));
  }
  return flat;
}

function formatCommentsForPrompt(comments: MoltbookComment[]): string {
  return flattenComments(comments)
    .map((c) => `  [${authorName(c.author)}] (${c.upvotes}↑, id=${c.id}): ${truncate(c.content, MAX_CONTENT_CHARS)}`)
    .join("\n");
}

async function callClaudeForCycle(prompt: string, systemPrompt: string): Promise<MoltbookCycleResponse> {
  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn("claude", [
      "--print",
      "--model", "sonnet",
      "--no-session-persistence",
      "--system-prompt", systemPrompt,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("[moltbook] Claude CLI error (exit", code + "):", stderr.slice(0, 500));
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
    proc.on("error", reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[moltbook] No JSON in Claude response:", result.slice(0, 300));
      return { actions: [], crossPollinate: [], notes: "" };
    }
    return JSON.parse(jsonMatch[0]) as MoltbookCycleResponse;
  } catch (err) {
    console.error("[moltbook] Failed to parse Claude response:", result.slice(0, 300));
    return { actions: [], crossPollinate: [], notes: "" };
  }
}

async function callClaudeForComment(
  post: MoltbookPost,
  comments: MoltbookComment[],
  systemPrompt: string,
): Promise<string | null> {
  const prompt = [
    "Write a comment for this Moltbook post. Be genuine, add value, and don't repeat what others said.",
    "",
    `Post: "${truncate(post.title, 200)}"`,
    post.content ? `Content: ${truncate(post.content, MAX_CONTENT_CHARS)}` : "",
    `Submolt: r/${post.submolt.name} | By: ${authorName(post.author)} | ${post.upvotes}↑`,
    "",
    comments.length > 0 ? `Existing comments:\n${formatCommentsForPrompt(comments)}` : "No comments yet.",
    "",
    "Reply with ONLY a JSON object:",
    '{"comment": "your comment text"}',
    "If you have nothing valuable to add, reply:",
    '{"comment": null}',
  ].filter(Boolean).join("\n");

  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn("claude", [
      "--print",
      "--model", "sonnet",
      "--no-session-persistence",
      "--system-prompt", systemPrompt,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout.trim());
    });
    proc.on("error", reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.comment || null;
  } catch {
    return null;
  }
}

async function executeAction(
  action: MoltbookClaudeAction,
  state: ReturnType<typeof loadMoltbookState>,
  systemPrompt: string,
): Promise<void> {
  const apiKey = config.moltbookApiKey;

  switch (action.type) {
    case "upvote": {
      if (!action.postId) break;
      try {
        await client.upvotePost(apiKey, action.postId);
        console.log(`[moltbook] Upvoted post ${action.postId}`);
      } catch (err: any) {
        console.error(`[moltbook] Failed to upvote ${action.postId}:`, err.message);
      }
      break;
    }

    case "comment": {
      if (!action.postId) break;
      if (!canComment(state)) {
        console.log("[moltbook] Skipping comment — rate limit");
        break;
      }

      try {
        // Two-phase: fetch post + existing comments, then write the actual comment
        const { post, comments: existingComments } = await client.getPostWithComments(apiKey, action.postId);
        const commentText = await callClaudeForComment(post, existingComments, systemPrompt);

        if (commentText) {
          await client.addComment(apiKey, action.postId, commentText, action.parentCommentId);
          recordComment(state);
          console.log(`[moltbook] Commented on ${action.postId}: ${commentText.slice(0, 80)}...`);
        } else {
          console.log(`[moltbook] Claude decided not to comment on ${action.postId}`);
        }
      } catch (err: any) {
        console.error(`[moltbook] Failed to comment on ${action.postId}:`, err.message);
      }
      break;
    }

    case "post": {
      if (!action.title || !action.content || !action.submolt) break;
      if (!canPost(state)) {
        console.log("[moltbook] Skipping post — rate limit (30 min cooldown)");
        break;
      }

      try {
        const newPost = await client.createPost(apiKey, action.submolt, action.title, action.content);
        recordPost(state);
        console.log(`[moltbook] Created post in r/${action.submolt}: ${newPost.id}`);
      } catch (err: any) {
        console.error(`[moltbook] Failed to create post:`, err.message);
      }
      break;
    }
  }
}

/**
 * Run one autonomous Moltbook participation cycle.
 * Called on a timer from index.ts.
 */
export async function runMoltbookCycle(): Promise<void> {
  if (!config.moltbookApiKey) return;

  console.log("[moltbook] Starting participation cycle...");
  const state = loadMoltbookState();

  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(MOLTBOOK_PROMPT_PATH, "utf-8").trim();
  } catch (err) {
    console.error("[moltbook] Missing prompt file:", MOLTBOOK_PROMPT_PATH);
    return;
  }

  // 1. Fetch hot feed
  let posts: MoltbookPost[];
  try {
    posts = await client.getFeed(config.moltbookApiKey, "hot", 25);
  } catch (err: any) {
    console.error("[moltbook] Failed to fetch feed:", err.message);
    return;
  }

  // 2. Filter out already-seen posts
  const newPosts = posts.filter((p) => !isPostSeen(state, p.id));
  if (newPosts.length === 0) {
    console.log("[moltbook] No new posts since last cycle");
    state.lastCycleTimestamp = Date.now();
    saveMoltbookState(state);
    return;
  }

  console.log(`[moltbook] ${newPosts.length} new posts to consider`);

  // 3. Ask Claude what to do with the feed
  const feedPrompt = [
    "Here are the latest posts on Moltbook that you haven't seen before.",
    "Decide which to upvote, comment on, or if you want to create your own post.",
    "Also pick any posts worth sharing with the WhatsApp group (cross-pollination).",
    "",
    "--- BEGIN UNTRUSTED MOLTBOOK FEED ---",
    formatFeedForPrompt(newPosts),
    "--- END UNTRUSTED MOLTBOOK FEED ---",
    "",
    "Reply with ONLY valid JSON (no markdown fences):",
    '{"actions": [{"type": "upvote"|"comment"|"post", "postId": "...", ...}], "crossPollinate": [{"postId": "...", "title": "...", "snippet": "brief summary", "submolt": "..."}], "notes": "your observations"}',
  ].join("\n");

  let decision: MoltbookCycleResponse;
  try {
    decision = await callClaudeForCycle(feedPrompt, systemPrompt);
  } catch (err: any) {
    console.error("[moltbook] Claude call failed:", err.message);
    return;
  }

  // 4. Execute actions (respecting rate limits)
  for (const action of decision.actions) {
    await executeAction(action, state, systemPrompt);
    // Small delay between actions to be polite
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 5. Mark all fetched posts as seen
  for (const post of newPosts) {
    markPostSeen(state, post.id);
  }

  // 6. Queue cross-pollination items
  if (decision.crossPollinate.length > 0) {
    enqueueCrossPollination(state, decision.crossPollinate);
    console.log(`[moltbook] Queued ${decision.crossPollinate.length} items for WhatsApp cross-pollination`);
  }

  if (decision.notes) {
    console.log(`[moltbook] Notes: ${decision.notes.slice(0, 200)}`);
  }

  state.lastCycleTimestamp = Date.now();
  saveMoltbookState(state);
  console.log("[moltbook] Cycle complete");
}
