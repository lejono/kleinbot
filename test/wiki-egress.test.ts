import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { researchConfig, roamConfig } from "../src/config.js";
import { containsEnvSecret, containsConfiguredSecret } from "../src/moltbook/egress.js";
import { writePages } from "../src/research/pages.js";
import { writeOutboxMessage } from "../src/roam/outbox.js";

const secretKeys = ["MOLTBOOK_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const variants = ["", "\n", " ", "\t", "\x00", "\x1b", "\x85", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u034f", "\u00a0"];

it("applies the shared normalising matcher to existing text egress for every configured key", () => {
  const previous = secretKeys.map(key => process.env[key]);
  try {
    for (const key of secretKeys) delete process.env[key];
    assert.equal(containsEnvSecret("Ordinary text"), false);
    for (const key of secretKeys) {
      process.env[key] = "synthetic-egress-secret";
      for (const separator of variants) {
        const text = `prefix synthetic-${separator}egress-secret suffix`;
        assert.equal(containsEnvSecret(text), true, JSON.stringify(separator));
        assert.equal(containsConfiguredSecret(Buffer.from(text)), true);
      }
      process.env[key] = "synthetic- egress-secret";
      assert.equal(containsEnvSecret("synthetic-egress-secret"), true);
      for (const short of ["", "tiny", "shorter"]) {
        process.env[key] = short;
        assert.equal(containsEnvSecret(`prefix ${short} suffix`), false);
      }
      process.env[key] = "abcdefgh";
      assert.equal(containsEnvSecret("abcd\nefgh"), true);
      delete process.env[key];
    }
  } finally {
    secretKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

for (const field of ["title", "markdown"] as const) {
  it(`skips pages with secrets in raw or sanitised ${field}, without logging values`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "page-egress-"));
    const original = { ...researchConfig };
    const previous = process.env.OPENAI_API_KEY;
    try {
      researchConfig.wikiDir = dir;
      process.env.OPENAI_API_KEY = "synthetic-page-secret";
      const warnings = t.mock.method(console, "warn", () => {});
      const values = [process.env.OPENAI_API_KEY, "synthetic-\npage-secret", "synthetic- \tpage-secret",
        "<!-- synthetic-page-secret -->", "synthetic-<b></b>page-secret", "synthetic-[page-secret](relative)"];
      for (const value of values) {
        const page = { name: "synthetic", title: "Synthetic title", markdown: "Synthetic body", [field]: value };
        assert.deepEqual(writePages([page]), [], value);
        assert.equal(fs.existsSync(path.join(dir, "pages", "synthetic.md")), false);
      }
      assert.equal(warnings.mock.callCount(), values.length);
      for (const call of warnings.mock.calls) {
        assert.equal(call.arguments.length, 1);
        assert.doesNotMatch(String(call.arguments[0]), /synthetic|\n/);
      }
      assert.deepEqual(writePages([{ name: "ordinary", title: "Ordinary title", markdown: "Ordinary body" }]), ["ordinary"]);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
      t.mock.restoreAll(); Object.assign(researchConfig, original); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const channel of ["research", "briefing"] as const) {
  it(`publishes nothing on ${channel} when existing wiki attachment bytes contain secrets`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-egress-"));
    const original = { ...roamConfig };
    const previous = process.env.OPENAI_API_KEY;
    try {
      roamConfig.outboxDir = path.join(dir, "outbox");
      process.env.OPENAI_API_KEY = "synthetic-attachment-secret";
      for (const name of ["summary.md", "log-2026-01.md", "group.md", "page.md"]) {
        const source = path.join(dir, name);
        for (const separator of variants) {
          const bytes = Buffer.from(`Synthetic heading\nsynthetic-${separator}attachment-secret`);
          fs.writeFileSync(source, bytes);
          assert.equal(writeOutboxMessage(channel, "Innocuous reply", source), "refused");
          assert.deepEqual(fs.readdirSync(path.join(roamConfig.outboxDir, channel)), []);
          assert.deepEqual(fs.readFileSync(source), bytes);
        }
      }
      assert.equal(writeOutboxMessage(channel, "synthetic-\nattachment-secret"), "refused");
      assert.deepEqual(fs.readdirSync(path.join(roamConfig.outboxDir, channel)), []);
      const safe = path.join(dir, "safe.md");
      fs.writeFileSync(safe, "Ordinary content");
      assert.equal(writeOutboxMessage(channel, "Ordinary reply", safe), "published");
      assert.deepEqual(fs.readdirSync(path.join(roamConfig.outboxDir, channel)).map(n => path.extname(n)).sort(), [".json", ".md"]);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
      Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
