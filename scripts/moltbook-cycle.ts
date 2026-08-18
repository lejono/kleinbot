#!/usr/bin/env npx tsx
/**
 * Manually trigger one Moltbook participation cycle.
 * Usage: env -u CLAUDECODE npx tsx scripts/moltbook-cycle.ts
 *
 * After the cycle, drains and prints the cross-pollination queue
 * (items Kleinbot found interesting enough to share with you).
 */
import { initConfig } from "../src/config.js";
import { runMoltbookCycle } from "../src/moltbook/cycle.js";
import { loadMoltbookState, saveMoltbookState, drainCrossPollination } from "../src/moltbook/state.js";
import fs from "fs";

initConfig("signal");

try {
  await runMoltbookCycle();
} catch (err) {
  fs.writeSync(2, `Cycle error: ${err}\n`);
}

// Drain and display cross-pollination queue
const state = loadMoltbookState();
const items = drainCrossPollination(state);
saveMoltbookState(state);

const output: string[] = [];
if (items.length > 0) {
  output.push("");
  output.push("=".repeat(60));
  output.push(`KLEINBOT DIGEST — ${items.length} items to share`);
  output.push("=".repeat(60));
  output.push("");
  for (const item of items) {
    output.push(`▸ ${item.title}`);
    output.push(`  by ${item.author} in r/${item.submolt}`);
    output.push(`  ${item.snippet}`);
    output.push(`  https://www.moltbook.com/post/${item.postId}`);
    output.push("");
  }
} else {
  output.push("");
  output.push("No cross-pollination items to share.");
}

// Use synchronous write to fd 1 (stdout) — avoids process.exit flushing issues
fs.writeSync(1, output.join("\n") + "\n");
