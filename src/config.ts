import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import type { Config } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");

loadEnv({ path: path.join(projectRoot, ".env") });

export type TransportName = "whatsapp" | "slack" | "discord" | "signal";

// eslint-disable-next-line import/no-mutable-exports
export let config: Config;

export function initConfig(transport: TransportName): Config {
  const base = {
    botName: process.env.BOT_NAME || "Kleinbot",
    maxResponsesPerRun: parseInt(process.env.MAX_RESPONSES_PER_RUN || "2", 10),
    historyWindow: parseInt(process.env.HISTORY_WINDOW || "50", 10),
    moltbookApiKey: process.env.MOLTBOOK_API_KEY || "",
    moltbookStateFile: path.join(projectRoot, "data", "moltbook-state.json"),
  };

  if (transport === "whatsapp") {
    config = {
      ...base,
      adminJid: process.env.ADMIN_JID || "",
      authDir: path.join(projectRoot, "data", "whatsapp", "auth"),
      stateFile: path.join(projectRoot, "data", "whatsapp", "state.json"),
      pendingFile: path.join(projectRoot, "data", "whatsapp", "pending.json"),
      notesDir: path.join(projectRoot, "data", "whatsapp", "notes"),
      chatsConfigFile: path.join(projectRoot, "prompts", "chats.json"),
      slackAppToken: "",
      slackBotToken: "",
      discordBotToken: "",
    };
  } else if (transport === "slack") {
    config = {
      ...base,
      adminJid: process.env.SLACK_ADMIN_USER_ID || "",
      authDir: "",
      stateFile: path.join(projectRoot, "data", "slack", "state.json"),
      pendingFile: path.join(projectRoot, "data", "slack", "pending.json"),
      notesDir: path.join(projectRoot, "data", "slack", "notes"),
      chatsConfigFile: path.join(projectRoot, "prompts", "slack-chats.json"),
      slackAppToken: process.env.SLACK_APP_TOKEN || "",
      slackBotToken: process.env.SLACK_BOT_TOKEN || "",
      discordBotToken: "",
    };
  } else if (transport === "signal") {
    config = {
      ...base,
      adminJid: process.env.SIGNAL_ADMIN_NUMBER || "",
      authDir: "",
      stateFile: path.join(projectRoot, "data", "signal", "state.json"),
      pendingFile: path.join(projectRoot, "data", "signal", "pending.json"),
      notesDir: path.join(projectRoot, "data", "signal", "notes"),
      chatsConfigFile: path.join(projectRoot, "prompts", "signal-chats.json"),
      slackAppToken: "",
      slackBotToken: "",
      discordBotToken: "",
    };
  } else {
    config = {
      ...base,
      adminJid: process.env.DISCORD_ADMIN_USER_ID || "",
      authDir: "",
      stateFile: path.join(projectRoot, "data", "discord", "state.json"),
      pendingFile: path.join(projectRoot, "data", "discord", "pending.json"),
      notesDir: path.join(projectRoot, "data", "discord", "notes"),
      chatsConfigFile: path.join(projectRoot, "prompts", "discord-chats.json"),
      slackAppToken: "",
      slackBotToken: "",
      discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
    };
  }

  return config;
}

// Must call initConfig() before using config — entry points (index-whatsapp, index-slack) do this.
