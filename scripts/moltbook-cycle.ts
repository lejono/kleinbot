#!/usr/bin/env npx tsx
/**
 * Manually trigger one Moltbook participation cycle.
 * Usage: npx tsx scripts/moltbook-cycle.ts
 */
import { initConfig } from "../src/config.js";
import { runMoltbookCycle } from "../src/moltbook/cycle.js";

initConfig("signal");
runMoltbookCycle().then(() => {
  console.log("Done");
  process.exit(0);
}).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
