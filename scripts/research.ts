import { runResearch } from "../src/research/classify.js";

try {
  const result = await runResearch();
  if (result) console.log(`[research] ${result.captured} captured, ${result.classified} classified, ${result.organising} organising`);
} catch (err) {
  console.error("[research] Run failed:", err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
}
