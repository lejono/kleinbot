import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const settings = {
  RESEARCH_WRITEUP_PAGES_PER_RUN: "writeupPagesPerRun",
  RESEARCH_WRITEUP_TIMEOUT_MS: "writeupTimeoutMs",
  RESEARCH_DIGEST_ITEMS: "digestItems",
  RESEARCH_ATTACH_SUMMARY: "attachSummary",
};

function readConfig(overrides: Record<string, string> = {}): Record<string, number | boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-config-"));
  try {
    const env = { ...process.env, KLEINBOT_RUNTIME_DIR: dir };
    for (const key of Object.keys(settings)) delete env[key as keyof typeof env];
    const source = `import { researchConfig } from './src/config.ts';
      console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.entries(settings))}
        .map(([name, key]) => [name, researchConfig[key]]))));`;
    return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source],
      { env: { ...env, ...overrides }, encoding: "utf8" }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

it("documents the actual nightly research defaults in both configuration references", () => {
  const defaults = readConfig();
  assert.deepEqual(defaults, { RESEARCH_WRITEUP_PAGES_PER_RUN: 4, RESEARCH_WRITEUP_TIMEOUT_MS: 600000,
    RESEARCH_DIGEST_ITEMS: 5, RESEARCH_ATTACH_SUMMARY: false });
  const example = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const roam = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8").split("## Roam mode")[1];
  for (const [name, value] of Object.entries(defaults)) {
    const printed = typeof value === "boolean" ? Number(value) : value;
    assert.ok(example.includes(`# ${name}=${printed}`), `Missing example default for ${name}`);
    assert.ok(roam.includes(`\`${name}\` (${printed})`), `Missing Roam mode default for ${name}`);
  }
  assert.match(roam, /one model call per page/);
  assert.match(roam, /\{name, title, markdown\}/);
  assert.match(roam, /\{items:\[\{id, sentence\}\]\}/);
  assert.doesNotMatch(roam, /still attaches `summary.md`|defaults to 300000\. The call/);
});

it("uses safe numeric defaults and attaches summaries only with the explicit setting", () => {
  assert.deepEqual(readConfig({ RESEARCH_WRITEUP_PAGES_PER_RUN: "-1", RESEARCH_WRITEUP_TIMEOUT_MS: "invalid",
    RESEARCH_DIGEST_ITEMS: "0.5", RESEARCH_ATTACH_SUMMARY: "true" }), {
    RESEARCH_WRITEUP_PAGES_PER_RUN: 4, RESEARCH_WRITEUP_TIMEOUT_MS: 600000, RESEARCH_DIGEST_ITEMS: 5, RESEARCH_ATTACH_SUMMARY: false,
  });
  assert.deepEqual(readConfig({ RESEARCH_WRITEUP_PAGES_PER_RUN: "2", RESEARCH_WRITEUP_TIMEOUT_MS: "8000",
    RESEARCH_DIGEST_ITEMS: "3", RESEARCH_ATTACH_SUMMARY: "1" }), {
    RESEARCH_WRITEUP_PAGES_PER_RUN: 2, RESEARCH_WRITEUP_TIMEOUT_MS: 8000, RESEARCH_DIGEST_ITEMS: 3, RESEARCH_ATTACH_SUMMARY: true,
  });
});
