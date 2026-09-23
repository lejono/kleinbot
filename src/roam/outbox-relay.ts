import fs from "node:fs";
import path from "node:path";
import { roamConfig } from "../config.js";
import { readFlagFile, validateFlag, MAX_AGE_MS } from "../entourage-watcher.js";
import { containsConfiguredSecret } from "../moltbook/egress.js";
import type { Transport } from "../transport.js";

// Check each existing component; O_NOFOLLOW alone only guards the final one.
export function hasSymlink(file: string): boolean {
  let current = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return true; }
    catch (err: any) { if (err.code !== "ENOENT") throw err; }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readMarkdown(file: string, dir: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > roamConfig.maxMdBytes) throw new Error("Invalid attachment");
    if (fs.realpathSync(path.dirname(file)) !== fs.realpathSync(dir)) throw new Error("Attachment parent changed");
    const fresh = fs.lstatSync(file);
    if (fresh.dev !== stat.dev || fresh.ino !== stat.ino) throw new Error("Attachment changed");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return buffer.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

export function startOutboxRelay(transport: Transport): { stop: () => void; sweep: () => Promise<void> } {
  const channels = [
    { channel: "briefing", recipient: roamConfig.briefingChatJid, extra: false },
    { channel: "research", recipient: roamConfig.researchChatJid, extra: false },
    ...roamConfig.outboxExtraChannels.map(entry => ({ ...entry, extra: true })),
  ].flatMap(({ channel, recipient, extra }) => {
    return roamConfig.outboxDir && recipient ? [{ channel, recipient, extra, dir: path.resolve(roamConfig.outboxDir, channel) }] : [];
  });
  let stopped = false;
  let running = false;
  const seen = new Set<string>();

  const sentAt = new Map<string, number[]>();
  function remember(id: string): void {
    seen.delete(id);
    seen.add(id);
    while (seen.size > roamConfig.relaySeenLimit) seen.delete(seen.values().next().value!);
  }
  // Archives are immutable history; only inspect recent entries at startup.
  for (const { dir } of channels) {
    const archive = path.join(dir, "archive");
    try {
      if (hasSymlink(archive)) continue;
      const entries = fs.readdirSync(archive).map(name => ({ name, mtime: fs.lstatSync(path.join(archive, name)).mtimeMs }))
        .filter(e => Date.now() - e.mtime <= MAX_AGE_MS).sort((a, b) => a.mtime - b.mtime);
      for (const { name } of entries) {
        if (!name.endsWith(".json") && !name.endsWith(".json.rejected")) continue;
        try {
          const read = readFlagFile(path.join(archive, name));
          if (read.ok) { const value = JSON.parse(read.content); if (typeof value?.id === "string") remember(value.id); }
        } catch { /* Ignore damaged archive entries. */ }
      }
    } catch { /* Archive not available yet. */ }
  }

  async function sweep(): Promise<void> {
    if (stopped || running || !transport.isConnected()) return;
    running = true;
    try {
      for (const { channel, recipient, extra, dir } of channels) {
        const archive = path.join(dir, "archive");
        try {
          if (hasSymlink(archive)) throw new Error("Symlinked channel or archive");
          if (extra) {
            const mode = roamConfig.groupReadable ? 0o770 : 0o700;
            const created = fs.mkdirSync(dir, { recursive: true, mode });
            if (!fs.lstatSync(dir).isDirectory() || hasSymlink(dir)) throw new Error("Invalid channel directory");
            if (created) {
              // chmod follows symlinks; change the mode through a handle that refuses them.
              const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
              // Keep a setgid bit inherited from a shared parent: clearing it would give
              // files written by another account the wrong group. Folders that already
              // exist (and their archive/) are never re-moded; an installer owns those.
              try { fs.fchmodSync(fd, mode | (fs.fstatSync(fd).mode & 0o2000)); } finally { fs.closeSync(fd); }
            }
          }
          fs.mkdirSync(archive, { recursive: true });
          const recent = (sentAt.get(channel) || []).filter(time => Date.now() - time < 3600_000);
          sentAt.set(channel, recent);
          const entries = fs.readdirSync(dir).filter(n => n.endsWith(".json")).map(name => {
            let timestamp = fs.lstatSync(path.join(dir, name)).mtimeMs;
            try { const read = readFlagFile(path.join(dir, name)); if (read.ok) {
              const raw = JSON.parse(read.content); if (Number.isFinite(raw?.timestamp)) timestamp = raw.timestamp;
            } } catch { /* Invalid flags still count towards the sweep limit. */ }
            return { name, timestamp };
          }).sort((a, b) => a.timestamp - b.timestamp || a.name.localeCompare(b.name));
          for (const { name } of entries.slice(0, roamConfig.relayMaxPerSweep)) {
            if (recent.length >= roamConfig.relayMaxPerHour) break;
            if (stopped) break;
            const file = path.join(dir, name);
            let attachment: string | undefined;
            let rejected = false;
            try {
              if (hasSymlink(archive)) throw new Error("Symlinked channel or archive");
              const read = readFlagFile(file);
              if (!read.ok) throw new Error(read.reason);
              const raw = JSON.parse(read.content);
              const result = validateFlag(JSON.stringify({ ...raw, targetChatJid: recipient }), Date.now(), seen);
              if (!result.ok) throw new Error(result.reason);
              const flag = result.flag;
              if (typeof raw?.attachmentPath === "string") {
                let candidate = path.resolve(dir, raw.attachmentPath);
                // Relocate only the writer's UUID-named markdown after file sync.
                if (path.dirname(candidate) !== dir && path.basename(candidate) === `${raw.id}.md`
                  && path.basename(path.dirname(candidate)) === channel) {
                  candidate = path.join(dir, `${raw.id}.md`);
                }
                if (path.dirname(candidate) !== dir) throw new Error("Attachment outside channel");
                if (path.extname(candidate) === ".md" && !fs.existsSync(candidate)
                  && !hasSymlink(candidate) && Date.now() - flag.timestamp < roamConfig.relayAttachmentGraceMs) continue;
                // Renaming a rejected symlink moves the link itself, never its target.
                if (path.extname(candidate) !== ".json" && !fs.lstatSync(candidate).isDirectory()) attachment = candidate;
                if (path.extname(candidate) !== ".md" || hasSymlink(candidate)
                  || !fs.lstatSync(candidate).isFile()) throw new Error("Invalid markdown attachment");
              }
              const buffer = attachment ? readMarkdown(attachment, dir) : undefined;
              if (containsConfiguredSecret(flag.text) || (buffer && containsConfiguredSecret(buffer))) {
                remember(flag.id);
                throw new Error("Content refused by egress check");
              }
              try {
                if (!transport.isConnected()) continue;
                if (buffer) {
                  if (!await transport.sendFile(recipient, buffer, path.basename(attachment!), "text/markdown", flag.text)) continue;
                } else await transport.sendText(recipient, flag.text);
              } catch { console.warn("[roam] Outbox send deferred"); continue; }
              remember(flag.id);
              recent.push(Date.now());
            } catch {
              rejected = true;
              console.warn(`[roam] Outbox flag rejected (channel ${channel})`);
            }
            try {
              if (hasSymlink(archive)) throw new Error("Symlinked archive");
              if (attachment) fs.renameSync(attachment, path.join(archive, path.basename(attachment) + (rejected ? ".rejected" : "")));
              fs.renameSync(file, path.join(archive, name + (rejected ? ".rejected" : "")));
            } catch { console.warn(`[roam] Outbox archive failed (channel ${channel})`); }
          }
        } catch { console.warn(`[roam] Outbox channel unavailable (channel ${channel})`); }
      }
    } finally { running = false; }
  }

  const timer = channels.length ? setInterval(() => { void sweep(); }, roamConfig.relayIntervalMs) : undefined;
  return { sweep, stop() { stopped = true; if (timer) clearInterval(timer); } };
}
