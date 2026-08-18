import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import type { Config } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");

// Runtime data/config lives outside the repo at ~/team/kleinbot/
export const runtimeDir = process.env.KLEINBOT_RUNTIME_DIR || path.join(process.env.HOME || "/home/user", "team", "kleinbot");
export const dataDir = path.join(runtimeDir, "data");
export const promptsDir = path.join(runtimeDir, "prompts");

loadEnv({ path: path.join(runtimeDir, "config", ".env") });

export type TransportName = "whatsapp" | "slack" | "discord" | "signal";

// eslint-disable-next-line import/no-mutable-exports
export let config: Config;

export function initConfig(transport: TransportName): Config {
  const base = {
    botName: process.env.BOT_NAME || "Kleinbot",
    maxResponsesPerRun: parseInt(process.env.MAX_RESPONSES_PER_RUN || "2", 10),
    historyWindow: parseInt(process.env.HISTORY_WINDOW || "50", 10),
    moltbookApiKey: process.env.MOLTBOOK_API_KEY || "",
    moltbookStateFile: path.join(dataDir, "moltbook-state.json"),
    // User data — the editor agent's group ID is supplied via env, never hardcoded.
    editorGroupJid: process.env.SIGNAL_EDITOR_GROUP_JID || "",
  };

  if (transport === "whatsapp") {
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
