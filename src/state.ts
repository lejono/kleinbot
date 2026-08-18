import fs from "fs";
import type { BotState, ChatMessage } from "./types.js";
import { config } from "./config.js";

const MAX_STORED_IDS = 500;

function defaultState(): BotState {
  return {
    lastProcessedTimestamp: 0,
    processedMessageIds: [],
    messageHistory: [],
    allowedDmJids: [],
  };
}

function trimHistoryPerChat(messages: ChatMessage[], perChatWindow: number): ChatMessage[] {
  if (perChatWindow <= 0) return [];

  const byChat = new Map<string, ChatMessage[]>();
  for (const msg of messages) {
    const chatJid = msg.chatJid;
    if (!chatJid) continue;
    const queue = byChat.get(chatJid) || [];
    queue.push(msg);
    byChat.set(chatJid, queue);
  }

  const trimmed: ChatMessage[] = [];
  for (const queue of byChat.values()) {
    queue.sort((a, b) => a.timestamp - b.timestamp);
    if (queue.length > perChatWindow) {
      trimmed.push(...queue.slice(-perChatWindow));
    } else {
      trimmed.push(...queue);
    }
  }

  return trimmed.sort((a, b) => a.timestamp - b.timestamp);
}

export function loadState(): BotState {
  try {
    const raw = fs.readFileSync(config.stateFile, "utf-8");
    const saved = JSON.parse(raw);
    // Merge with defaults so new fields are always present
    const merged = { ...defaultState(), ...saved };
    merged.messageHistory = trimHistoryPerChat(merged.messageHistory, config.historyWindow);
    return merged;
  } catch {
    return defaultState();
  }
}

export function saveState(state: BotState): void {
  // Trim stored IDs to prevent unbounded growth
  if (state.processedMessageIds.length > MAX_STORED_IDS) {
    state.processedMessageIds = state.processedMessageIds.slice(-MAX_STORED_IDS);
  }
  // Trim history per chat to configured window
  state.messageHistory = trimHistoryPerChat(state.messageHistory, config.historyWindow);

  const dir = config.stateFile.replace(/\/[^/]+$/, "");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

export function isProcessed(state: BotState, messageId: string): boolean {
  return state.processedMessageIds.includes(messageId)
    || state.messageHistory.some((msg) => msg.id === messageId);
}

export function markProcessed(state: BotState, msg: ChatMessage): void {
  state.processedMessageIds.push(msg.id);
  state.messageHistory.push(msg);
  if (msg.timestamp > state.lastProcessedTimestamp) {
    state.lastProcessedTimestamp = msg.timestamp;
  }
}

export function isDmAllowed(state: BotState, jid: string, senderJid?: string): boolean {
  return state.allowedDmJids.includes(jid)
    || (!!senderJid && senderJid !== jid && state.allowedDmJids.includes(senderJid));
}

export function allowDm(state: BotState, jid: string): boolean {
  if (state.allowedDmJids.includes(jid)) return false;
  state.allowedDmJids.push(jid);
  return true;  // returns true if newly added
}

interface ChatKind {
  isDm: boolean;
  isGroup: boolean;
  isKnownChat: boolean;  // already has a chats.json entry, i.e. previously onboarded
}

/**
 * Whether a message must wait for admin approval before the bot acts on it.
 * DMs are always gated. Groups are gated only the first time the bot sees
 * them (isKnownChat === false) — once a group has been onboarded, any
 * member can trigger normal responses. In both cases, a message from the
 * admin, or from a chat already in allowedDmJids (via /allow), bypasses
 * the gate.
 */
export function requiresApproval(
  state: BotState,
  msg: { chatJid: string; senderJid: string },
  chatKind: ChatKind,
  adminJid: string,
): boolean {
  const isNewGroup = chatKind.isGroup && !chatKind.isKnownChat;
  if (!chatKind.isDm && !isNewGroup) return false;
  if (adminJid && msg.senderJid === adminJid) return false;
  return !isDmAllowed(state, msg.chatJid);
}
