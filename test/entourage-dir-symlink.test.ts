// The ingress *directories* are as much part of the attack surface as the flag
// files in them: FLAGS_DIR is the rrsync jail root the relay key writes into,
// and OUTGOING_DIR/ARCHIVE_DIR are derived from it. readFlagFile's O_NOFOLLOW
// protects the final path component only, so a symlinked `outgoing` would have
// the sweep rename()ing every *.json out of whatever directory it points at.
//
// FLAGS_DIR is read once at module load, so ENTOURAGE_FLAGS_DIR must be set
// before the import — hence the dynamic import below. node --test runs each
// test file in its own process, so this does not leak into other suites.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ent-dirlink-"));
const flagsDir = path.join(tmp, "flags");
fs.mkdirSync(flagsDir, { recursive: true });
fs.mkdirSync(path.join(flagsDir, "archive"), { recursive: true });

// The victim directory the planted link points at, with a file the sweep
// would otherwise rename into archive/*.rejected.
const victim = path.join(tmp, "victim");
fs.mkdirSync(victim, { recursive: true });
fs.writeFileSync(path.join(victim, "settings.json"), "{}");
fs.symlinkSync(victim, path.join(flagsDir, "outgoing"));

process.env.ENTOURAGE_FLAGS_DIR = flagsDir;
process.env.ENTOURAGE_RECIPIENT = "+44ADMIN";

const { startEntourageWatcher } = await import("../src/entourage-watcher.js");

const transport = {
  sendText: async () => {},
  sendFile: async () => {},
} as any;

describe("entourage ingress directories", () => {
  it("refuses to start when the outgoing directory is a symlink", () => {
    assert.throws(
      () => startEntourageWatcher(transport),
      /outgoing is a symlink — refusing to sweep/,
    );
    // Nothing was swept out of the link's target.
    assert.ok(fs.existsSync(path.join(victim, "settings.json")));
    assert.equal(
      fs.existsSync(path.join(flagsDir, "archive", "settings.json.rejected")),
      false,
    );
  });
});
