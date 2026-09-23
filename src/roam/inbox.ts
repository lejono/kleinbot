import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { dataDir, roamConfig } from "../config.js";
import { isSameJid } from "../jid.js";
import type { ChatMessage } from "../types.js";

export interface InboxMessage {
  id: string;
  timestamp: number;
  senderName: string;
  text: string;
  attachments: { filename: string; contentType: string }[];
}

export function cleanInboxText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "");
}

export function shouldPipeMessage(chatJid: string, settings = roamConfig): boolean {
  return !!(settings.inboxDir && settings.pipeChatJid
    && (chatJid === settings.pipeChatJid || isSameJid(chatJid, settings.pipeChatJid)));
}

function pipeSecret(dir: string): Buffer {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "roam-pipe-secret");
  if (!fs.existsSync(file)) {
    const temp = path.join(dir, `${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: "wx" });
      fs.chmodSync(temp, 0o600);
      try { fs.linkSync(temp, file); }
      catch (err: any) { if (err.code !== "EEXIST") throw err; }
    } finally { fs.rmSync(temp, { force: true }); }
  }
  const secret = fs.readFileSync(file);
  if (secret.length !== 32) throw new Error("Invalid pipe secret");
  return secret;
}

function maskInboxText(text: string): string {
  return cleanInboxText(text)
    .replace(/@(?:[^\s@]+@[^\s@]+|[0-9]+)(?![\w@])/g, "[mention]")
    .replace(/[+\d](?:[ .()\-]*\d){7,}/g, "[number]");
}

export function writeInboxMessage(msg: ChatMessage, secretDir = dataDir): boolean {
  if (!shouldPipeMessage(msg.chatJid)) return false;
  const dir = path.resolve(roamConfig.inboxDir);
  const temp = path.join(dir, `${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: roamConfig.inboxGroupReadable ? 0o770 : 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Symlinked inbox");
    fs.chmodSync(dir, roamConfig.inboxGroupReadable ? 0o770 : 0o700);
    const name = cleanInboxText(msg.sender || "").trim();
    // Transport fallback names and message ids can embed sender identifiers.
    const senderName = name && name !== msg.senderJid && name !== msg.senderJid.split("@")[0].split(":")[0]
      && name !== msg.chatJid
      && /^[\p{L}\p{M} .'-]+$/u.test(name) ? name : "member";
    const id = createHmac("sha256", pipeSecret(secretDir)).update(msg.id).digest("hex");
    const message: InboxMessage = { id, timestamp: msg.timestamp, senderName,
      text: maskInboxText(msg.text).slice(0, roamConfig.inboxMaxTextChars),
      attachments: (msg.attachments || []).map((a, index) => {
        const extension = path.extname(a.filename || "").slice(1);
        return { filename: `file-${index + 1}` + (/^[a-z0-9]{1,5}$/i.test(extension) ? `.${extension.toLowerCase()}` : ""),
          contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(a.contentType) ? a.contentType : "application/octet-stream" };
      }) };
    fs.writeFileSync(temp, JSON.stringify(message) + "\n", { mode: 0o600, flag: "wx" });
    fs.chmodSync(temp, roamConfig.inboxGroupReadable ? 0o640 : 0o600);
    fs.renameSync(temp, path.join(dir, `${message.timestamp}-${id}.json`));
    return true;
  } catch {
    console.error("[roam] Inbox write failed");
    return false;
  } finally {
    try { fs.unlinkSync(temp); } catch { /* Already renamed or not created. */ }
  }
}

export function readInboxMessages(): { file: string; message: InboxMessage }[] {
  if (!roamConfig.inboxDir) return [];
  const messages: { file: string; message: InboxMessage }[] = [];
  try {
    if (fs.lstatSync(roamConfig.inboxDir).isSymbolicLink()) return [];
    for (const name of fs.readdirSync(roamConfig.inboxDir).filter(n => n.endsWith(".json"))) {
      const file = path.join(roamConfig.inboxDir, name);
      try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let message: InboxMessage;
        try {
          if (!fs.fstatSync(fd).isFile()) continue;
          message = JSON.parse(fs.readFileSync(fd, "utf8"));
        } finally { fs.closeSync(fd); }
        if (!message || typeof message.id !== "string" || !message.id
          || !Number.isFinite(message.timestamp) || typeof message.senderName !== "string"
          || typeof message.text !== "string" || !Array.isArray(message.attachments)) continue;
        message.text = cleanInboxText(message.text).slice(0, roamConfig.inboxMaxTextChars);
        messages.push({ file, message });
      } catch { /* Incomplete, removed or invalid files are ignored. */ }
    }
  } catch { /* The sync job may not have created the inbox yet. */ }
  return messages.sort((a, b) => a.message.timestamp - b.message.timestamp || a.file.localeCompare(b.file));
}
