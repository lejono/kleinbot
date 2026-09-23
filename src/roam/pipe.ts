import type { ChatMessage } from "../types.js";
import { shouldPipeMessage, writeInboxMessage } from "./inbox.js";

// Keep failed startup writes away from the model queue, but preserve them on disk.
export function createInboxPipe(pending: Map<string, ChatMessage[]>, processed: (msg: ChatMessage) => void,
  write: (msg: ChatMessage) => boolean = writeInboxMessage) {
  const retries = new Map<string, ChatMessage>();
  function flush(): void {
    for (const [id, msg] of retries) {
      if (write(msg)) { processed(msg); retries.delete(id); }
    }
  }
  for (const [chat, messages] of pending) {
    if (!shouldPipeMessage(chat)) continue;
    for (const msg of messages) retries.set(msg.id, msg);
    pending.delete(chat);
  }
  flush();
  return {
    route(msg: ChatMessage): boolean {
      if (!shouldPipeMessage(msg.chatJid)) return false;
      retries.set(msg.id, msg);
      flush();
      return true;
    },
    persisted(): Map<string, ChatMessage[]> {
      const result = new Map(pending);
      for (const msg of retries.values()) result.set(msg.chatJid, [...(result.get(msg.chatJid) || []), msg]);
      return result;
    },
  };
}
