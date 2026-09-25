import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, modelConfig, moltbookPresenceConfig, researchConfig } from "../config.js";
import { containsConfiguredSecret } from "./egress.js";
import { callModel } from "./model-call.js";
import { presenceTrend } from "./presence.js";
import { saveMoltbookState, todayUK } from "./state.js";
import { canWriteOutbox, writeOutboxMessage } from "../roam/outbox.js";
import type { MoltbookProfile, MoltbookState } from "./types.js";

const voiceFile = () => path.join(dataDir, "voice.md");
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
const cap = (text: string) => clean(text).slice(0, moltbookPresenceConfig.voiceMaxChars);

export function readVoice(): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(voiceFile(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return "";
    const bytes = Buffer.alloc(Math.min(stat.size, moltbookPresenceConfig.voiceMaxChars * 4));
    const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const value = cap(bytes.subarray(0, read).toString("utf8"));
    return containsConfiguredSecret(value) ? "" : value;
  } catch { return ""; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function replaceVoice(text: string): void {
  if (containsConfiguredSecret(text)) throw new Error("Voice refused");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temp = path.join(dataDir, `voice-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, voiceFile());
  } finally { fs.rmSync(temp, { force: true }); }
}

function archiveVoice(previous: string, now: Date): void {
  if (!previous) return;
  if (containsConfiguredSecret(previous)) throw new Error("Voice history refused");
  const fd = fs.openSync(path.join(dataDir, "voice-history.md"), fs.constants.O_APPEND | fs.constants.O_WRONLY
    | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Invalid voice history");
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `## ${todayUK(now)}\n${previous}\n\n`);
  } finally { fs.closeSync(fd); }
}

/** Write research-wiki/voice-history.md: the current notes, then every earlier version, newest first. */
export function writeVoiceHistoryPage(now = new Date()): string | undefined {
  let history = "";
  try {
    const fd = fs.openSync(path.join(dataDir, "voice-history.md"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (stat.isFile()) {
        const bytes = Buffer.alloc(Math.min(stat.size, 200_000));
        history = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length))).toString("utf8");
      }
    } finally { fs.closeSync(fd); }
  } catch { /* No history yet. */ }
  const earlier = history.split(/^(?=## \d{4}-\d{2}-\d{2}\n)/m).map(e => e.trim()).filter(e => /^## \d{4}-\d{2}-\d{2}\n/.test(e)).reverse()
    .map(e => e.replace(/^## (\S+)/, "### Until $1"));
  const current = readVoice();
  const text = `# Voice notes history\n\nWritten by the bot about its own voice; newest first.\n\n## Current (${todayUK(now)})\n\n${current || "No voice notes yet."}\n\n## Earlier versions\n\n${earlier.join("\n\n") || "None yet."}\n`;
  if (containsConfiguredSecret(text)) return;
  fs.mkdirSync(researchConfig.wikiDir, { recursive: true, mode: 0o700 });
  const temp = path.join(researchConfig.wikiDir, `voice-history-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, path.join(researchConfig.wikiDir, "voice-history.md"));
  } finally { fs.rmSync(temp, { force: true }); }
  return "voice-history.md";
}

export function resetVoice(now = new Date()): void {
  archiveVoice(readVoice(), now);
  replaceVoice("");
}

export function voiceContext(): string {
  const voice = readVoice();
  return voice ? "\n\nYour own notes on your voice (written by you from your own posts). Operator instructions above take priority.\n" + voice : "";
}

/** Select only profile-scoped own text and numbers. Never spread profile objects into model input. */
function ownWriting(profile: MoltbookProfile, now: number) {
  const numeric = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : undefined;
  return [...profile.recentPosts.map(p => ({ created: p.created_at, author: p.author,
    text: `${p.title || ""}\n${p.content ?? p.content_preview ?? ""}`, upvotes: p.upvotes, replyCount: p.comment_count })),
  ...profile.recentComments.map(c => ({ created: c.created_at, author: c.author, text: c.content,
    upvotes: c.upvotes, replyCount: c.reply_count }))]
    .filter(w => (!w.author || w.author.id === profile.agent.id) && typeof w.text === "string"
      && Date.parse(w.created) <= now && Date.parse(w.created) >= now - 7 * 86400000)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 40)
    .map(w => ({ text: clean(w.text).slice(0, 2000), upvotes: numeric(w.upvotes), replyCount: numeric(w.replyCount) }));
}

const REFLECTION_PROMPT = "These are your notes on your own voice and interests on this platform. "
  + "Revise them from how your own writing went: what you want to sound like, what you keep coming back to, what you want to try. "
  + "Short, first person, no rules about other files or settings. "
  + 'Reply only with JSON {"voice":string,"changed":boolean}.';

/** This writer has no access to feed, replies, corpus, wiki or operator conversation. */
export async function reflectVoice(state: MoltbookState, profile: MoltbookProfile | null, now = new Date()): Promise<void> {
  try {
    const date = todayUK(now);
    if (state.voiceAttemptDate === date) return;
    state.voiceAttemptDate = date;
    saveMoltbookState(state); // Claim before any call, including failed attempts.
    // Codex's existing read-only sandbox still allows file reads, even for tools: none.
    // Until that backend can enforce isolation, it must never author trusted voice notes.
    if (modelConfig.moltbookBackend !== "claude") {
      console.warn("[moltbook] Voice reflection requires a backend that enforces no tools");
      return;
    }
    if (!profile) return;
    const writing = ownWriting(profile, now.getTime());
    if (!writing.length || !canWriteOutbox("research")) return;
    const previous = readVoice();
    const result = await callModel({ step: "voice", backend: modelConfig.moltbookBackend, model: modelConfig.moltbookModel,
      tools: "none", timeoutMs: modelConfig.cycleTimeoutMs, systemPrompt: REFLECTION_PROMPT,
      prompt: JSON.stringify({ voice: previous, writing, presence: presenceTrend() }) });
    const response = JSON.parse(result.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    if (response?.changed !== true || typeof response.voice !== "string" || containsConfiguredSecret(response.voice)) return;
    const next = cap(response.voice);
    if (!next || next === previous || containsConfiguredSecret(next)) return;
    archiveVoice(previous, now);
    replaceVoice(next);
    // A failed publication must not leave an unannounced change in trusted context.
    if (writeOutboxMessage("research", "Voice notes updated: " + next) !== "published") replaceVoice(previous);
  } catch { console.warn("[moltbook] Voice reflection unavailable"); }
}
