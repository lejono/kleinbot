import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { researchConfig, roamConfig, modelConfig } from "../src/config.js";
import { buildResearchDigest, writeResearchNotice } from "../src/research/digest.js";
import type { ClassifiedRecord } from "../src/research/schema.js";

const record = (id: string, project = id, confidence = 0.8, isOrganising = true): ClassifiedRecord => ({
  id, project, confidence, isOrganising, platform: "moltbook", classifiedAt: "2026-01-01", model: "synthetic",
  goal: "Share tools", decisionMechanism: "Vote on shared tools", resourceAllocation: "Common stock",
  stakes: "Tool access", quote: "Synthetic evidence", actors: ["EXCLUDED ACTOR"], codes: ["shared tools", "voting"],
});

for (const backend of ["claude", "codex"] as const) {
  it(`builds a bounded nightly digest from only offered records through ${backend}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-digest-"));
    const research = { ...researchConfig }, roam = { ...roamConfig }, model = { ...modelConfig };
    try {
      Object.assign(researchConfig, { dir, wikiDir: dir, writeupModel: "synthetic-digest", writeupBackend: backend,
        digestItems: 3, attachSummary: false });
      Object.assign(roamConfig, { outboxDir: path.join(dir, "outbox"), maxTextChars: 4000 });
      const result = { captured: 20, classified: 18, organising: 10, newlyClassified: 5, summaryPath: path.join(dir, "summary.md"),
        newRecords: [record("non-organising", "Other", 1, false), record("low", "Alpha", 0.5),
          record("best", "Beta", 0.95), record("duplicate-project", "Beta", 0.9), record("middle", "Gamma", 0.7)] };
      fs.writeFileSync(result.summaryPath, "FULL SUMMARY");
      fs.writeFileSync(path.join(dir, "classified.jsonl"), JSON.stringify(record("HISTORICAL")));
      const bin = path.join(dir, "model"); modelConfig.claudeBin = modelConfig.codexBin = bin;
      fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(process.argv[1]), args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({args, input}) + '\\n');
const reply = fs.readFileSync(path.join(root, 'reply'), 'utf8');
if (reply === 'FAIL') process.exit(1);
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], reply);
else process.stdout.write(JSON.stringify({result:reply}));
`, { mode: 0o700 });
      const setReply = (value: unknown) => fs.writeFileSync(path.join(dir, "reply"), typeof value === "string" ? value : JSON.stringify(value));
      setReply({ items: [
        { id: "middle", sentence: "Agents share tools so more teams can take part.", link: "https://example.invalid/model-link" },
        { id: "best", sentence: "Agents vote on shared tools. https://example.invalid/embedded" },
        { id: "HISTORICAL", sentence: "OLD ITEM" }, { id: "unknown", sentence: "UNKNOWN ITEM" },
        { id: "best", sentence: "DUPLICATE ITEM" }, { id: "non-organising", sentence: "NOT OFFERED" },
        { id: "low", sentence: "" },
      ] });
      const text = await buildResearchDigest(result, ["decision-mechanisms", "project-beta"]);
      assert.match(text, /^Research: 20 captured, 18 classified, 10 organising, 2 pages written; 5 new since last run\./);
      assert.ok(text.indexOf("post/best") < text.indexOf("post/middle"));
      assert.doesNotMatch(text, /example.invalid|OLD ITEM|UNKNOWN ITEM|DUPLICATE ITEM|NOT OFFERED|FULL SUMMARY|HISTORICAL/);
      assert.match(text, /Pages written: decision-mechanisms, project-beta\. Ask for the full summary if you want it\.$/);
      const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(calls.length, 1);
      const { args, input } = calls[0];
      const token = input.match(/UNTRUSTED-[a-f0-9]{16}/)![0];
      const offered = JSON.parse(input.split(`--- BEGIN ${token} ---`)[1].split(`--- END ${token} ---`)[0]);
      assert.deepEqual(offered.map((r: any) => r.id), ["best", "middle", "low"]);
      for (const r of offered) assert.deepEqual(Object.keys(r).sort(), ["id", "project", "goal", "decisionMechanism", "resourceAllocation", "stakes", "quote"].sort());
      assert.doesNotMatch(input, /EXCLUDED ACTOR|HISTORICAL|FULL SUMMARY/);
      if (backend === "claude") {
        assert.equal(args[args.indexOf("--tools") + 1], "");
        assert.equal(args[args.indexOf("--model") + 1], "synthetic-digest");
      }
      for (const reply of ["FAIL", "broken JSON", { items: [{ id: "unknown", sentence: "Ignored" }] }, { items: [] }, { items: [{ id: "best", sentence: "x".repeat(200) }] }]) {
        setReply(reply);
        const fallback = await buildResearchDigest(result, []);
        assert.match(fallback, /Beta — Vote on shared tools https:\/\/www.moltbook.com\/post\/best/);
        assert.match(fallback, /Gamma — Vote on shared tools/);
        assert.match(fallback, /Alpha — Vote on shared tools/);
        assert.doesNotMatch(fallback, /non-organising|duplicate-project/);
      }
      researchConfig.writeupModel = "";
      result.newRecords[2].decisionMechanism = null;
      assert.match(await buildResearchDigest(result, []), /Beta — Share tools/);
      // With room for framing but fewer items, keep the footer and complete code-built links.
      roamConfig.maxTextChars = 290;
      const capped = await buildResearchDigest(result, ["project-beta"]);
      assert.ok(capped.length <= 290);
      assert.match(capped, /Ask for the full summary if you want it\.$/);
      assert.doesNotMatch(capped, /\[truncated\]/);
      roamConfig.maxTextChars = 24;
      assert.ok((await buildResearchDigest(result, [])).length <= 24);
      roamConfig.maxTextChars = 4000;
      assert.equal(await writeResearchNotice(result, []), "published");
      const flags = () => fs.readdirSync(path.join(roamConfig.outboxDir, "research")).filter(n => n.endsWith(".json"))
        .map(n => JSON.parse(fs.readFileSync(path.join(roamConfig.outboxDir, "research", n), "utf8")));
      assert.equal(flags()[0].attachmentPath, undefined);
      researchConfig.attachSummary = true;
      assert.equal(await writeResearchNotice(result, []), "published");
      const attachment = flags().find(flag => flag.attachmentPath);
      assert.equal(fs.readFileSync(attachment.attachmentPath, "utf8"), "FULL SUMMARY");
      researchConfig.writeupModel = "synthetic-digest";
      const before = fs.readFileSync(path.join(dir, "calls"), "utf8");
      const empty = await buildResearchDigest({ ...result, newRecords: [], newlyClassified: 0 }, []);
      assert.match(empty, /0 new since last run/);
      assert.doesNotMatch(empty, /post\//);
      assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), before);
    } finally { Object.assign(researchConfig, research); Object.assign(roamConfig, roam); Object.assign(modelConfig, model); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
