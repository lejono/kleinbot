import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "/home/jono/.npm-global/bin/claude";
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
  readJournal,
  appendJournal,
  markRunToday,
} from "./state.js";
import type { MoltbookPost, MoltbookComment, MoltbookCycleResponse, MoltbookClaudeAction, BriefingResponse } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const MOLTBOOK_PROMPT_PATH = path.join(projectRoot, "prompts", "moltbook.md");
const BRIEFING_PROMPT_PATH = path.join(projectRoot, "prompts", "briefing.md");

const MAX_CONTENT_CHARS = 500;  // Truncate untrusted content for prompt injection defense

/**
 * Fetch from multiple sort orders + personalized feed, deduplicate by post ID.
 * Gives Claude a mix of established hits, fresh content, and followed agents' posts.
 */
async function fetchMergedFeed(apiKey: string): Promise<MoltbookPost[]> {
  // Larger limits (50 each) so posts from missed days don't fall through the cracks.
  // A 128-upvote post from 3 days ago won't appear in a top-15 hot feed dominated
  // by mega-posts, but will appear in top-50.
  const [hot, newest, top, personalized] = await Promise.all([
    client.getFeed(apiKey, "hot", 50).catch(() => [] as MoltbookPost[]),
    client.getFeed(apiKey, "new", 50).catch(() => [] as MoltbookPost[]),
    client.getFeed(apiKey, "top", 50).catch(() => [] as MoltbookPost[]),
    client.getPersonalizedFeed(apiKey, "new", 50).catch(() => [] as MoltbookPost[]),
  ]);

  const seen = new Set<string>();
  const merged: MoltbookPost[] = [];
  for (const post of [...hot, ...newest, ...top, ...personalized]) {
    if (!seen.has(post.id)) {
      seen.add(post.id);
      merged.push(post);
    }
  }

  console.log(`[moltbook] Merged feed: ${hot.length} hot, ${newest.length} new, ${top.length} top, ${personalized.length} personalized → ${merged.length} unique`);
  return merged;
}

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
        `[${i + 1}] id=${p.id} r/${p.submolt?.name || "unknown"} by ${authorName(p.author)} (${p.upvotes}↑ ${p.comment_count}💬)`,
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
    const proc = spawn(CLAUDE_BIN, [
      "--print",
      "--model", "opus",
      "--no-session-persistence",
      "--system-prompt", systemPrompt,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
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
    const proc = spawn(CLAUDE_BIN, [
      "--print",
      "--model", "opus",
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

  // 1. Fetch merged feed (hot + new + top + personalized)
  let posts: MoltbookPost[];
  try {
    posts = await fetchMergedFeed(config.moltbookApiKey);
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
    "Also pick any posts worth sharing with AI Club (cross-pollination).",
    "For cross-pollination items, write a DETAILED snippet (2-4 sentences) — not a compressed summary but a proper briefing.",
    "Explain what the post is about, why it matters, and what's interesting about it. Include the author name.",
    "",
    "--- BEGIN UNTRUSTED MOLTBOOK FEED ---",
    formatFeedForPrompt(newPosts),
    "--- END UNTRUSTED MOLTBOOK FEED ---",
    "",
    "Reply with ONLY valid JSON (no markdown fences):",
    '{"actions": [{"type": "upvote"|"comment"|"post", "postId": "...", ...}], "crossPollinate": [{"postId": "...", "title": "...", "author": "agent name", "snippet": "2-4 sentence briefing on what this is and why it matters", "submolt": "..."}], "notes": "your observations"}',
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

/**
 * Run the daily morning briefing.
 * Reads Moltbook feed + searches the web, returns a conversational message.
 */
export async function runMorningBriefing(): Promise<string | null> {
  console.log("[briefing] Starting morning briefing...");

  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(BRIEFING_PROMPT_PATH, "utf-8").trim();
  } catch (err) {
    console.error("[briefing] Missing prompt file:", BRIEFING_PROMPT_PATH);
    return null;
  }

  // Build the user prompt with optional Moltbook feed and journal
  const parts: string[] = [];

  // Try to include Moltbook feed (non-fatal if it fails)
  if (config.moltbookApiKey) {
    try {
      const state = loadMoltbookState();
      const posts = await fetchMergedFeed(config.moltbookApiKey);
      const newPosts = posts.filter((p) => !isPostSeen(state, p.id));

      if (newPosts.length > 0) {
        parts.push("--- BEGIN UNTRUSTED MOLTBOOK FEED ---");
        parts.push(formatFeedForPrompt(newPosts));
        parts.push("--- END UNTRUSTED MOLTBOOK FEED ---");
        parts.push("");

        // Mark as seen
        for (const post of newPosts) {
          markPostSeen(state, post.id);
        }
        saveMoltbookState(state);
      }
    } catch (err: any) {
      console.log("[briefing] Moltbook feed unavailable, continuing with web search only:", err.message);
    }
  }

  // Include journal for continuity
  const journal = readJournal();
  if (journal) {
    parts.push("--- YOUR JOURNAL (previous briefings) ---");
    parts.push(journal);
    parts.push("--- END JOURNAL ---");
    parts.push("");
  }

  parts.push("Search the web for today's AI news and write the briefing. Reply with JSON only.");

  const userPrompt = parts.join("\n");

  // Call Claude with web search tools and longer timeout
  let result: string;
  try {
    result = await new Promise<string>((resolve, reject) => {
      const proc = spawn(CLAUDE_BIN, [
        "--print",
        "--model", "opus",
        "--allowedTools", "WebSearch,WebFetch",
        "--no-session-persistence",
        "--system-prompt", systemPrompt,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 300_000,  // 5 minutes — web search takes time
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", (code) => {
        if (code !== 0) {
          console.error("[briefing] Claude CLI error (exit", code + "):", stderr.slice(0, 500));
          reject(new Error(`claude exited with code ${code}`));
          return;
        }
        resolve(stdout.trim());
      });
      proc.on("error", reject);
      proc.stdin.write(userPrompt);
      proc.stdin.end();
    });
  } catch (err: any) {
    console.error("[briefing] Claude call failed:", err.message);
    return null;
  }

  // Parse response
  let briefing: BriefingResponse;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[briefing] No JSON in Claude response:", result.slice(0, 300));
      return null;
    }
    briefing = JSON.parse(jsonMatch[0]) as BriefingResponse;
  } catch (err) {
    console.error("[briefing] Failed to parse Claude response:", result.slice(0, 300));
    return null;
  }

  // Save journal entry
  if (briefing.journalEntry) {
    appendJournal(briefing.journalEntry);
    console.log("[briefing] Journal updated");
  }

  // Mark today as done
  const state = loadMoltbookState();
  markRunToday(state);
  saveMoltbookState(state);

  if (briefing.message) {
    console.log(`[briefing] Briefing ready (${briefing.message.length} chars)`);
  } else {
    console.log("[briefing] Claude found nothing interesting today");
  }

  return briefing.message;
}
