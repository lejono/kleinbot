import fs from "fs";
import { config } from "../config.js";
import type { MoltbookState, MoltbookCrossPollination } from "./types.js";

const MAX_SEEN_POSTS = 500;
const MAX_COMMENT_TIMESTAMPS = 100;

// Rate limits (matching Moltbook API)
const POST_COOLDOWN_MS = 30 * 60 * 1000;   // 1 post per 30 minutes
const COMMENT_WINDOW_MS = 60 * 60 * 1000;  // 50 comments per hour
const MAX_COMMENTS_PER_HOUR = 50;

function defaultState(): MoltbookState {
  return {
    seenPostIds: [],
    lastCycleTimestamp: 0,
    crossPollinationQueue: [],
    lastPostTimestamp: 0,
    commentTimestamps: [],
  };
}

export function loadMoltbookState(): MoltbookState {
  try {
    const raw = fs.readFileSync(config.moltbookStateFile, "utf-8");
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function saveMoltbookState(state: MoltbookState): void {
  // Trim seen posts to prevent unbounded growth
  if (state.seenPostIds.length > MAX_SEEN_POSTS) {
    state.seenPostIds = state.seenPostIds.slice(-MAX_SEEN_POSTS);
  }
  // Trim old comment timestamps
  const now = Date.now();
  state.commentTimestamps = state.commentTimestamps.filter(
    (t) => now - t < COMMENT_WINDOW_MS,
  );
  if (state.commentTimestamps.length > MAX_COMMENT_TIMESTAMPS) {
    state.commentTimestamps = state.commentTimestamps.slice(-MAX_COMMENT_TIMESTAMPS);
  }
  fs.writeFileSync(config.moltbookStateFile, JSON.stringify(state, null, 2) + "\n");
}

export function isPostSeen(state: MoltbookState, postId: string): boolean {
  return state.seenPostIds.includes(postId);
}

export function markPostSeen(state: MoltbookState, postId: string): void {
  if (!state.seenPostIds.includes(postId)) {
    state.seenPostIds.push(postId);
  }
}

export function canPost(state: MoltbookState): boolean {
  return Date.now() - state.lastPostTimestamp >= POST_COOLDOWN_MS;
}

export function canComment(state: MoltbookState): boolean {
  const now = Date.now();
  const recentComments = state.commentTimestamps.filter(
    (t) => now - t < COMMENT_WINDOW_MS,
  );
  return recentComments.length < MAX_COMMENTS_PER_HOUR;
}

export function recordPost(state: MoltbookState): void {
  state.lastPostTimestamp = Date.now();
}

export function recordComment(state: MoltbookState): void {
  state.commentTimestamps.push(Date.now());
}

export function enqueueCrossPollination(
  state: MoltbookState,
  items: MoltbookCrossPollination[],
): void {
  state.crossPollinationQueue.push(...items);
}

export function drainCrossPollination(
  state: MoltbookState,
): MoltbookCrossPollination[] {
  const items = state.crossPollinationQueue;
  state.crossPollinationQueue = [];
  return items;
}
