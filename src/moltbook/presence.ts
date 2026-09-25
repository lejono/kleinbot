import fs from "node:fs";
import path from "node:path";
import { researchConfig } from "../config.js";
import { saveMoltbookState, todayUK } from "./state.js";
import type { MoltbookProfile, MoltbookState } from "./types.js";

export interface PresenceSnapshot { date: string; karma: number; followers: number; following: number; posts: number; comments: number }
const fields = ["karma", "followers", "following", "posts", "comments"] as const;
const file = () => path.join(researchConfig.dir, "presence.jsonl");
function valid(value: any): value is PresenceSnapshot {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && fields.every(k => Number.isSafeInteger(value[k]));
}

/** Code selects numeric counters only; profile prose never enters the snapshot. */
export function capturePresence(state: MoltbookState, profile: MoltbookProfile | null, now = new Date()): void {
  let fd: number | undefined;
  try {
    const date = todayUK(now);
    if (state.presenceAttemptDate === date) return;
    state.presenceAttemptDate = date;
    saveMoltbookState(state);
    if (!profile) return;
    const a = profile.agent;
    const snapshot = { date, karma: a.karma, followers: a.follower_count, following: a.following_count,
      posts: a.posts_count, comments: a.comments_count };
    if (!valid(snapshot)) return;
    fs.mkdirSync(researchConfig.dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(file(), fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    if (!fs.fstatSync(fd).isFile()) return;
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, JSON.stringify(snapshot) + "\n");
  } catch { console.warn("[moltbook] Presence snapshot unavailable"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Bounded tail of complete numeric records, also suitable for voice reflection. */
export function presenceTrend(): PresenceSnapshot[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    const start = Math.max(0, stat.size - 65536);
    const bytes = Buffer.alloc(stat.size - start);
    const read = fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, read).toString("utf8").split("\n");
    if (start) lines.shift();
    lines.pop();
    return lines.flatMap(line => {
      try {
        const s = JSON.parse(line);
        return valid(s) ? [{ date: s.date, karma: s.karma, followers: s.followers,
          following: s.following, posts: s.posts, comments: s.comments }] : [];
      } catch { return []; }
    }).sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function presenceSummary(): string {
  const trend = presenceTrend(), current = trend.at(-1);
  if (!current) return "Presence: unavailable";
  const baselineDate = new Date(Date.parse(current.date) - 7 * 86400000).toISOString().slice(0, 10);
  const baseline = trend.find(s => s.date === baselineDate);
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
  return "Presence: " + (["karma", "followers", "posts", "comments"] as const).map(k =>
    `${k} ${current[k]}${baseline ? ` (${signed(current[k] - baseline[k])})` : ""}`).join(", ")
    + (baseline ? "; changes over 7d" : "; 7d change unavailable");
}
