// Entourage integration — detects tasks for the orchestrator and writes flag files.
// Flag file format matches orchestrator/src/types/flags.ts.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import type { ChatMessage } from "./types.js";

const FLAGS_DIR = process.env.ENTOURAGE_FLAGS_DIR
  || path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`, "entourage", "flags");
const INCOMING_DIR = path.join(FLAGS_DIR, "incoming");

const EXPENSE_KEYWORDS = /\b(expense|receipt|claim|reimburse|reimbursement)\b/i;

// Receipts arrive as images OR PDFs — invoices/receipts are frequently PDF.
function isReceiptAttachment(a: { contentType: string }): boolean {
  return a.contentType.startsWith("image/") || a.contentType === "application/pdf";
}

export function isExpenseReceipt(msg: ChatMessage): boolean {
  if (!msg.attachments?.length) return false;

  const hasReceipt = msg.attachments.some(isReceiptAttachment);
  if (!hasReceipt) return false;

  // Explicit expense keywords in the message
  if (EXPENSE_KEYWORDS.test(msg.text)) return true;

  // DM from admin with a receipt (image/PDF) and short/no text — assume expense receipt
  const adminJid = process.env.SIGNAL_ADMIN_NUMBER || config.adminJid;
  if (msg.senderJid === adminJid && msg.chatJid === adminJid && msg.text.length < 100) {
    return true;
  }

  return false;
}

export async function writeExpenseFlag(msg: ChatMessage): Promise<void> {
  const flag = {
    id: randomUUID(),
    type: "expense",
    timestamp: Date.now(),
    source: "kleinbot",
    sender: msg.sender,
    senderJid: msg.senderJid,
    chatJid: msg.chatJid,
    text: msg.text || "",
    attachments: (msg.attachments || [])
      .filter(isReceiptAttachment)
      .map(a => ({
        path: a.localPath,
        contentType: a.contentType,
        filename: a.filename,
        size: a.size,
      })),
  };

  await writeFlag(INCOMING_DIR, flag);
  console.log(`[entourage] Wrote expense flag ${flag.id.slice(0, 8)} for receipt from ${msg.sender}`);
}

// Editor agent: detect /revise commands from the admin in the configured editor group.
// The group ID is USER DATA — supplied via SIGNAL_EDITOR_GROUP_JID / config, never hardcoded.
export function isEditorCommand(msg: ChatMessage): boolean {
  const editorGroupJid = process.env.SIGNAL_EDITOR_GROUP_JID || config.editorGroupJid;
  if (!editorGroupJid || msg.chatJid !== editorGroupJid) return false;
  const adminJid = process.env.SIGNAL_ADMIN_NUMBER || config.adminJid;
  if (msg.senderJid !== adminJid) return false;
  return /^\/revise\b/i.test(msg.text);
}

export async function writeEditorFlag(msg: ChatMessage): Promise<void> {
  const flag = {
    id: randomUUID(),
    type: "editor",
    timestamp: Date.now(),
    source: "kleinbot",
    sender: msg.sender,
    senderJid: msg.senderJid,
    chatJid: msg.chatJid,
    text: msg.text,
  };

  await writeFlag(INCOMING_DIR, flag);
  console.log(`[entourage] Wrote editor flag ${flag.id.slice(0, 8)} for "${msg.text}" from ${msg.sender}`);
}

// Voice notes from admin DM — always flag for EA
export function isVoiceNote(msg: ChatMessage): boolean {
  const adminJid = process.env.SIGNAL_ADMIN_NUMBER || config.adminJid;
  if (msg.senderJid !== adminJid) return false;
  if (!msg.attachments?.length) return false;
  return msg.attachments.some(a =>
    a.contentType.startsWith("audio/"),
  );
}

export async function writeVoiceNoteFlag(msg: ChatMessage): Promise<void> {
  const flag = {
    id: randomUUID(),
    type: "voicenote",
    timestamp: Date.now(),
    source: "kleinbot",
    sender: msg.sender,
    senderJid: msg.senderJid,
    chatJid: msg.chatJid,
    text: msg.text || "",
    attachments: (msg.attachments || [])
      .filter(a => a.contentType.startsWith("audio/"))
      .map(a => ({
        path: a.localPath,
        contentType: a.contentType,
        filename: a.filename,
        size: a.size,
      })),
  };

  await writeFlag(INCOMING_DIR, flag);
  console.log(`[entourage] Wrote voicenote flag ${flag.id.slice(0, 8)} from ${msg.sender}`);
}

// Sheet edits: the chat LLM emits a structured intent (op/list/item); we write a
// `sheet_edit` flag for the orchestrator, which holds the Google credential and
// performs the actual write. The LLM never gets a write tool — this keeps a
// prompt-injected message from reaching sheet-mutation privilege. The truthful
// "✓ added" confirmation comes back from the orchestrator as an outbound flag,
// not from the LLM, so kleinbot can't confabulate an edit it never made.
type SheetActionInput = { op?: unknown; list?: unknown; item?: unknown };

// Minimal shape guard on the untrusted LLM output. Strict validation (allowlist,
// sanitisation, rate limits) is the orchestrator's job — here we only refuse to
// emit an obviously malformed flag.
export function coerceSheetAction(
  a: SheetActionInput | undefined | null,
): { op: string; list: string; item: string } | null {
  if (!a || typeof a !== "object") return null;
  const op = typeof a.op === "string" ? a.op.trim().toLowerCase() : "";
  const list = typeof a.list === "string" ? a.list.trim() : "";
  const item = typeof a.item === "string" ? a.item : "";
  if (!["append", "remove", "list"].includes(op)) return null;
  if (!list) return null;
  if ((op === "append" || op === "remove") && !item.trim()) return null;
  return { op, list, item };
}

// A single chat turn may carry several edits ("add X and Y, and remove Z").
// Cap how many we act on per message — a defensive bound against a runaway or
// injected response asking for hundreds of writes.
export const MAX_SHEET_ACTIONS = 10;

// Gather + validate every sheet edit from one LLM response, from either the
// plural `sheetActions` array or the singular `sheetAction` (back-compat), in
// that order. Malformed entries are dropped; the result is capped.
export function collectSheetActions(
  decision: { sheetAction?: SheetActionInput; sheetActions?: unknown },
): { op: string; list: string; item: string }[] {
  const raw: SheetActionInput[] = [];
  if (Array.isArray(decision.sheetActions)) {
    raw.push(...(decision.sheetActions as SheetActionInput[]));
  }
  if (decision.sheetAction) raw.push(decision.sheetAction);

  const out: { op: string; list: string; item: string }[] = [];
  for (const a of raw) {
    const coerced = coerceSheetAction(a);
    if (coerced) out.push(coerced);
    if (out.length >= MAX_SHEET_ACTIONS) break;
  }
  return out;
}

export async function writeSheetEditFlag(
  chatJid: string,
  action: { op: string; list: string; item: string },
): Promise<void> {
  const flag = {
    id: randomUUID(),
    type: "sheet_edit",
    timestamp: Date.now(),
    source: "kleinbot",
    chatJid,
    op: action.op,
    list: action.list,
    item: action.item,
  };
  await writeFlag(INCOMING_DIR, flag);
  console.log(
    `[entourage] Wrote sheet_edit flag ${flag.id.slice(0, 8)}: ${action.op} "${action.item}" -> ${action.list}`,
  );
}

async function writeFlag(dir: string, flag: Record<string, unknown>): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const shortId = (flag.id as string).slice(0, 8);
  const filename = `${flag.timestamp}-${flag.type}-${shortId}.json`;
  const tmpPath = path.join(dir, `${filename}.tmp`);
  const finalPath = path.join(dir, filename);

  await fs.promises.writeFile(tmpPath, JSON.stringify(flag, null, 2));
  await fs.promises.rename(tmpPath, finalPath);
}
