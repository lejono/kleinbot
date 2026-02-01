import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { WASocket } from "baileys";
import type { ChatMessage, ClaudeResponse, ChatConfig, ChatsConfig } from "./types.js";
import { config } from "./config.js";
import { fetchGroupDescription } from "./whatsapp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const quote = m.quotedText ? ` (replying to: "${m.quotedText.slice(0, 100)}")` : "";
      return `[${time}] ${m.sender}: ${m.text}${quote}`;
    })
    .join("\n");
}

const VERBOSITY_INSTRUCTIONS: Record<number, string> = {
  1: "Almost never respond. Only respond when directly @mentioned by name. Ignore everything else.",
  2: "Rarely respond. Only respond to direct questions aimed at you or @mentions. Stay quiet during general conversation.",
  3: "Respond moderately. Jump in when someone asks a question you can help with, when you're mentioned, or when the conversation would benefit from facilitation. Stay quiet during casual banter.",
  4: "Be fairly chatty. Respond to most questions, offer opinions, react to interesting topics, and join the banter. Still skip messages that don't need a response.",
  5: "Be very active. Participate freely in conversation like a regular group member. Respond to most messages, share thoughts, and be social.",
};

const MAX_NOTES_LINES = 50;
const notesDir = path.join(projectRoot, "data", "notes");

export function getChatConfig(chatJid: string): ChatConfig {
  const raw = fs.readFileSync(config.chatsConfigFile, "utf-8");
  const chats: ChatsConfig = JSON.parse(raw);
  return chats[chatJid] || chats["default"];
}

/**
 * If chatJid doesn't have an entry in chats.json, create one from defaults.
 * For groups, fetches the WhatsApp group description automatically.
 * Returns true if a new entry was created.
 */
export async function ensureChatConfig(chatJid: string, sock?: WASocket): Promise<boolean> {
  const raw = fs.readFileSync(config.chatsConfigFile, "utf-8");
  const chats: ChatsConfig = JSON.parse(raw);
  if (chats[chatJid]) return false;

  const defaults = chats["default"];
  let description = "";

  // Fetch group description from WhatsApp if it's a group
  if (sock && chatJid.endsWith("@g.us")) {
    const meta = await fetchGroupDescription(sock, chatJid);
    if (meta) {
      const parts: string[] = [];
      if (meta.subject) parts.push(`Group: ${meta.subject}`);
      if (meta.description) parts.push(meta.description);
      description = parts.join("\n");
    }
  }

  chats[chatJid] = {
    prompt: defaults.prompt,
    model: defaults.model,
    verbosity: defaults.verbosity ?? 3,
    description,
  };
  fs.writeFileSync(config.chatsConfigFile, JSON.stringify(chats, null, 2) + "\n");
  console.log(`\n========================================`);
  console.log(`NEW CHAT ADDED TO CONFIG: ${chatJid}`);
  if (description) console.log(`Description: ${description.slice(0, 200)}`);
  console.log(`Edit prompts/chats.json to customize.`);
  console.log(`========================================\n`);
  return true;
}

export function getNotesPath(chatJid: string): string {
  return path.join(notesDir, `${chatJid}.md`);
}

export function readNotes(chatJid: string): string {
  try {
    return fs.readFileSync(getNotesPath(chatJid), "utf-8").trim();
  } catch {
    return "";
  }
}

export function saveNotes(chatJid: string, newNotes: string): void {
  fs.mkdirSync(notesDir, { recursive: true });
  const notesPath = getNotesPath(chatJid);
  const timestamp = new Date().toISOString().slice(0, 16);
  const entry = `[${timestamp}] ${newNotes}`;

  // Append and cap at MAX_NOTES_LINES
  let existing = "";
  try { existing = fs.readFileSync(notesPath, "utf-8"); } catch {}
  const lines = existing.split("\n").filter(Boolean);
  lines.push(entry);
  const trimmed = lines.slice(-MAX_NOTES_LINES);
  fs.writeFileSync(notesPath, trimmed.join("\n") + "\n");
}

function buildSystemPrompt(chatConfig: ChatConfig, chatJid: string): string {
  const parts: string[] = [];

  // Core personality prompt
  const promptPath = path.resolve(projectRoot, chatConfig.prompt);
  parts.push(fs.readFileSync(promptPath, "utf-8").trim());

  // Group/chat description
  if (chatConfig.description) {
    parts.push(`\n## About this chat\n${chatConfig.description}`);
  }

  // Verbosity calibration
  const v = chatConfig.verbosity ?? 3;
  const vClamped = Math.max(1, Math.min(5, v));
  parts.push(`\n## Participation level: ${vClamped}/5\n${VERBOSITY_INSTRUCTIONS[vClamped]}`);

  // Static context (manually edited file)
  if (chatConfig.context) {
    try {
      const contextPath = path.resolve(projectRoot, chatConfig.context);
      const ctx = fs.readFileSync(contextPath, "utf-8").trim();
      if (ctx) parts.push(`\n## Context\n${ctx}`);
    } catch {}
  }

  // Bot's own notes from previous cycles
  const notes = readNotes(chatJid);
  if (notes) {
    parts.push(`\n## Your notes (from previous conversations)\nThese are notes you wrote to yourself. Use them for context.\n${notes}`);
  }

  return parts.join("\n");
}

export async function askClaude(
  recentHistory: ChatMessage[],
  newMessages: ChatMessage[],
  chatConfig: ChatConfig,
  chatJid: string
): Promise<ClaudeResponse> {
  const systemPrompt = buildSystemPrompt(chatConfig, chatJid);

  const prompt = [
    "## Recent conversation history (for context)",
    formatTranscript(recentHistory),
    "",
    "## New messages since last check",
    formatTranscript(newMessages),
    "",
    "Based on the system prompt and conversation above, decide whether to respond.",
    "If you have anything worth noting for future reference (facts about people, preferences, decisions made, instructions given to you), include it in the notes field.",
    "If a poll would help the group make a decision (e.g. choosing a date, picking a restaurant, voting on options), include a poll field.",
    "Reply ONLY with valid JSON (no markdown fences):",
    '{"shouldRespond": true/false, "response": "your message or null", "notes": "anything to remember, or null", "poll": {"question": "...", "options": ["A", "B", "C"], "multiSelect": false} or null}',
  ].join("\n");

  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn("claude", [
      "--print",
      "--model", chatConfig.model,
      "--no-session-persistence",
      "--system-prompt", systemPrompt,
      "--allowedTools", "WebSearch,WebFetch",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 90_000,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("Claude CLI error (exit", code + "):", stderr.slice(0, 500));
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    proc.on("error", reject);

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("No JSON found in Claude response:", result);
      return { shouldRespond: false };
    }
    return JSON.parse(jsonMatch[0]) as ClaudeResponse;
  } catch (err) {
    console.error("Failed to parse Claude response:", result);
    return { shouldRespond: false };
  }
}
