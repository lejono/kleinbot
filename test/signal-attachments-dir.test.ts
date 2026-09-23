import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { signalAttachmentsDir } from "../src/signal.js";

// signal-cli stores received attachments under its *config* directory
// (`<config>/attachments/`). The daemon launcher hands that directory to
// signal-cli via SIGNAL_CLI_CONFIG_DIR, so the bot must derive the attachments
// path from the same variable rather than assume the XDG default. Assuming the
// default meant every attachment path the bot recorded was wrong on a host
// that runs signal-cli with --config.
describe("signalAttachmentsDir", () => {
  it("uses SIGNAL_CLI_CONFIG_DIR when set", () => {
    const dir = signalAttachmentsDir({ SIGNAL_CLI_CONFIG_DIR: "/srv/signal-data" });
    assert.equal(dir, path.join("/srv/signal-data", "attachments"));
  });

  it("prefers the config dir over XDG_DATA_HOME", () => {
    const dir = signalAttachmentsDir({ SIGNAL_CLI_CONFIG_DIR: "/a", XDG_DATA_HOME: "/b" });
    assert.equal(dir, path.join("/a", "attachments"));
  });

  it("falls back to XDG_DATA_HOME/signal-cli", () => {
    const dir = signalAttachmentsDir({ XDG_DATA_HOME: "/srv/xdg" });
    assert.equal(dir, path.join("/srv/xdg", "signal-cli", "attachments"));
  });

  it("falls back to ~/.local/share/signal-cli when nothing is set", () => {
    const dir = signalAttachmentsDir({ HOME: "/home/bot" });
    assert.equal(dir, path.join("/home/bot", ".local", "share", "signal-cli", "attachments"));
  });

  it("ignores an empty SIGNAL_CLI_CONFIG_DIR", () => {
    const dir = signalAttachmentsDir({ SIGNAL_CLI_CONFIG_DIR: "  ", HOME: "/home/bot" });
    assert.equal(dir, path.join("/home/bot", ".local", "share", "signal-cli", "attachments"));
  });
});
