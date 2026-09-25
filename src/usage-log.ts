import fs from "node:fs";
import path from "node:path";
import { dataDir, usageSummaryMaxBytes, type ModelBackend } from "./config.js";

export interface UsageCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  /** The model that actually answered (Claude reports it per call); null when unknown. */
  resolvedModel?: string | null;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function modelUsage(backend: ModelBackend, stdout: string): UsageCounts {
  const counts: UsageCounts = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, resolvedModel: null };
  for (const line of backend === "claude" ? [stdout] : stdout.split("\n")) {
    try {
      const envelope = JSON.parse(line);
      if (backend === "codex" && envelope?.type !== "turn.completed") continue;
      if (backend === "claude") counts.resolvedModel = mainModel(envelope?.modelUsage);
      const usage = envelope?.usage;
      const fields = {
        inputTokens: tokenCount(usage?.input_tokens), outputTokens: tokenCount(usage?.output_tokens),
        cacheReadTokens: tokenCount(backend === "claude" ? usage?.cache_read_input_tokens : usage?.cached_input_tokens),
        cacheCreationTokens: backend === "claude" ? tokenCount(usage?.cache_creation_input_tokens) : null,
        costUsd: backend === "claude" ? cost(envelope?.total_cost_usd) : null,
      };
      for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
        if (fields[key] !== null) counts[key] = (counts[key] ?? 0) + fields[key];
      }
    } catch { /* Missing, incomplete or malformed usage is unknown, never zero. */ }
  }
  return counts;
}

/** A call can include small helper calls on other models; the main one produced the most output. */
function mainModel(perModel: unknown): string | null {
  if (!perModel || typeof perModel !== "object") return null;
  let best: string | null = null, bestOut = -1;
  for (const [name, value] of Object.entries(perModel as Record<string, any>)) {
    const out = tokenCount(value?.outputTokens) ?? 0;
    if (/^[A-Za-z0-9._:-]{1,100}$/.test(name) && out > bestOut) { best = name; bestOut = out; }
  }
  return best;
}

/** Claude's own short reason for a failed call (error subtype and message), capped; never a model reply. */
export function claudeErrorSummary(stdout: string): string {
  try {
    const envelope = JSON.parse(stdout);
    const subtype = typeof envelope?.subtype === "string" ? envelope.subtype : "";
    const message = envelope?.is_error && typeof envelope?.result === "string" ? envelope.result : "";
    const text = [subtype, message].filter(Boolean).join(": ").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
    return text ? text.slice(0, 200) : "no reason given";
  } catch { return stdout.trim() ? "unreadable output" : "no output"; }
}

export function claudeResult(stdout: string): string {
  const envelope = JSON.parse(stdout);
  if (envelope?.is_error) {
    console.error(`[model] claude error: ${claudeErrorSummary(stdout)}`);
    throw new Error("claude returned an error result");
  }
  if (typeof envelope?.result !== "string") throw new Error("Invalid claude result envelope");
  return envelope.result.trim();
}

export function recordUsage(record: UsageCounts & {
  step?: string; backend: ModelBackend; model: string; ok: boolean; durationMs: number;
}): void {
  let fd: number | undefined;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    fd = fs.openSync(path.join(dataDir, "usage.jsonl"), fs.constants.O_WRONLY | fs.constants.O_APPEND
      | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    if (!fs.fstatSync(fd).isFile()) return;
    fs.fchmodSync(fd, 0o600);
    // Select fields explicitly: no prompts, replies, session or chat identifiers.
    fs.writeSync(fd, JSON.stringify({ timestamp: Date.now(), step: record.step ?? null,
      backend: record.backend, model: record.model,
      resolvedModel: typeof record.resolvedModel === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(record.resolvedModel) ? record.resolvedModel : null,
      ok: record.ok,
      inputTokens: tokenCount(record.inputTokens), outputTokens: tokenCount(record.outputTokens),
      cacheReadTokens: tokenCount(record.cacheReadTokens), cacheCreationTokens: tokenCount(record.cacheCreationTokens),
      costUsd: cost(record.costUsd), durationMs: Math.max(0, Math.round(record.durationMs)),
    }) + "\n");
  } catch { /* Accounting must never break a model call. */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Best effort. */ } } }
}

/** Summarise only complete records in a bounded tail; never scan the whole log. */
export function usageSummary(now = Date.now()): string {
  let fd: number | undefined;
  let lines: string[] = [], truncated = false;
  try {
    fd = fs.openSync(path.join(dataDir, "usage.jsonl"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return "Usage: unavailable";
    const start = Math.max(0, stat.size - usageSummaryMaxBytes);
    truncated = start > 0;
    const bytes = Buffer.alloc(stat.size - start);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, start + read);
      if (!n) break;
      read += n;
    }
    lines = bytes.subarray(0, read).toString("utf8").split("\n");
    if (start) lines.shift(); // May begin within a record or UTF-8 character.
    lines.pop(); // Ignore an unfinished append, even if it happens to parse as JSON.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "Usage: unavailable";
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Best effort. */ } } }

  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
  type Totals = { calls: number; sums: number[]; known: number[] };
  const windows = [new Map<string, Totals>(), new Map<string, Totals>()];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || !Number.isFinite(entry.timestamp) || entry.timestamp > now
        || typeof entry.model !== "string" || !entry.model || typeof entry.ok !== "boolean"
        || (entry.backend !== "claude" && entry.backend !== "codex")) continue;
      for (const [i, days] of [1, 7].entries()) {
        if (entry.timestamp < now - days * 86400000) continue;
        const shown = typeof entry.resolvedModel === "string" && entry.resolvedModel ? entry.resolvedModel : entry.model;
        const key = `${entry.backend}/${shown.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100)}`;
        const total = windows[i].get(key) ?? { calls: 0, sums: [0, 0, 0, 0], known: [0, 0, 0, 0] };
        total.calls++;
        fields.forEach((field, index) => {
          const count = tokenCount(entry[field]);
          if (count !== null) { total.sums[index] += count; total.known[index]++; }
        });
        windows[i].set(key, total);
      }
    } catch { /* Skip corrupt records. */ }
  }
  return windows.map((models, i) => {
    const heading = `Usage (last ${i === 0 ? "24h" : "7d"}):`;
    if (!models.size) return `${heading} none`;
    return heading + "\n" + [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, total]) => {
      const count = (i: number) => !total.known[i] ? "unknown"
        : `${total.sums[i]}${total.known[i] < total.calls ? " (partial)" : ""}`;
      return `  ${model}: ${total.calls} calls; input ${count(0)}; output ${count(1)}; cache read ${count(2)}; cache creation ${count(3)}`;
    }).join("\n");
  }).join("\n") + (truncated ? "\nUsage totals are partial: bounded log tail only." : "");
}
