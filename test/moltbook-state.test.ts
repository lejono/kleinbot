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
