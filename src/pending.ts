import fs from "fs";
import type { ChatMessage } from "./types.js";
import { config } from "./config.js";

export type PendingByChat = Map<string, ChatMessage[]>;

function recordToMap(record: Record<string, ChatMessage[]>): PendingByChat {
  const pending = new Map<string, ChatMessage[]>();
  for (const [chatJid, messages] of Object.entries(record)) {
    if (Array.isArray(messages) && messages.length > 0) {
      pending.set(chatJid, messages);
    }
  }
  return pending;
}

function mapToRecord(pending: PendingByChat): Record<string, ChatMessage[]> {
  const record: Record<string, ChatMessage[]> = {};
  for (const [chatJid, messages] of pending.entries()) {
    if (messages.length > 0) {
      record[chatJid] = messages;
    }
  }
  return record;
}

export function loadPending(): PendingByChat {
  try {
    const raw = fs.readFileSync(config.pendingFile, "utf-8");
    const record = JSON.parse(raw) as Record<string, ChatMessage[]>;
    return recordToMap(record);
  } catch {
    return new Map();
  }
}

export function savePending(pending: PendingByChat): void {
  const record = mapToRecord(pending);
  const dir = config.pendingFile.replace(/\/[^/]+$/, "");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.pendingFile, JSON.stringify(record, null, 2));
}
