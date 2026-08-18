// Durable, append-only raw capture of every inbound message.
//
// This is deliberately decoupled from the rolling `state.json` window that
// `claude --print` reads: that window is trimmed to HISTORY_WINDOW per chat, so
// older messages roll off and are lost. This log keeps the complete raw record
// (body + attachment refs + metadata) so future agent pipelines (Finance for
// receipts, an ideas agent, etc.) have the source material even for message
// types not yet routed. Storage is cheap (~300 B/line); what the model reads is
// governed separately by the rolling window.
//
// See docs/plans/2026-06-20-message-capture-and-agent-pipeline.md.

import fs from "fs";
import path from "path";
import type { ChatMessage } from "./types.js";

export interface RawAttachment {
  path: string;          // resolved absolute path on disk (msg attachment localPath)
  contentType: string;
  filename: string | null;
  size: number;
}

export type RawType = "text" | "voicenote" | "image" | "pdf" | "doc";

export interface RawRecord {
  capturedAt: string;    // ISO 8601 — when we persisted it
  messageTs: number;     // the message's own timestamp, verbatim (unit per transport)
  transport: string;
  id: string;
  chatJid: string;
  senderJid: string;
  sender: string;
  type: RawType;
  text: string;
  attachments: RawAttachment[];
}

// Classify by attachment content type. Priority: voicenote > image > pdf > doc,
// so a captioned voice note (audio + image) is still routed as a voicenote.
export function classifyMessage(msg: ChatMessage): RawType {
  const atts = msg.attachments ?? [];
  if (atts.some(a => a.contentType.startsWith("audio/"))) return "voicenote";
  if (atts.some(a => a.contentType.startsWith("image/"))) return "image";
  if (atts.some(a => a.contentType === "application/pdf")) return "pdf";
  if (atts.length > 0) return "doc";
  return "text";
}

export function buildRawRecord(transport: string, msg: ChatMessage, capturedAt: Date): RawRecord {
  return {
    capturedAt: capturedAt.toISOString(),
    messageTs: msg.timestamp,
    transport,
    id: msg.id,
    chatJid: msg.chatJid,
    senderJid: msg.senderJid,
    sender: msg.sender,
    type: classifyMessage(msg),
    text: msg.text ?? "",
    attachments: (msg.attachments ?? []).map(a => ({
      path: a.localPath,
      contentType: a.contentType,
      filename: a.filename,
      size: a.size,
    })),
  };
}

// Monthly rotation keeps any single file small and makes pruning/archival trivial.
export function rawLogPath(dataDir: string, transport: string, when: Date): string {
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, "0");
  return path.join(dataDir, transport, "raw", `${yyyy}-${mm}.jsonl`);
}

// Append one JSONL line. Append-only and best-effort: callers should not block
// or fail message processing if this rejects.
export async function appendRawMessage(
  dataDir: string,
  transport: string,
  msg: ChatMessage,
  now: Date = new Date(),
): Promise<void> {
  const record = buildRawRecord(transport, msg, now);
  const file = rawLogPath(dataDir, transport, now);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, JSON.stringify(record) + "\n");
}
