import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { containsEnvSecret, containsConfiguredSecret } from "../moltbook/egress.js";
import { roamConfig } from "../config.js";

export function canWriteOutbox(channel: "briefing" | "research"): boolean {
  try {
    if (!roamConfig.outboxDir) throw new Error("Outbox unset");
    const dir = path.resolve(roamConfig.outboxDir, channel);
    fs.mkdirSync(dir, { recursive: true, mode: roamConfig.groupReadable ? 0o770 : 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Symlinked outbox channel");
    if (roamConfig.groupReadable) fs.chmodSync(dir, 0o770);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { console.error("[roam] Outbox channel is not writable"); return false; }
}

export type OutboxResult = "published" | "refused" | "failed";

export function writeOutboxMessage(channel: "briefing" | "research", text: string, mdFilePath?: string): OutboxResult {
  if (containsEnvSecret(text)) { console.warn("[roam] Outbox text refused by egress check"); return "refused"; }
  if (!roamConfig.outboxDir) {
    console.log(`[roam] Outbox unset; ${text.length} text characters`);
    return "failed";
  }
  if (channel !== "briefing" && channel !== "research") throw new Error("Invalid outbox channel");
  const dir = path.resolve(roamConfig.outboxDir, channel);
  const id = randomUUID();
  const temp = path.join(dir, `${id}.tmp`);
  const attachmentPath = mdFilePath ? path.join(dir, `${id}.md`) : undefined;
  const attachmentTemp = attachmentPath ? `${attachmentPath}.tmp` : undefined;
  let published = false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: roamConfig.groupReadable ? 0o770 : 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Symlinked outbox channel");
    if (roamConfig.groupReadable) fs.chmodSync(dir, 0o770);
    if (mdFilePath) {
      if (path.extname(mdFilePath) !== ".md" || fs.lstatSync(mdFilePath).isSymbolicLink()) {
        throw new Error("Attachment must be a regular .md file");
      }
      const fd = fs.openSync(mdFilePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > roamConfig.maxMdBytes) throw new Error("Invalid attachment size or type");
        const bytes = fs.readFileSync(fd);
        if (bytes.length > roamConfig.maxMdBytes) throw new Error("Attachment grew beyond limit");
        if (containsConfiguredSecret(bytes)) {
          console.warn("[roam] Outbox attachment refused by egress check");
          return "refused";
        }
        fs.writeFileSync(attachmentTemp!, bytes, { mode: 0o600, flag: "wx" });
        if (roamConfig.groupReadable) fs.chmodSync(attachmentTemp!, 0o640);
        fs.renameSync(attachmentTemp!, attachmentPath!);
      } finally { fs.closeSync(fd); }
    }
    const marker = "\n[truncated]";
    const cap = Math.max(marker.length, roamConfig.maxTextChars);
    const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "");
    const flag = { id, type: "message", timestamp: Date.now(),
      text: clean.length > cap ? clean.slice(0, cap - marker.length) + marker : clean, attachmentPath };
    // JSON escaping can exceed the byte cap even below the character cap.
    while (Buffer.byteLength(JSON.stringify(flag)) > roamConfig.maxFlagBytes) {
      if (flag.text.length <= marker.length) throw new Error("Flag metadata exceeds limit");
      flag.text = flag.text.slice(0, Math.max(0, flag.text.length - marker.length - 100)) + marker;
    }
    fs.writeFileSync(temp, JSON.stringify(flag) + "\n", { mode: 0o600, flag: "wx" });
    if (roamConfig.groupReadable) fs.chmodSync(temp, 0o640);
    fs.renameSync(temp, path.join(dir, `${id}.json`));
    published = true;
    return "published";
  } catch {
    console.error("[roam] Outbox write failed");
    return "failed";
  } finally {
    fs.rmSync(temp, { force: true });
    if (attachmentTemp) fs.rmSync(attachmentTemp, { force: true });
    if (!published && attachmentPath) fs.rmSync(attachmentPath, { force: true });
  }
}
