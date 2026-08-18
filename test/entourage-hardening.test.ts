// Guards against a compromised/buggy agent pointing a flag's targetChatJid at
// someone other than the configured admin. See CLAUDE.md privacy rules.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { relayFlag, resolveAttachment, validateFlag, exceedsMaxFlagBytes, readFlagFile } from "../src/entourage-watcher.js";

function fakeTransport() {
  const calls: { to: string; text: string }[] = [];
  return {
    calls,
    transport: {
      sendText: async (to: string, text: string) => { calls.push({ to, text }); },
      sendFile: async (to: string, _b: Buffer, _n: string, _m: string, caption: string) => { calls.push({ to, text: caption }); },
    } as any,
  };
}

describe("recipient pinning", () => {
  it("ignores flag targetChatJid when a pinned recipient is configured", async () => {
    const { calls, transport } = fakeTransport();
    const r = await relayFlag(transport, { id: "1", type: "message", timestamp: Date.now(), targetChatJid: "+4999ATTACKER", text: "hi" } as any, undefined, "+44ADMIN");
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "+44ADMIN");
  });

  // Fail closed: an entourage flag is a command from the laptop, and the
  // laptop does not get to choose where kleinbot sends. With no pinned
  // recipient there is no safe destination, so nothing is sent at all.
  it("refuses to send when no recipient is configured (no targetChatJid fallback)", async () => {
    const { calls, transport } = fakeTransport();
    const r = await relayFlag(transport, { id: "2", type: "message", timestamp: Date.now(), targetChatJid: "+44DEV", text: "hi" } as any);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /no pinned recipient/);
    assert.equal(calls.length, 0);
  });

  it("refuses a flag that carries only a targetChatJid, attachment included", async () => {
    const { calls, transport } = fakeTransport();
    const r = await relayFlag(
      transport,
      { id: "3", type: "message", timestamp: Date.now(), targetChatJid: "+4999ATTACKER", text: "hi", attachmentPath: "/etc/hosts" } as any,
      { allowRoots: ["/etc"], maxBytes: 1024 * 1024 },
    );
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
});

// Guards against a lexical-prefix allowlist check being defeated by a symlink
// that resolves outside the allowed roots (TOCTOU/symlink escape).
describe("attachment containment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ent-"));
  const allowed = path.join(tmp, "allowed");
  fs.mkdirSync(allowed);
  const secret = path.join(tmp, "secret.txt");
  fs.writeFileSync(secret, "s3cret");
  const opts = { allowRoots: [allowed], maxBytes: 1024 };

  it("rejects a symlink pointing outside allowed roots", () => {
    const link = path.join(allowed, "link.txt");
    fs.symlinkSync(secret, link);
    const r = resolveAttachment(link, opts);
    assert.equal(r.ok, false);
  });

  it("rejects a symlinked parent directory escaping the root", () => {
    const dirlink = path.join(allowed, "d");
    fs.symlinkSync(tmp, dirlink);
    const r = resolveAttachment(path.join(dirlink, "secret.txt"), opts);
    assert.equal(r.ok, false);
  });

  it("still accepts a regular file inside the root", () => {
    const okFile = path.join(allowed, "ok.txt");
    fs.writeFileSync(okFile, "fine");
    const r = resolveAttachment(okFile, opts);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.buffer.toString(), "fine");
  });

  // The post-open dev/ino cross-check (guarding against an ancestor
  // directory being swapped for a symlink between realpath and open) runs
  // unconditionally, so any successful resolve already exercises it. This
  // test names that path explicitly rather than relying on the assertion
  // above to cover it incidentally. The race itself can't be tested
  // deterministically (no sleeps) — this only confirms the cross-check
  // doesn't produce false positives against an unmodified, in-root file.
  it("resolves ok through the post-open cross-check for an unmodified in-root file", () => {
    const crossCheckFile = path.join(allowed, "cross-check.txt");
    fs.writeFileSync(crossCheckFile, "unmodified");
    const r = resolveAttachment(crossCheckFile, opts);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.fileName, "cross-check.txt");
      assert.equal(r.buffer.toString(), "unmodified");
    }
  });
});

// Guards against malformed, oversized, stale/future-dated, or replayed flags
// reaching the transport, and strips control characters that could smuggle
// terminal escapes into relayed text.
describe("validateFlag", () => {
  const NOW = 1_800_000_000_000;
  const base = { id: "a1", type: "message", timestamp: NOW, targetChatJid: "+44X", text: "hi" };

  it("accepts a well-formed fresh flag", () => {
    assert.equal(validateFlag(JSON.stringify(base), NOW, new Set()).ok, true);
  });

  it("rejects oversize payloads", () => {
    const big = JSON.stringify({ ...base, text: "x".repeat(20_000) });
    assert.equal(validateFlag(big, NOW, new Set()).ok, false);
  });

  it("rejects stale and far-future timestamps", () => {
    assert.equal(validateFlag(JSON.stringify({ ...base, timestamp: NOW - 49 * 3600_000 }), NOW, new Set()).ok, false);
    assert.equal(validateFlag(JSON.stringify({ ...base, timestamp: NOW + 10 * 60_000 }), NOW, new Set()).ok, false);
  });

  it("rejects a replayed id", () => {
    assert.equal(validateFlag(JSON.stringify(base), NOW, new Set(["a1"])).ok, false);
  });

  it("strips control characters from text", () => {
    const r = validateFlag(JSON.stringify({ ...base, text: "hi\x1b[31mred\x07" }), NOW, new Set());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.flag.text, "hi[31mred");
  });

  it("strips carriage returns (line-overwrite spoofing) while newline and tab survive", () => {
    const r = validateFlag(JSON.stringify({ ...base, text: "a\rb\nc\td" }), NOW, new Set());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.flag.text, "ab\nc\td");
  });

  // Still required even though relayFlag now pins the recipient by config and
  // never reads this field for routing: every legitimate writer sets it, so
  // relaxing the check would only widen the accepted shape.
  it("rejects a flag missing targetChatJid", () => {
    const { targetChatJid, ...rest } = base;
    assert.equal(validateFlag(JSON.stringify(rest), NOW, new Set()).ok, false);
    assert.equal(validateFlag(JSON.stringify({ ...base, targetChatJid: "" }), NOW, new Set()).ok, false);
  });

  // C1 controls and the Unicode bidi/format controls can reorder or hide text
  // in a relayed message or a log line (RLO spoofing, zero-width splicing).
  it("strips C1 and Unicode bidi/format controls", () => {
    const r = validateFlag(
      JSON.stringify({ ...base, text: "a\u0085b\u200bc\u202ed\u2066e\ufeff\u2028f" }),
      NOW,
      new Set(),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.flag.text, "abcdef");
  });
});

// Guards against a symlink planted in the ingress directory being followed:
// the rrsync jail the relay writes through does not prevent symlink creation,
// so a flag could otherwise point at /dev/zero (unbounded read) or at any
// file this account can read (whose contents would then be parsed as a flag).
describe("readFlagFile", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagread-"));
  const outside = path.join(tmp, "outside-secret.json");
  fs.writeFileSync(outside, JSON.stringify({ secret: "must-not-be-read" }));

  it("reads a regular file in place", () => {
    const real = path.join(tmp, "real.json");
    fs.writeFileSync(real, '{"hello":1}');
    const r = readFlagFile(real);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.content, '{"hello":1}');
  });

  it("refuses a symlink instead of following it to the target", () => {
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(outside, link);
    const r = readFlagFile(link);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unreadable or symlink");
  });

  it("refuses an oversized file on the fstat of the open fd", () => {
    const big = path.join(tmp, "big.json");
    fs.writeFileSync(big, "x".repeat(16 * 1024 + 1));
    const r = readFlagFile(big);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "flag too large");
  });

  it("refuses a directory", () => {
    const dir = path.join(tmp, "dir.json");
    fs.mkdirSync(dir);
    const r = readFlagFile(dir);
    assert.equal(r.ok, false);
  });

  // ENOENT is the "another sweep already archived it" case, which processFlag
  // handles in its own catch — it must propagate, not become a rejection.
  it("propagates ENOENT rather than reporting a rejection", () => {
    assert.throws(() => readFlagFile(path.join(tmp, "nope.json")), /ENOENT/);
  });
});

// Guards against a multi-GB file dropped in OUTGOING_DIR being fully
// buffered into memory before its size is checked (DoS). processFlag fstats
// a candidate file and consults this helper before calling readFile; the
// helper is exported so that pre-read guard is unit-testable without
// exercising processFlag's fs/watcher plumbing directly.
describe("exceedsMaxFlagBytes", () => {
  it("is false at and under the 16 KiB cap", () => {
    assert.equal(exceedsMaxFlagBytes(0), false);
    assert.equal(exceedsMaxFlagBytes(16 * 1024), false);
  });

  it("is true just over the cap and for a huge file", () => {
    assert.equal(exceedsMaxFlagBytes(16 * 1024 + 1), true);
    assert.equal(exceedsMaxFlagBytes(5 * 1024 * 1024 * 1024), true); // 5 GB
  });
});
