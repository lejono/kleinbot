import { warnShortConfiguredSecrets } from "./moltbook/egress.js";
import { config as loadEnv } from "dotenv";
import path from "path";
import os from "node:os";
import { fileURLToPath } from "url";
import type { Config } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");

// Runtime data/config lives outside the repo at ~/team/kleinbot/
export const runtimeDir = process.env.KLEINBOT_RUNTIME_DIR || path.join(process.env.HOME || "/home/user", "team", "kleinbot");
export const dataDir = path.join(runtimeDir, "data");
export const promptsDir = path.join(runtimeDir, "prompts");

loadEnv({ path: path.join(runtimeDir, "config", ".env") });

export const tempDir = process.env.KLEINBOT_TEMP_DIR || os.tmpdir();

export type TransportName = "whatsapp" | "slack" | "discord" | "signal";

// eslint-disable-next-line import/no-mutable-exports
export let config: Config;

export function initConfig(transport: TransportName | "roam"): Config {
  warnShortConfiguredSecrets();
  const base = {
    botName: process.env.BOT_NAME || "Kleinbot",
    maxResponsesPerRun: parseInt(process.env.MAX_RESPONSES_PER_RUN || "2", 10),
    historyWindow: parseInt(process.env.HISTORY_WINDOW || "50", 10),
    moltbookApiKey: process.env.MOLTBOOK_API_KEY || "",
    moltbookStateFile: path.join(dataDir, "moltbook-state.json"),
    // User data — group IDs are supplied via env, never hardcoded.
    adminGroupJid: process.env.SIGNAL_ADMIN_GROUP_JID || "",
    editorGroupJid: process.env.SIGNAL_EDITOR_GROUP_JID || "",
  };

  if (transport === "roam") {
    config = { ...base, adminJid: "", authDir: "", stateFile: "", pendingFile: "", notesDir: "",
      chatsConfigFile: "", editorGroupJid: "", slackAppToken: "", slackBotToken: "", discordBotToken: "" };
  } else if (transport === "whatsapp") {
    config = {
      ...base,
      adminJid: process.env.ADMIN_JID || "",
      authDir: path.join(dataDir, "whatsapp", "auth"),
      stateFile: path.join(dataDir, "whatsapp", "state.json"),
      pendingFile: path.join(dataDir, "whatsapp", "pending.json"),
      notesDir: path.join(dataDir, "whatsapp", "notes"),
      chatsConfigFile: path.join(promptsDir, "chats.json"),
      slackAppToken: "",
      slackBotToken: "",
      discordBotToken: "",
    };
  } else if (transport === "slack") {
    config = {
      ...base,
      adminJid: process.env.SLACK_ADMIN_USER_ID || "",
      authDir: "",
      stateFile: path.join(dataDir, "slack", "state.json"),
      pendingFile: path.join(dataDir, "slack", "pending.json"),
      notesDir: path.join(dataDir, "slack", "notes"),
      chatsConfigFile: path.join(promptsDir, "slack-chats.json"),
      slackAppToken: process.env.SLACK_APP_TOKEN || "",
      slackBotToken: process.env.SLACK_BOT_TOKEN || "",
      discordBotToken: "",
    };
  } else if (transport === "signal") {
    config = {
      ...base,
      adminJid: process.env.SIGNAL_ADMIN_NUMBER || "",
      authDir: "",
      stateFile: path.join(dataDir, "signal", "state.json"),
      pendingFile: path.join(dataDir, "signal", "pending.json"),
      notesDir: path.join(dataDir, "signal", "notes"),
      chatsConfigFile: path.join(promptsDir, "signal-chats.json"),
      slackAppToken: "",
      slackBotToken: "",
      discordBotToken: "",
    };
  } else {
    config = {
      ...base,
      adminJid: process.env.DISCORD_ADMIN_USER_ID || "",
      authDir: "",
      stateFile: path.join(dataDir, "discord", "state.json"),
      pendingFile: path.join(dataDir, "discord", "pending.json"),
      notesDir: path.join(dataDir, "discord", "notes"),
      chatsConfigFile: path.join(promptsDir, "discord-chats.json"),
      slackAppToken: "",
      slackBotToken: "",
      discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
    };
  }

  return config;
}

// Must call initConfig() before using config — entry points (index-whatsapp, index-slack) do this.

export type ModelBackend = "claude" | "codex";
function backend(name: string, fallback: ModelBackend): ModelBackend {
  const value = process.env[name] || fallback;
  if (value !== "claude" && value !== "codex") throw new Error(`Invalid ${name}`);
  return value;
}

export const modelConfig = {
  claudeBin: process.env.CLAUDE_BIN || "claude",
  codexBin: process.env.CODEX_BIN || "codex",
  codexDisableFeatures: (process.env.CODEX_DISABLE_FEATURES
    ?? "browser_use,browser_use_external,browser_use_full_cdp_access,computer_use,in_app_browser")
    .split(",").map(feature => feature.trim()).filter(Boolean),
  moltbookBackend: backend("MOLTBOOK_BACKEND", "claude"),
  moltbookModel: process.env.MOLTBOOK_MODEL || "sonnet",
  briefingBackend: backend("BRIEFING_BACKEND", "claude"),
  briefingModel: process.env.BRIEFING_MODEL || "opus",
  cycleTimeoutMs: Number(process.env.MOLTBOOK_MODEL_TIMEOUT_MS || 300000),
  commentTimeoutMs: Number(process.env.MOLTBOOK_COMMENT_TIMEOUT_MS || 120000),
  briefingTimeoutMs: Number(process.env.BRIEFING_MODEL_TIMEOUT_MS || 300000),
};

export const moltbookHeartbeatInterval = Number(process.env.MOLTBOOK_HEARTBEAT_INTERVAL || 14400000);

function positiveLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const researchConfig = {
  pageMaxBytes: positiveLimit("RESEARCH_PAGE_MAX_BYTES", 20000),
  pagesMaxPerRun: positiveLimit("RESEARCH_PAGES_MAX_PER_RUN", 12),
  writeupBackend: backend("RESEARCH_WRITEUP_BACKEND", "claude"),
  writeupModel: process.env.RESEARCH_WRITEUP_MODEL || "",
  writeupMaxRecords: positiveLimit("RESEARCH_WRITEUP_MAX_RECORDS", 60),
  writeupMaxExistingPages: Math.min(5, positiveLimit("RESEARCH_WRITEUP_MAX_EXISTING_PAGES", 5)),
  writeupContextMaxBytes: positiveLimit("RESEARCH_WRITEUP_CONTEXT_MAX_BYTES", 262144),
  writeupTimeoutMs: positiveLimit("RESEARCH_WRITEUP_TIMEOUT_MS", 300000),
  backend: backend("RESEARCH_BACKEND", "codex"),
  model: process.env.RESEARCH_MODEL || "",
  batchSize: Number(process.env.RESEARCH_BATCH_SIZE || 20),
  maxBatches: Number(process.env.RESEARCH_MAX_BATCHES || 10),
  maxPostChars: Number(process.env.RESEARCH_MAX_POST_CHARS || 2000),
  maxQuoteChars: Math.min(200, Number(process.env.RESEARCH_MAX_QUOTE_CHARS || 200)),
  maxQuestionChars: Number(process.env.RESEARCH_MAX_QUESTION_CHARS || 2000),
  maxCodeChars: Number(process.env.RESEARCH_MAX_CODE_CHARS || 64),
  timeoutMs: Number(process.env.RESEARCH_MODEL_TIMEOUT_MS || 300000),
  wikiDir: path.join(runtimeDir, "research-wiki"),
  maxCodes: Number(process.env.RESEARCH_SUMMARY_MAX_CODES || 40),
  maxQuotes: Number(process.env.RESEARCH_SUMMARY_MAX_QUOTES || 30),
  dir: path.join(dataDir, "research"),
  capture: process.env.RESEARCH_CAPTURE === "1",
  hourUK: Number(process.env.RESEARCH_HOUR_UK || 3),
  maxCommentFetch: Number(process.env.RESEARCH_MAX_COMMENT_FETCH || 20),
};

function parseOutboxExtraChannels(value: string | undefined): { channel: string; recipient: string }[] {
  const channels: { channel: string; recipient: string }[] = [];
  if (!value) return channels;
  const seen = new Set<string>();
  const seenRecipients = new Set<string>();
  for (const [index, rawEntry] of value.split(",").entries()) {
    // Spaces around commas are a likely typo in an env file, not part of a name or an id.
    const entry = rawEntry.trim();
    if (!entry) continue;
    // Split once: Signal group ids can include base64 padding.
    const separator = entry.indexOf("=");
    const channel = separator < 0 ? "" : entry.slice(0, separator);
    const recipient = separator < 0 ? "" : entry.slice(separator + 1);
    const validName = /^[a-z][a-z0-9-]{0,31}$/.test(channel) && !/\s/.test(channel);
    if (!validName || ["briefing", "research", "archive"].includes(channel)
      || !recipient || recipient.length > 200 || /[\s,\x00-\x1f\x7f-\x9f]/u.test(recipient)
      // One chat must not collect several channels' hourly budgets.
      || seen.has(channel) || seenRecipients.has(recipient) || channels.length >= 8) {
      // Never echo malformed entries: even their name field may contain an id.
      // A reversed pair (`id=name`) puts an id in the name field: echo the name only when the other side does not
      // itself look like a channel name.
      const reversed = /^[a-z][a-z0-9-]{0,31}$/.test(recipient);
      console.warn(`[roam] ROAM_OUTBOX_EXTRA_CHANNELS entry ${index + 1} (${validName && !reversed ? channel : "<invalid>"}) skipped`);
      continue;
    }
    seen.add(channel);
    seenRecipients.add(recipient);
    channels.push({ channel, recipient });
  }
  return channels;
}

export const roamConfig = {
  groupNoteMaxChars: positiveLimit("ROAM_GROUP_NOTE_MAX_CHARS", 1000),
  groupPageContextBytes: positiveLimit("ROAM_GROUP_PAGE_CONTEXT_BYTES", 16384),
  logExcerptChars: positiveLimit("ROAM_LOG_EXCERPT_CHARS", 120),
  tickMs: Number(process.env.ROAM_TICK_INTERVAL || 60000),
  inboxDir: process.env.ROAM_INBOX_DIR || "",
  pipeChatJid: process.env.ROAM_PIPE_CHAT_JID || "",
  inboxGroupReadable: process.env.ROAM_INBOX_GROUP_READABLE === "1",
  inboxMaxTextChars: Number(process.env.ROAM_INBOX_MAX_TEXT_CHARS || 4000),
  inboxMaxPerTick: Number(process.env.ROAM_INBOX_MAX_PER_TICK || 5),
  inboxSeenLimit: Math.min(500, Number(process.env.ROAM_INBOX_SEEN_LIMIT || 500)),
  chatBackend: process.env.ROAM_CHAT_BACKEND || "claude",
  chatModel: process.env.ROAM_CHAT_MODEL || "sonnet",
  chatTimeoutMs: Number(process.env.ROAM_CHAT_TIMEOUT_MS || 300000),
  chatContextMessages: Number(process.env.ROAM_CHAT_CONTEXT_MESSAGES || 20),
  chatContextMaxBytes: Number(process.env.ROAM_CHAT_CONTEXT_MAX_BYTES || 262144),
  intentModel: process.env.ROAM_INTENT_MODEL || "haiku",
  intentTimeoutMs: Number(process.env.ROAM_INTENT_TIMEOUT_MS || 60000),
  intentMinConfidence: Number(process.env.ROAM_INTENT_MIN_CONFIDENCE || 0.7),
  controlMaxDirectiveChars: Math.min(2000, Number(process.env.ROAM_CONTROL_MAX_DIRECTIVE_CHARS || 2000)),
  outboxDir: process.env.ROAM_OUTBOX_DIR || "",
  briefingChatJid: process.env.ROAM_BRIEFING_CHAT_JID || "",
  researchChatJid: process.env.ROAM_RESEARCH_CHAT_JID || "",
  outboxExtraChannels: parseOutboxExtraChannels(process.env.ROAM_OUTBOX_EXTRA_CHANNELS),
  relayIntervalMs: Number(process.env.ROAM_OUTBOX_RELAY_INTERVAL || 5000),
  relayMaxPerSweep: Number(process.env.ROAM_RELAY_MAX_PER_SWEEP || 20),
  relayMaxPerHour: Number(process.env.ROAM_RELAY_MAX_PER_HOUR || 30),
  relayAttachmentGraceMs: Number(process.env.ROAM_RELAY_ATTACHMENT_GRACE_MS || 600000),
  relaySeenLimit: Math.min(5000, Number(process.env.ROAM_RELAY_SEEN_LIMIT || 5000)),
  groupReadable: process.env.ROAM_OUTBOX_GROUP_READABLE === "1",
  maxMdBytes: Number(process.env.ROAM_OUTBOX_MAX_MD_BYTES || 262144),
  // The receiver also enforces these protocol ceilings.
  maxTextChars: Math.min(4000, Number(process.env.ROAM_OUTBOX_MAX_TEXT_CHARS || 4000)),
  maxFlagBytes: Math.min(16384, Number(process.env.ROAM_OUTBOX_MAX_FLAG_BYTES || 16384)),
};

export const crossPollinationQueueLimit = Math.min(50, Number(process.env.MOLTBOOK_CROSS_POLLINATION_QUEUE_LIMIT || 50));
