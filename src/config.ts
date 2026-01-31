import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import type { Config } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

loadEnv({ path: path.join(projectRoot, ".env") });

export const config: Config = {
  botName: process.env.BOT_NAME || "Kleinbot",
  adminJid: process.env.ADMIN_JID || "",
  maxResponsesPerRun: parseInt(process.env.MAX_RESPONSES_PER_RUN || "2", 10),
  historyWindow: parseInt(process.env.HISTORY_WINDOW || "50", 10),
  authDir: path.join(projectRoot, "data", "auth"),
  stateFile: path.join(projectRoot, "data", "state.json"),
  pendingFile: path.join(projectRoot, "data", "pending.json"),
  chatsConfigFile: path.join(projectRoot, "prompts", "chats.json"),
};
