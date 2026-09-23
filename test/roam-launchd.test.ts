import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

it("refuses roam startup before reading defaults when either required directory is unset", () => {
  for (const missing of ["HOME", "KLEINBOT_RUNTIME_DIR"]) {
    const env = { ...process.env, HOME: "/synthetic/roam", KLEINBOT_RUNTIME_DIR: "/synthetic/runtime" };
    delete env[missing];
    const result = spawnSync("bash", ["scripts/macos/run-daemon.sh", "kleinbot-roam"], { env, encoding: "utf8" });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /requires explicit HOME and KLEINBOT_RUNTIME_DIR/);
  }
});

it("uses a separate service account, home, checkout, runtime and logs", () => {
  const plist = fs.readFileSync("scripts/macos/net.postquantum.kleinbot-roam.plist", "utf8");
  assert.match(plist, /<key>HOME<\/key><string>\/Users\/kleinbot-roam<\/string>/);
  assert.match(plist, /<key>KLEINBOT_RUNTIME_DIR<\/key><string>\/Users\/kleinbot-roam\//);
  assert.match(plist, /<key>UserName<\/key><string>kleinbot-roam<\/string>/);
  assert.doesNotMatch(plist, /\/Users\/kleinbot\//);
  assert.doesNotMatch(plist, /MOLTBOOK_API_KEY|SIGNAL_|ENTOURAGE_/);
});
