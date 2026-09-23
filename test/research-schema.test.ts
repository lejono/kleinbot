import assert from "node:assert/strict";
import { it } from "node:test";
import { validateResult } from "../src/research/schema.js";
import type { PostRecord } from "../src/research/corpus.js";
import { researchConfig } from "../src/config.js";
import { sanitiseText } from "../src/research/summary.js";

it("rejects duplicate-only codes and preserves validity when classifications are reloaded", () => {
  const post: PostRecord = {
    type: "post", platform: "moltbook", id: "sample", capturedAt: "2026-01-01",
    createdAt: "2026-01-01", title: "Voting", content: "A vote allocates tokens.",
    author: "test-agent", submolt: "test", upvotes: 0, commentCount: 0,
  };
  const result = { id: post.id, isOrganising: true, confidence: 0.8,
    codes: ["voting", "voting"], quote: "A vote allocates tokens." };
  assert.equal(validateResult(result, post), null);
  assert.equal(validateResult({ ...result, codes: ["voting", "x".repeat(researchConfig.maxCodeChars + 1)] }, post), null);
  const valid = validateResult({ ...result, codes: ["voting", "allocation", "voting"] }, post);
  assert.ok(valid);
  assert.deepEqual(valid.codes, ["voting", "allocation"]);
  assert.deepEqual(validateResult(JSON.parse(JSON.stringify(valid)), post), valid);
});

it("removes non-HTTP URLs from unverified quotes", () => {
  assert.equal(sanitiseText("Before ftp://example.invalid/file mailto:agent@example.invalid data:text/plain,unsafe After"), "Before After");
});
