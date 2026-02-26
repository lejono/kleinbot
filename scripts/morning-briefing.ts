#!/usr/bin/env npx tsx
/**
 * Manually trigger a morning briefing.
 * Usage: env -u CLAUDECODE npx tsx scripts/morning-briefing.ts
 *
 * Searches the web + Moltbook feed, then prints the briefing to stdout.
 * Also updates the journal for continuity.
 */
import { initConfig } from "../src/config.js";
import { runMorningBriefing } from "../src/moltbook/cycle.js";
import fs from "fs";

initConfig("signal");

try {
  const message = await runMorningBriefing();

  const output: string[] = [];
  if (message) {
    output.push("");
    output.push("=".repeat(60));
    output.push("KLEINBOT BRIEFING");
    output.push("=".repeat(60));
    output.push("");
    output.push(message);
    output.push("");
  } else {
    output.push("");
    output.push("Nothing cleared the bar today.");
  }

  // Write to stderr (always flushed) AND stdout
  const text = output.join("\n");
  fs.writeSync(1, text + "\n");
  fs.writeSync(2, text + "\n");
} catch (err) {
  fs.writeSync(2, `Briefing error: ${err}\n`);
}
