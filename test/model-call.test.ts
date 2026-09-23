import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { modelConfig } from "../src/config.js";
import { callModel } from "../src/moltbook/model-call.js";

const defaultDisabledFeatures = ["browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser"];

it("configures disabled Codex features with defaults, overrides and an empty opt-out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-config-"));
  try {
    for (const [value, expected] of [[undefined, defaultDisabledFeatures], [" computer_use, browser_use, ", ["computer_use", "browser_use"]], ["", []]] as const) {
      const env = { ...process.env, KLEINBOT_RUNTIME_DIR: dir };
      delete env.CODEX_DISABLE_FEATURES;
      if (value !== undefined) env.CODEX_DISABLE_FEATURES = value;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
        'import { modelConfig } from "./src/config.ts"; console.log(JSON.stringify(modelConfig.codexDisableFeatures));'],
      { env, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("passes exact CLI flags, stdin and schema; cleans codex workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-test-"));
  const original = { ...modelConfig };
  try {
    const bin = path.join(dir, "fake");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat > '${dir}/stdin'\nif [ "$1" = exec ]; then\n while [ "$1" != -o ]; do shift; done\n printf 'answer' > "$2"\nelse\n printf 'answer'\nfi\n`, { mode: 0o700 });
    modelConfig.claudeBin = modelConfig.codexBin = bin;
    const opts = { model: "test-model", systemPrompt: "instructions", prompt: "data", timeoutMs: 1000 };
    for (const tools of ["none", "web"] as const) {
      assert.equal(await callModel({ ...opts, backend: "claude", tools }), "answer");
      assert.deepEqual(fs.readFileSync(path.join(dir, "args"), "utf8").trimEnd().split("\n"),
        ["--print", "--model", "test-model", "--no-session-persistence", "--system-prompt", "instructions",
          "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--safe-mode", "--disable-slash-commands",
          ...(tools === "none" ? ["--tools"] : ["--allowedTools", "WebSearch,WebFetch"])]);
      if (tools === "none") assert.ok(fs.readFileSync(path.join(dir, "args"), "utf8").endsWith("--tools\n\n"));
      assert.equal(fs.readFileSync(path.join(dir, "stdin"), "utf8"), "data");
    }
    for (const codexDisableFeatures of [defaultDisabledFeatures, ["computer_use"], []]) {
      Object.assign(modelConfig, { codexDisableFeatures });
      assert.equal(await callModel({ ...opts, backend: "codex", tools: "none", outputSchemaFile: "schema.json" }), "answer");
      const args = fs.readFileSync(path.join(dir, "args"), "utf8").trimEnd().split("\n");
      const workspace = args[args.indexOf("-C") + 1];
      assert.deepEqual(args, ["exec", "-m", "test-model", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
        ...codexDisableFeatures.flatMap(feature => ["--disable", feature]),
        "-C", workspace, "-o", path.join(workspace, "answer.txt"), "--output-schema", "schema.json", "-"]);
      assert.equal(fs.existsSync(workspace), false);
      assert.equal(fs.readFileSync(path.join(dir, "stdin"), "utf8"), "instructions\n\ndata");
    }
    fs.writeFileSync(bin, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
    await assert.rejects(callModel({ ...opts, backend: "claude", tools: "none" }), /code 9/);
    fs.writeFileSync(bin, "#!/bin/sh\nsleep 2\n", { mode: 0o700 });
    const started = Date.now();
    await assert.rejects(callModel({ ...opts, backend: "codex", tools: "none", timeoutMs: 20 }), /timed out/);
    assert.ok(Date.now() - started < 1000, "timeout must not wait for inherited pipes");
  } finally {
    Object.assign(modelConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("allows only backend-specific child environment names and refuses forbidden extensions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-env-test-"));
  const original = { ...modelConfig };
  const base = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "TZ", "KLEINBOT_TEMP_DIR",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"];
  const invented = {
    MOLTBOOK_API_KEY: "invented-moltbook-secret", ROAM_PIPE_CHAT_JID: "invented-recipient",
    SIGNAL_TEST: "invented-signal", ADMIN_TEST: "invented-admin", ENTOURAGE_TEST: "invented-entourage",
    OPENAI_API_KEY: "invented-openai-secret", OPENAI_TEST: "invented-openai-setting",
    CLAUDE_CODE_OAUTH_TOKEN: "invented-claude-secret", CLAUDE_CODE_TEST: "invented-claude-setting",
    ANTHROPIC_API_KEY: "invented-anthropic-secret", ANTHROPIC_TEST: "invented-anthropic-setting",
    CODEX_HOME: dir, CODEX_TEST: "invented-codex-setting", CLAUDE_TEST: "invented-other-claude",
    CLAUDECODE: "1", MODEL_TEST_ALLOWED: "invented-extension", MODEL_TEST_PRIVATE: "invented-private",
    MODEL_CHILD_ENV_ALLOW: "",
  };
  const previous = Object.fromEntries(Object.keys(invented).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, invented);
    for (const backend of ["claude", "codex"] as const) {
      const bin = path.join(dir, backend);
      fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify(process.env));
fs.readFileSync(0);
const args = process.argv.slice(2);
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], 'answer');
else process.stdout.write('answer');
`, { mode: 0o700 });
      modelConfig[backend === "claude" ? "claudeBin" : "codexBin"] = bin;
      for (const extend of [false, true]) {
        process.env.MODEL_CHILD_ENV_ALLOW = extend ? Object.keys(invented).join(", ") : "";
        await callModel({ backend, model: "synthetic", tools: "none", systemPrompt: "test", prompt: "test", timeoutMs: 2000 });
        const expected = Object.fromEntries(Object.entries(process.env).filter(([key]) => base.includes(key)
          || (backend === "claude" ? /^(CLAUDE_CODE_|ANTHROPIC_)/.test(key) : /^(CODEX_)/.test(key) || key === "OPENAI_API_KEY")
          || (extend && ["MODEL_TEST_ALLOWED", "MODEL_TEST_PRIVATE", "MODEL_CHILD_ENV_ALLOW",
            ...(backend === "claude" ? ["CLAUDE_TEST"] : ["OPENAI_TEST"])].includes(key))));
        // The nesting marker must never re-enable Claude's nested-session rejection.
        const actual = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8"));
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
        for (const key of Object.keys(invented)) assert.equal(actual[key], expected[key]);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    Object.assign(modelConfig, original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
