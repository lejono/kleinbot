import fs from "node:fs";
import path from "node:path";
import { researchConfig, roamConfig } from "../config.js";
import { containsConfiguredSecret } from "../moltbook/egress.js";
import { postLink } from "../research/summary.js";

type ActivityFields = {
  cycle: { fetched: number; captured: number; commentTrees: number; paused: boolean };
  action: { type: "post" | "comment" | "upvote"; postId: string; textChars?: number };
  research: { captured: number; classified: number; organising: number; newlyClassified: number; pagesWritten: number };
  briefing: { status: "sent to outbox" | "failed" | "no message" };
  control: { sender: string; via: "slash command" | "plain language"; paused?: boolean; focus?: "updated" | "cleared" };
  inbox: { sender: string; text: string; status: "answered" | "failed" | "withheld" };
  writeup: { status: "model unset; skipped" | "failed" | "completed"; pagesWritten?: number };
};

export function logExcerpt(text: string): string {
  if (containsConfiguredSecret(text)) return "[excerpt withheld]";
  return text.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .slice(0, roamConfig.logExcerptChars);
}

// Select fields explicitly: model prose and feed objects must never be spread into a log line.
function describe(kind: keyof ActivityFields, fields: any): string {
  const count = (n: unknown) => Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
  switch (kind) {
    case "cycle": return `fetched=${count(fields.fetched)} captured=${count(fields.captured)} commentTrees=${count(fields.commentTrees)} paused=${fields.paused === true}`;
    case "action": {
      const type = ["post", "comment", "upvote"].includes(fields.type) ? fields.type : "unknown";
      const link = typeof fields.postId === "string" && fields.postId.trim() && !containsConfiguredSecret(fields.postId)
        ? postLink(fields.postId) : "[link withheld]";
      return `${type} ${link}${type !== "upvote" ? ` textChars=${count(fields.textChars)}` : ""}`;
    }
    case "research": return `captured=${count(fields.captured)} classified=${count(fields.classified)} organising=${count(fields.organising)} newlyClassified=${count(fields.newlyClassified)} pagesWritten=${count(fields.pagesWritten)}`;
    case "briefing": return fields.status;
    case "control": return `sender=${JSON.stringify(logExcerpt(fields.sender))} via=${fields.via}${typeof fields.paused === "boolean" ? ` paused=${fields.paused}` : ""}${fields.focus ? ` focus=${fields.focus}` : ""}`;
    case "inbox": return `sender=${JSON.stringify(logExcerpt(fields.sender))} text=${JSON.stringify(logExcerpt(fields.text))} ${fields.status}`;
    case "writeup": return `${fields.status} pagesWritten=${count(fields.pagesWritten)}`;
  }
}

export function logActivity<K extends keyof ActivityFields>(kind: K, fields: ActivityFields[K], now = new Date()): void {
  let fd: number | undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const month = `${part("year")}-${part("month")}`;
    fs.mkdirSync(researchConfig.wikiDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(researchConfig.wikiDir).isSymbolicLink()) return;
    fs.chmodSync(researchConfig.wikiDir, 0o700);
    fd = fs.openSync(path.join(researchConfig.wikiDir, `log-${month}.md`), fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, (stat.size ? "" : `# Activity ${month}\n`) + `- ${month}-${part("day")} ${part("hour")}:${part("minute")} UK · ${kind} · ${describe(kind, fields)}\n`);
  } catch { console.error("[roam] Activity log unavailable"); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Logging must not break callers. */ } } }
}
