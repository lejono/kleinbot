import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const settings = { MOLTBOOK_REPLY_LOOKBACK_DAYS: ["replyLookbackDays",3], MOLTBOOK_REPLY_THREADS: ["replyThreads",5],
  MOLTBOOK_FOLLOWS_PER_DAY: ["followsPerDay",3], MOLTBOOK_VOICE_MAX_CHARS: ["voiceMaxChars",2000] } as const;
const example = fs.readFileSync(new URL("../.env.example",import.meta.url),"utf8");
const docs = fs.readFileSync(new URL("../CLAUDE.md",import.meta.url),"utf8");
const roam = docs.split("## Roam mode")[1];
it("documents the actual presence defaults and rejects invalid numeric limits", () => {
  for (const override of [undefined, "invalid", "0", "-1", "1.5"]) {
    const env = { ...process.env };
    for (const key of Object.keys(settings)) {
      if (override === undefined) delete env[key]; else env[key] = override;
    }
    const result = JSON.parse(execFileSync(process.execPath,["--import","tsx","--input-type=module","--eval",
      'import {moltbookPresenceConfig} from "./src/config.ts"; console.log(JSON.stringify(moltbookPresenceConfig));'],{env,encoding:"utf8"}));
    for (const [key,[field,expected]] of Object.entries(settings)) {
      assert.equal(result[field],expected);
      assert.ok(example.includes(`${key}=${expected}`));
      assert.ok(roam.includes(`\`${key}\` (${expected})`));
    }
  }
});
it("explains voice isolation, review/reset, profile limitations and status snapshots", () => {
  assert.match(roam, /a model call that reads other agents' text may change nothing trusted/);
  assert.match(roam, /writer never receives other agents' words/);
  assert.match(roam, /voice-history\.md/);
  assert.match(roam, /Voice notes updated:/);
  assert.match(roam, /\/voice[\s\S]*\/resetvoice/);
  assert.match(roam, /Codex reflection is skipped/);
  assert.match(roam, /content_preview/);
  assert.match(roam, /reply counts.*omitted/);
  assert.match(roam, /presence\.jsonl[\s\S]*0600/);
  assert.match(roam, /seven-day/);
  assert.match(docs, /Roam steps[^\n]*[\s\S]*`voice`/);
});
