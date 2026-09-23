// Watches the orchestrator's outgoing flag directory for replies and queries,
// then relays them via the active transport (Signal, WhatsApp, etc.).

import fs from "fs";
import os from "os";
import path from "path";
import type { Transport } from "./transport.js";

const FLAGS_DIR = process.env.ENTOURAGE_FLAGS_DIR
  || path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`, "entourage", "flags");
const OUTGOING_DIR = path.join(FLAGS_DIR, "outgoing");
const ARCHIVE_DIR = path.join(FLAGS_DIR, "archive");

const SWEEP_INTERVAL_MS = 5_000; // Check every 5 seconds

interface OutgoingFlag {
  id: string;
  type: "reply" | "query" | "message";
  timestamp: number;
  targetChatJid: string;
  text: string;
  // Optional path to a local file kleinbot should attach. Only the path
  // travels in the flag; kleinbot reads the bytes from disk itself.
  attachmentPath?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function mimeForPath(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] || "application/octet-stream";
}

export interface AttachmentOpts {
  allowRoots: string[];
  maxBytes: number;
}

export type ResolvedAttachment =
  | { ok: true; buffer: Buffer; fileName: string; mimetype: string }
  | { ok: false; reason: string };

// Where agents are allowed to attach files from. Defends against a buggy flag
// asking us to ship, say, a token file to Signal. Trusted, local roots only.
// ENTOURAGE_ALLOW_ROOTS (colon-separated absolute paths), when set, replaces
// this built-in list wholesale — useful for tests and for non-standard
// deployment layouts (e.g. the Mac migration). Computed once at import time;
// tests that need a different value should pass an explicit `opts` to
// resolveAttachment/relayFlag rather than relying on this default.
// .filter(Boolean) guards against ENTOURAGE_ALLOW_ROOTS="" (set but empty):
// "".split(":") is [""], and path.resolve("") is the current working
// directory — without the filter, an empty env var would silently allow-root
// the CWD.
const DEFAULT_ALLOW_ROOTS = process.env.ENTOURAGE_ALLOW_ROOTS
  ? process.env.ENTOURAGE_ALLOW_ROOTS.split(":").filter(Boolean)
  : [
      path.join(os.homedir(), "tmp"),
      path.join(os.homedir(), "Dropbox"),
      path.join(os.homedir(), "src", "team"),
      process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`,
    ];
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const DEFAULT_RELAY_OPTS: AttachmentOpts = {
  allowRoots: DEFAULT_ALLOW_ROOTS,
  maxBytes: DEFAULT_MAX_BYTES,
};

// True if realpath(candidate) is one of realpath(allowRoots) or lives under it.
function isWithinAllowRoots(real: string, allowRoots: string[]): boolean {
  return allowRoots.some((root) => {
    let r: string;
    try {
      r = fs.realpathSync(path.resolve(root));
    } catch {
      return false;
    }
    return real === r || real.startsWith(r + path.sep);
  });
}

// Resolves an attachment path against the allowlist and reads its bytes.
// Hardened against symlink/TOCTOU escapes: both the candidate path and each
// allow-root are resolved via realpath (so a symlinked file OR a symlinked
// parent directory that points outside the allowed roots is rejected, not
// just a lexical prefix match on the un-resolved path), and the open uses
// O_NOFOLLOW so a symlink swapped in for the final path component between
// the realpath check and the open (TOCTOU) fails closed rather than
// silently following the link.
//
// Residual limitation: O_NOFOLLOW only guards the *final* path component of
// `real`, not the intermediate directory components. Node has no
// openat()-style component-by-component walk, so if an *ancestor* directory
// of `real` is swapped for a symlink in the (tiny) window between the
// realpathSync above and the openSync below, the open can still land outside
// the allow-roots. We narrow — but cannot fully close — that race with a
// post-open cross-check: re-resolve the original path and compare its
// dev/ino against the already-open fd's dev/ino; any mismatch, or the
// re-resolved path no longer being within the allow-roots, is treated as a
// race and rejected. A same-user attacker who can rename directories in a
// tight loop while this function runs could still theoretically win the
// remaining window; this containment is a defence against buggy/spoofed flag
// paths (the actual threat model here), not against an attacker already
// executing code as this user.
export function resolveAttachment(
  attachmentPath: string,
  opts: AttachmentOpts,
): ResolvedAttachment {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(attachmentPath));
  } catch {
    return { ok: false, reason: "file not found" };
  }

  if (!isWithinAllowRoots(real, opts.allowRoots)) {
    return { ok: false, reason: "outside allowed roots" };
  }

  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "unreadable or symlink" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > opts.maxBytes) {
      return { ok: false, reason: `file too large (${st.size} bytes)` };
    }

    // Post-open cross-check (see comment above): re-resolve the original
    // path now that we hold an open fd, and confirm it still points at the
    // same inode and still lives under an allow-root. Catches an ancestor
    // directory being swapped for a symlink during the open.
    let reResolved: string;
    try {
      reResolved = fs.realpathSync(path.resolve(attachmentPath));
    } catch {
      return { ok: false, reason: "path changed during open" };
    }
    if (!isWithinAllowRoots(reResolved, opts.allowRoots)) {
      return { ok: false, reason: "path changed during open" };
    }
    let reStat: fs.Stats;
    try {
      reStat = fs.statSync(reResolved);
    } catch {
      return { ok: false, reason: "path changed during open" };
    }
    if (reStat.dev !== st.dev || reStat.ino !== st.ino) {
      return { ok: false, reason: "path changed during open" };
    }

    const buffer = Buffer.alloc(st.size);
    fs.readSync(fd, buffer, 0, st.size, 0);
    return {
      ok: true,
      buffer,
      fileName: path.basename(real),
      mimetype: mimeForPath(real),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export type RelayResult = { ok: true } | { ok: false; reason: string };

/**
 * Relay one flag over the transport: send the attachment as a real file when
 * present and valid; otherwise send text. If an attachment is named but can't
 * be read, fall back to text + a note so the alert is never silently lost.
 *
 * The destination is ALWAYS the pinned `recipient` — an entourage flag is a
 * command from the laptop, and the laptop does not get to choose where
 * kleinbot sends. There is deliberately no fallback to `flag.targetChatJid`:
 * with no pinned recipient configured there is no safe destination, so the
 * flag is refused (fail closed) and the caller archives it as `.rejected`.
 * Falling back to the flag's own field would let anything that can write into
 * the ingress directory exfiltrate an attachment to a number of its choosing.
 */
export async function relayFlag(
  transport: Transport,
  flag: OutgoingFlag,
  opts: AttachmentOpts = DEFAULT_RELAY_OPTS,
  recipient?: string,
): Promise<RelayResult> {
  if (!recipient) return { ok: false, reason: "no pinned recipient configured" };
  const to = recipient;
  if (flag.attachmentPath) {
    const r = resolveAttachment(flag.attachmentPath, opts);
    if (r.ok) {
      await transport.sendFile(
        to,
        r.buffer,
        r.fileName,
        r.mimetype,
        flag.text,
      );
      return { ok: true };
    }
    await transport.sendText(
      to,
      `${flag.text}\n[attachment unavailable: ${r.reason}]`,
    );
    return { ok: true };
  }
  await transport.sendText(to, flag.text);
  return { ok: true };
}

const MAX_FLAG_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 4000;
export const MAX_AGE_MS = 48 * 3600_000;
export const MAX_FUTURE_MS = 5 * 60_000;
const MAX_SEEN_IDS = 500;

// True when a file's on-disk size alone already exceeds the flag size cap.
// Exported so readFlagFile can fstat() the open fd and reject via this cheap
// check *before* reading it into memory — validateFlag's own byte-size check
// runs on an already-buffered string, which is too late to stop a multi-GB
// file in OUTGOING_DIR from being fully read into memory first.
export function exceedsMaxFlagBytes(size: number): boolean {
  return size > MAX_FLAG_BYTES;
}

export type FlagRead = { ok: true; content: string } | { ok: false; reason: string };

// Reads one flag file the same way attachments are opened: O_NOFOLLOW, so a
// symlink planted in the ingress directory is refused rather than followed,
// and the size guard runs on fstat() of the already-open fd rather than on a
// stat() of the path (which a symlink would resolve elsewhere, and which is a
// TOCTOU window besides).
//
// The rrsync jail the relay writes through (`rrsync -wo -no-del`) does not
// prevent symlink *creation*, so a compromised relay key could otherwise
// point a .json flag at /dev/zero (unbounded read) or at any file this
// account can read (the size guard would pass, and the contents would be
// parsed as a flag). Both fail closed here: the open itself raises ELOOP.
export function readFlagFile(filePath: string): FlagRead {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw err; // already processed — caller's ENOENT path
    return { ok: false, reason: "unreadable or symlink" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (exceedsMaxFlagBytes(st.size)) return { ok: false, reason: "flag too large" };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { ok: true, content: buf.subarray(0, read).toString("utf-8") };
  } finally {
    fs.closeSync(fd);
  }
}

// Validates and sanitizes a raw flag payload before it's trusted: enforces a
// size cap (defends against a runaway/malicious writer), a strict schema, a
// freshness window (rejects stale replays and clock-skewed future flags), an
// id-replay check against the in-memory `seen` set, and strips control
// characters from text (defends against terminal-escape smuggling, including
// carriage-return line-overwrite spoofing, into the relayed message).
// Returns the reason (never the raw content) on rejection so callers can log
// safely.
//
// `targetChatJid` is still REQUIRED even though it no longer routes anything
// (relayFlag pins the recipient by configuration). Both legitimate writers —
// write_reply_flag()/write_message_flag() in the orchestrator — always set it,
// and the laptop-side parse_flag() lists it in REQUIRED_FIELDS, so dropping
// the check would only widen the accepted shape to one no real writer emits.
export function validateFlag(raw: string, now: number, seen: Set<string>):
  { ok: true; flag: OutgoingFlag } | { ok: false; reason: string } {
  if (Buffer.byteLength(raw, "utf-8") > MAX_FLAG_BYTES) return { ok: false, reason: "flag too large" };
  let f: any;
  try { f = JSON.parse(raw); } catch { return { ok: false, reason: "invalid JSON" }; }
  if (typeof f.id !== "string" || !f.id) return { ok: false, reason: "missing id" };
  if (seen.has(f.id)) return { ok: false, reason: "duplicate id" };
  if (!["reply", "query", "message"].includes(f.type)) return { ok: false, reason: "bad type" };
  if (typeof f.timestamp !== "number") return { ok: false, reason: "missing timestamp" };
  if (now - f.timestamp > MAX_AGE_MS) return { ok: false, reason: "stale flag" };
  if (f.timestamp - now > MAX_FUTURE_MS) return { ok: false, reason: "future timestamp" };
  if (typeof f.targetChatJid !== "string" || !f.targetChatJid) return { ok: false, reason: "missing targetChatJid" };
  if (typeof f.text !== "string" && !f.attachmentPath) return { ok: false, reason: "no content" };
  // C0 (minus \t\n), DEL, C1, and the Unicode bidi/format controls that can
  // reorder or hide text in a message or a log line: zero-width + LRM/RLM
  // (200B-200F), line/paragraph separators and the bidi embeddings/overrides
  // (2028-202E), the directional isolates (2066-2069), and BOM/ZWNBSP (FEFF).
  const text = String(f.text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "").slice(0, MAX_TEXT_CHARS);
  if (f.attachmentPath !== undefined && typeof f.attachmentPath !== "string") return { ok: false, reason: "bad attachmentPath" };
  return { ok: true, flag: { id: f.id, type: f.type, timestamp: f.timestamp, targetChatJid: f.targetChatJid, text, attachmentPath: f.attachmentPath } };
}

export interface WatcherOpts {
  forcedRecipient?: string;
}

export function startEntourageWatcher(transport: Transport, opts?: WatcherOpts): { stop: () => void } {
  // readFlagFile's O_NOFOLLOW guards the final path component only; the
  // directories above it are unguarded, and FLAGS_DIR *is* the rrsync ingress
  // root the relay key can write into. A holder of that key can
  // `ln -s ~/.claude outgoing`, at which point the sweep renames every *.json
  // it finds there into archive/*.rejected — destructive (files moved out from
  // under whatever owns them), even though the `-wo` jail means nothing can be
  // read back. Refuse to sweep at all in that case, before ensureDirs() runs:
  // mkdir(..., {recursive:true}) would otherwise happily create `outgoing`
  // *through* a symlinked FLAGS_DIR.
  //
  // existsSync first because on a clean host none of these exist yet — the
  // watcher creates them. A dangling symlink reads as non-existent here but
  // fails ensureDirs()'s mkdir with ENOTDIR, so it does not slip through.
  for (const d of [FLAGS_DIR, OUTGOING_DIR, ARCHIVE_DIR]) {
    if (fs.existsSync(d) && fs.lstatSync(d).isSymbolicLink()) {
      throw new Error(`[entourage-watcher] ${d} is a symlink — refusing to sweep`);
    }
  }

  let stopped = false;
  const processing = new Set<string>();
  const seenIds = new Set<string>();

  async function ensureDirs(): Promise<void> {
    await fs.promises.mkdir(OUTGOING_DIR, { recursive: true });
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
  }

  async function processFlag(filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return;
    if (processing.has(filePath)) return;

    processing.add(filePath);
    async function reject(reason: string): Promise<void> {
      console.warn(`[entourage-watcher] Rejected flag ${filename}: ${reason}`);
      await fs.promises.rename(filePath, path.join(ARCHIVE_DIR, filename + ".rejected"));
    }

    try {
      // Symlink-safe open + fstat size guard before anything is buffered: a
      // multi-GB file (or a symlink to /dev/zero) dropped in OUTGOING_DIR
      // must not be read into memory just to discover it is oversized, and a
      // symlink must not be followed at all. See readFlagFile.
      const readResult = readFlagFile(filePath);
      if (!readResult.ok) {
        await reject(readResult.reason);
        return;
      }

      const result = validateFlag(readResult.content, Date.now(), seenIds);

      if (!result.ok) {
        await reject(result.reason);
        return;
      }
      const flag = result.flag;

      seenIds.add(flag.id);
      if (seenIds.size > MAX_SEEN_IDS) {
        const oldest = seenIds.values().next().value;
        if (oldest !== undefined) seenIds.delete(oldest);
      }

      // The destination is pinned by configuration, never by the flag. With
      // none configured we refuse rather than fall back to flag.targetChatJid
      // (which the flag writer controls) — see relayFlag.
      const recipient = opts?.forcedRecipient ?? process.env.ENTOURAGE_RECIPIENT ?? process.env.SIGNAL_ADMIN_NUMBER;
      if (recipient && recipient !== flag.targetChatJid) {
        console.warn(`[entourage-watcher] Overriding flag targetChatJid (${flag.targetChatJid}) with pinned recipient`);
      }

      const note = flag.attachmentPath ? ` (+attachment)` : "";
      console.log(`[entourage-watcher] Relaying ${flag.type} to ${recipient ?? "<unpinned>"}${note}: ${(flag.text || "").slice(0, 80)}`);
      const relayed = await relayFlag(transport, flag, undefined, recipient);
      if (!relayed.ok) {
        await reject(relayed.reason);
        return;
      }

      // Archive the processed flag
      const dest = path.join(ARCHIVE_DIR, filename);
      await fs.promises.rename(filePath, dest);
    } catch (err: any) {
      if (err.code === "ENOENT") return; // Already processed
      console.error(`[entourage-watcher] Error processing ${filename}:`, err.message);
    } finally {
      processing.delete(filePath);
    }
  }

  async function sweep(): Promise<void> {
    if (stopped) return;
    try {
      const entries = await fs.promises.readdir(OUTGOING_DIR);
      for (const entry of entries.sort()) {
        if (entry.endsWith(".json") && !entry.endsWith(".tmp")) {
          await processFlag(path.join(OUTGOING_DIR, entry));
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  // Set up inotify watcher + periodic sweep
  let watcher: fs.FSWatcher | null = null;

  ensureDirs().then(() => {
    try {
      watcher = fs.watch(OUTGOING_DIR, (event, filename) => {
        if (stopped || !filename || event !== "rename") return;
        setTimeout(() => {
          processFlag(path.join(OUTGOING_DIR, filename));
        }, 100);
      });
      console.log(`[entourage-watcher] Watching ${OUTGOING_DIR}`);
    } catch {
      console.log("[entourage-watcher] fs.watch failed, using sweep only");
    }
  });

  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(sweepTimer);
      console.log("[entourage-watcher] Stopped");
    },
  };
}
