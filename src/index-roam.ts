import { runWriteUp, writeIndex } from "./research/pages.js";
import { logActivity } from "./roam/activity-log.js";
import fs from "node:fs";
import path from "node:path";
import { config, initConfig, moltbookHeartbeatInterval, roamConfig } from "./config.js";
import { runMoltbookCycle, runMorningBriefing } from "./moltbook/cycle.js";
import { loadMoltbookState, saveMoltbookState, isCycleDue, recordCycleAttempt,
  claimMorningBriefingAttempt, hasRunToday, recordMorningBriefingFailure } from "./moltbook/state.js";
import { answerInbox } from "./roam/answer.js";
import { canWriteOutbox, writeOutboxMessage } from "./roam/outbox.js";
import { runResearch } from "./research/classify.js";
import { claimResearchRun } from "./roam/schedule.js";

initConfig("roam");
if (!config.moltbookApiKey) {
  console.error("[roam] MOLTBOOK_API_KEY is required");
  process.exit(78);
}
fs.mkdirSync(path.dirname(config.moltbookStateFile), { recursive: true, mode: 0o700 });
let inFlight = false;
let stopping = false;

async function tick(): Promise<void> {
  if (inFlight || stopping) return;
  inFlight = true;
  const jobs = [
    answerInbox,
    async () => {
      const state = loadMoltbookState();
      const now = Date.now();
      if (!isCycleDue(state, now, moltbookHeartbeatInterval)) return;
      recordCycleAttempt(state, now);
      saveMoltbookState(state);
      await runMoltbookCycle();
    },
    async () => {
      if (!canWriteOutbox("briefing")) return;
      if (!claimMorningBriefingAttempt()) return;
      try {
        const message = await runMorningBriefing();
        if (message) {
          if (writeOutboxMessage("briefing", message) !== "published") throw new Error("Briefing publication failed");
          logActivity("briefing", { status: "sent to outbox" });
        }
        else if (!hasRunToday(loadMoltbookState())) throw new Error("Briefing did not complete");
        else logActivity("briefing", { status: "no message" });
      } catch (err) {
        logActivity("briefing", { status: "failed" });
        const state = loadMoltbookState();
        recordMorningBriefingFailure(state, err);
        saveMoltbookState(state);
        throw err;
      }
    },
    async () => {
      if (!claimResearchRun()) return;
      const result = await runResearch();
      const pages = await runWriteUp();
      writeIndex();
      if (result) logActivity("research", { ...result, pagesWritten: pages.length });
      if (result) writeOutboxMessage("research",
        `Research: ${result.captured} captured, ${result.classified} classified, ${result.organising} organising, ${pages.length} pages written.`, result.summaryPath);
    },
  ];
  try {
    for (const job of jobs) {
      if (stopping) break;
      try { await job(); }
      catch (err) { console.error("[roam] Job failed:", err instanceof Error ? err.message : "unknown error"); }
    }
  } finally {
    inFlight = false;
    if (stopping) process.exit(0);
  }
}

const timer = setInterval(() => { void tick(); }, roamConfig.tickMs);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(timer);
    if (!inFlight) process.exit(0);
  });
}
void tick();
