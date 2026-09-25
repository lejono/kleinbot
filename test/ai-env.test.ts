import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

// The chat model must not inherit the bot's secrets or routing settings.
it("passes only allowlisted environment names to the chat model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-env-test-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify(process.env));
fs.readFileSync(0);
process.stdout.write(JSON.stringify({result:'{"shouldRespond": false, "response": null}'}));
`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "prompt.md"), "Synthetic prompt.");
  const invented: Record<string, string> = {
    KLEINBOT_RUNTIME_DIR: dir, CLAUDE_BIN: bin, MODEL_CHILD_ENV_ALLOW: "",
    SIGNAL_ACCOUNT: "invented-account", SIGNAL_ADMIN_NUMBER: "invented-admin-number",
    ADMIN_TEST: "invented-admin", ENTOURAGE_FLAGS_DIR: "invented-flags", ROAM_PIPE_CHAT_JID: "invented-chat",
    MOLTBOOK_API_KEY: "invented-moltbook-secret", OPENAI_API_KEY: "invented-openai-secret",
    CODEX_HOME: "invented-codex-home", UNRELATED_SECRET: "invented-unrelated", CLAUDECODE: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "invented-claude-token", ANTHROPIC_TEST: "invented-anthropic-setting",
    CLAUDE_CONFIG_DIR: "invented-config-dir", HTTPS_PROXY: "invented-proxy",
  };
  const previous = Object.fromEntries(Object.keys(invented).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, invented);
    const { askClaude } = await import("../src/ai.js");
    const result = await askClaude([], [], { prompt: "prompt.md", model: "synthetic" }, "synthetic-chat");
    assert.equal(result.shouldRespond, false);
    const actual = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8"));
    assert.equal(actual.CLAUDE_CODE_OAUTH_TOKEN, "invented-claude-token");
    assert.equal(actual.ANTHROPIC_TEST, "invented-anthropic-setting");
    assert.equal(actual.PATH, process.env.PATH);
    assert.equal(actual.CLAUDE_CONFIG_DIR, "invented-config-dir");
    assert.equal(actual.HTTPS_PROXY, "invented-proxy");
    for (const key of ["SIGNAL_ACCOUNT", "SIGNAL_ADMIN_NUMBER", "ADMIN_TEST", "ENTOURAGE_FLAGS_DIR", "ROAM_PIPE_CHAT_JID",
      "MOLTBOOK_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "UNRELATED_SECRET", "CLAUDECODE", "KLEINBOT_RUNTIME_DIR", "CLAUDE_BIN"]) {
      assert.equal(actual[key], undefined, `${key} leaked to the chat model`);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
