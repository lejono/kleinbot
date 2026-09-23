import fs from "fs";
import path from "path";
import { config, crossPollinationQueueLimit } from "../config.js";
import type { MoltbookState, MoltbookCrossPollination } from "./types.js";

const MAX_JOURNAL_CHARS = 8000;

function getJournalPath(): string {
  return path.join(path.dirname(config.moltbookStateFile), "moltbook-journal.md");
}

const MAX_SEEN_POSTS = 500;
const MAX_COMMENT_TIMESTAMPS = 100;
export const MORNING_BRIEFING_RETRY_MS = 6 * 60 * 60 * 1000;
export const MORNING_BRIEFING_MAX_ATTEMPTS_PER_DAY = 2;
const MORNING_BRIEFING_LOCK_STALE_MS = 10 * 60 * 1000;

// Rate limits (matching Moltbook API)
const POST_COOLDOWN_MS = 30 * 60 * 1000;   // 1 post per 30 minutes
const COMMENT_WINDOW_MS = 60 * 60 * 1000;  // 50 comments per hour
const MAX_COMMENTS_PER_HOUR = 50;
const MORNING_BRIEFING_HOUR_UK = 5;
const MORNING_BRIEFING_MINUTE_UK = 30;

function defaultState(): MoltbookState {
  return {
    seenPostIds: [],
    lastCycleTimestamp: 0,
    lastCycleAttemptAt: 0,
    crossPollinationQueue: [],
    lastPostTimestamp: 0,
    commentTimestamps: [],
    lastRunDate: "",
    briefingAttemptDate: "",
    briefingAttemptCount: 0,
    briefingLastAttemptAt: 0,
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
  state.crossPollinationQueue = [...state.crossPollinationQueue, ...items].slice(-crossPollinationQueueLimit);
}

export function drainCrossPollination(
  state: MoltbookState,
): MoltbookCrossPollination[] {
  const items = state.crossPollinationQueue;
  state.crossPollinationQueue = [];
  return items;
}

// --- Morning briefing helpers ---

function todayUK(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function ukHourMinute(now = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function isAtOrAfterBriefingTime(now = new Date()): boolean {
  const { hour, minute } = ukHourMinute(now);
  return hour > MORNING_BRIEFING_HOUR_UK
    || (hour === MORNING_BRIEFING_HOUR_UK && minute >= MORNING_BRIEFING_MINUTE_UK);
}

export function hasRunToday(state: MoltbookState, now = new Date()): boolean {
  return state.lastRunDate === todayUK(now);
}

export function isMorningBriefingDue(state: MoltbookState, now = new Date()): boolean {
  const today = todayUK(now);
  if (state.lastRunDate === today || !isAtOrAfterBriefingTime(now)) return false;

  const attemptsToday = state.briefingAttemptDate === today
    ? state.briefingAttemptCount
    : 0;
  if (attemptsToday === 0) return true;
  if (attemptsToday >= MORNING_BRIEFING_MAX_ATTEMPTS_PER_DAY) return false;

  return now.getTime() - state.briefingLastAttemptAt >= MORNING_BRIEFING_RETRY_MS;
}

export function recordMorningBriefingAttempt(state: MoltbookState, now = new Date()): void {
  const today = todayUK(now);
  if (state.briefingAttemptDate !== today) {
    state.briefingAttemptDate = today;
    state.briefingAttemptCount = 0;
  }
  state.briefingAttemptCount += 1;
  state.briefingLastAttemptAt = now.getTime();
  delete state.briefingLastError;
}

export function recordMorningBriefingFailure(state: MoltbookState, error: unknown): void {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);
  state.briefingLastError = (message || "unknown error").slice(0, 500);
}

function acquireBriefingLock(now: Date): { fd: number; path: string } | null {
  const lockPath = `${config.moltbookStateFile}.briefing.lock`;
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid} ${now.toISOString()}\n`);
    return { fd, path: lockPath };
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;

    try {
      const stat = fs.statSync(lockPath);
      if (now.getTime() - stat.mtimeMs < MORNING_BRIEFING_LOCK_STALE_MS) return null;
      fs.unlinkSync(lockPath);
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid} ${now.toISOString()}\n`);
      return { fd, path: lockPath };
    } catch {
      return null;
    }
  }
}

export function claimMorningBriefingAttempt(now = new Date()): MoltbookState | null {
  const lock = acquireBriefingLock(now);
  if (!lock) return null;

  try {
    const state = loadMoltbookState();
    if (!isMorningBriefingDue(state, now)) return null;
    recordMorningBriefingAttempt(state, now);
    saveMoltbookState(state);
    return state;
  } finally {
    fs.closeSync(lock.fd);
    try {
      fs.unlinkSync(lock.path);
    } catch {
      // Another process may have already cleaned up a stale lock.
    }
  }
}

export function markRunToday(state: MoltbookState, now = new Date()): void {
  state.lastRunDate = todayUK(now);
  state.briefingAttemptDate = "";
  state.briefingAttemptCount = 0;
  state.briefingLastAttemptAt = 0;
  delete state.briefingLastError;
}

export function readJournal(): string {
  try {
    return fs.readFileSync(getJournalPath(), "utf-8");
  } catch {
    return "";
  }
}

export function appendJournal(entry: string): void {
  const existing = readJournal();
  const dated = `## ${todayUK()}\n${entry}\n\n`;
  let updated = existing + dated;

  // Trim from the front if over budget
  while (updated.length > MAX_JOURNAL_CHARS) {
    const idx = updated.indexOf("\n## ", 1);
    if (idx === -1) break;
    updated = updated.slice(idx + 1);
  }

  fs.writeFileSync(getJournalPath(), updated);
}

export function isCycleDue(state: MoltbookState, now: number, intervalMs: number): boolean {
  return !state.lastCycleAttemptAt || now - state.lastCycleAttemptAt >= intervalMs;
}

export function recordCycleAttempt(state: MoltbookState, now: number): void {
  state.lastCycleAttemptAt = now;
}
