import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMorningBriefingDue,
  markRunToday,
  recordMorningBriefingAttempt,
  recordMorningBriefingFailure,
} from "../src/moltbook/state.js";
import type { MoltbookState } from "../src/moltbook/types.js";

function baseState(overrides: Partial<MoltbookState> = {}): MoltbookState {
  return {
    seenPostIds: [],
    lastCycleTimestamp: 0,
    lastCycleAttemptAt: 0,
    crossPollinationQueue: [],
    lastPostTimestamp: 0,
    commentTimestamps: [],
    lastRunDate: "",
    briefingAttemptDate: "",
    briefingAttemptCount: 0,
    briefingLastAttemptAt: 0,
    ...overrides,
  };
}

describe("morning briefing schedule", () => {
  it("is not due before 05:30 UK time", () => {
    const now = new Date("2026-05-02T04:29:00.000Z");

    assert.equal(isMorningBriefingDue(baseState(), now), false);
  });

  it("is due after 05:30 UK time with no run or attempts today", () => {
    const now = new Date("2026-05-02T04:30:00.000Z");

    assert.equal(isMorningBriefingDue(baseState(), now), true);
  });

  it("waits six hours after the first failed attempt", () => {
    const state = baseState();
    const first = new Date("2026-05-02T05:00:00.000Z");
    recordMorningBriefingAttempt(state, first);
    recordMorningBriefingFailure(state, "claude exited with code 1");

    assert.equal(isMorningBriefingDue(state, new Date("2026-05-02T10:59:00.000Z")), false);
    assert.equal(isMorningBriefingDue(state, new Date("2026-05-02T11:00:00.000Z")), true);
  });

  it("drops until the next UK day after the second failed attempt", () => {
    const state = baseState();
    recordMorningBriefingAttempt(state, new Date("2026-05-02T05:00:00.000Z"));
    recordMorningBriefingFailure(state, "first failure");
    recordMorningBriefingAttempt(state, new Date("2026-05-02T11:00:00.000Z"));
    recordMorningBriefingFailure(state, "second failure");

    assert.equal(isMorningBriefingDue(state, new Date("2026-05-02T21:00:00.000Z")), false);
    assert.equal(isMorningBriefingDue(state, new Date("2026-05-03T04:30:00.000Z")), true);
  });

  it("marks a successful no-message briefing as complete for the day", () => {
    const state = baseState();
    const now = new Date("2026-05-02T05:00:00.000Z");
    recordMorningBriefingAttempt(state, now);
    markRunToday(state, now);

    assert.equal(isMorningBriefingDue(state, new Date("2026-05-02T12:00:00.000Z")), false);
    assert.equal(isMorningBriefingDue(state, new Date("2026-05-03T04:30:00.000Z")), true);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initConfig, config } from "../src/config.js";
import { isCycleDue, recordCycleAttempt, loadMoltbookState } from "../src/moltbook/state.js";

it("paces cycle attempts, including failed cycles and old state files", () => {
  const state = baseState();
  assert.equal(isCycleDue(state, 1000, 100), true);
  recordCycleAttempt(state, 1000);
  assert.equal(isCycleDue(state, 1099, 100), false);
  assert.equal(isCycleDue(state, 1100, 100), true);
  assert.equal(isCycleDue(state, 999, 100), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-state-"));
  initConfig("signal");
  const original = config.moltbookStateFile;
  try {
    config.moltbookStateFile = path.join(dir, "state.json");
    const { lastCycleAttemptAt, ...old } = state;
    fs.writeFileSync(config.moltbookStateFile, JSON.stringify(old));
    assert.equal(loadMoltbookState().lastCycleAttemptAt, 0);
  } finally {
    config.moltbookStateFile = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("retains only the most recent fifty cross-pollination items", async () => {
  const { enqueueCrossPollination, loadMoltbookState } = await import("../src/moltbook/state.js");
  const state = loadMoltbookState(); state.crossPollinationQueue = [];
  const items = Array.from({ length: 60 }, (_, i) => ({ postId: `synthetic-${i}`, title: "Title", author: "Agent", snippet: "Text", submolt: "test" }));
  enqueueCrossPollination(state, items.slice(0, 40)); enqueueCrossPollination(state, items.slice(40));
  assert.deepEqual(state.crossPollinationQueue, items.slice(10));
});
