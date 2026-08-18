// End-to-end sweep test for the entourage watcher's ingress handling.
//
// Unlike entourage-hardening.test.ts (which exercises the exported helpers
// directly), this drives startEntourageWatcher over a real directory, because
// the properties under test are about what the *sweep* does with a hostile
// file: which flags reach the transport, and where the rejected ones land.
//
// FLAGS_DIR is read once at module load, so ENTOURAGE_FLAGS_DIR must be set
// before the import — hence the dynamic import below. node --test runs each
// test file in its own process, so this does not leak into other suites.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ent-sweep-"));
const flagsDir = path.join(tmp, "flags");
const outgoing = path.join(flagsDir, "outgoing");
const archive = path.join(flagsDir, "archive");
fs.mkdirSync(outgoing, { recursive: true });
fs.mkdirSync(archive, { recursive: true });

process.env.ENTOURAGE_FLAGS_DIR = flagsDir;
process.env.ENTOURAGE_RECIPIENT = "+44ADMIN";

const { startEntourageWatcher } = await import("../src/entourage-watcher.js");

const calls: { to: string; text: string }[] = [];
const transport = {
  sendText: async (to: string, text: string) => { calls.push({ to, text }); },
  sendFile: async (to: string, _b: Buffer, _n: string, _m: string, caption: string) => { calls.push({ to, text: caption }); },
} as any;

const watcher = startEntourageWatcher(transport);
after(() => watcher.stop());

// The sweep is on a 5 s timer and fs.watch fires within ~100 ms; poll rather
// than sleep a fixed amount so the test is fast in the common case and still
// correct if fs.watch does not fire on this platform.
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("entourage sweep", () => {
  it("rejects a symlinked flag without reading its target", async () => {
    // A file the daemon can read, outside the ingress, shaped like a valid
    // flag: if the symlink were followed, its text would be relayed.
    const target = path.join(tmp, "outside.json");
    fs.writeFileSync(target, JSON.stringify({
      id: "symlink-victim", type: "message", timestamp: Date.now(),
      targetChatJid: "+44X", text: "LEAKED-SECRET-CONTENT",
    }));

    const link = path.join(outgoing, "planted.json");
    fs.symlinkSync(target, link);

    await waitFor(() => fs.existsSync(path.join(archive, "planted.json.rejected")));

    assert.ok(
      fs.existsSync(path.join(archive, "planted.json.rejected")),
      "symlinked flag should be archived as .rejected",
    );
    assert.equal(
      calls.filter((c) => c.text.includes("LEAKED-SECRET-CONTENT")).length,
      0,
      "the symlink target's contents must never be relayed",
    );
    // Archived as a symlink, not as a copy of the target: the rename moves the
    // link itself, so the target is still untouched where it was.
    assert.ok(fs.lstatSync(path.join(archive, "planted.json.rejected")).isSymbolicLink());
    assert.ok(fs.existsSync(target));
  });

  it("relays a well-formed flag to the pinned recipient and archives it", async () => {
    const p = path.join(outgoing, "good.json");
    fs.writeFileSync(p, JSON.stringify({
      id: "good-1", type: "message", timestamp: Date.now(),
      targetChatJid: "+4999ATTACKER", text: "hello from the laptop",
    }));

    await waitFor(() => calls.some((c) => c.text === "hello from the laptop"));

    const sent = calls.find((c) => c.text === "hello from the laptop");
    assert.ok(sent, "well-formed flag should be relayed");
    assert.equal(sent!.to, "+44ADMIN", "must go to the pinned recipient, not the flag's target");
    await waitFor(() => fs.existsSync(path.join(archive, "good.json")));
    assert.ok(fs.existsSync(path.join(archive, "good.json")));
  });
});
