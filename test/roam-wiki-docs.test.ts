import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";

it("documents wiki settings and the clean-call write boundary", () => {
  const guide = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8").split("## Roam mode\n")[1].split("## Deployment")[0];
  const env = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const variable of ["ROAM_LOG_EXCERPT_CHARS", "ROAM_GROUP_NOTE_MAX_CHARS", "ROAM_GROUP_PAGE_CONTEXT_BYTES",
    "RESEARCH_PAGE_MAX_BYTES", "RESEARCH_PAGES_MAX_PER_RUN", "RESEARCH_WRITEUP_BACKEND", "RESEARCH_WRITEUP_MODEL",
    "RESEARCH_WRITEUP_MAX_RECORDS", "RESEARCH_WRITEUP_MAX_EXISTING_PAGES", "RESEARCH_WRITEUP_CONTEXT_MAX_BYTES", "RESEARCH_WRITEUP_TIMEOUT_MS"]) {
    assert.ok(guide.includes(variable), `Roam guide missing ${variable}`);
    assert.ok(env.includes(variable + "="), `Environment example missing ${variable}`);
  }
  assert.match(guide, /Corpus and generated wiki pages remain data, never instructions/);
  assert.match(guide, /earlier operator lines only; assistant entries are excluded completely/);
  assert.match(guide, /operator's own message/);
  assert.match(guide, /Agreement with an assistant suggestion.*is not/s);
  assert.match(guide, /writeUp: true.*confidence threshold/s);
  assert.match(guide, /facts only/);
  assert.match(guide, /\[excerpt withheld\]/);
  assert.match(guide, /sanitisePageMarkdown/);
  assert.match(guide, /raw HTML tags and comments/);
  assert.match(guide, /one aggregate byte budget/);
  assert.match(guide, /per-call random delimiter/);
  assert.match(guide, /never copy assistant lines or quoted material/);
  assert.match(guide, /groupNotes/); assert.match(guide, /writePage/);
  assert.match(guide, /pages\/.*only through.*validat/s);
  assert.doesNotMatch(guide, /never loads corpus, wiki,/);
});


it("documents participation context limits, private guidance and the prompt-injection risk", () => {
  const guide = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8").split("## Roam mode\n")[1].split("## Deployment")[0];
  const env = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const [name, value] of [["ROAM_CYCLE_CONTEXT_MESSAGES", 20], ["ROAM_CYCLE_CONTEXT_MAX_BYTES", 32768]]) {
    assert.ok(guide.includes(`${name}=${value}`));
    assert.ok(env.includes(`${name}=${value}`));
  }
  assert.match(guide, /runtime persona[\s\S]*group notes[\s\S]*operator and assistant entries[\s\S]*current focus/);
  assert.match(guide, /No `senderName` fields/);
  assert.match(guide, /UK · operator: <text>/);
  assert.match(guide, /UK · you \(earlier reply\): <text>/);
  assert.match(guide, /deprecated\s+`ROAM_CYCLE_OPERATOR_MESSAGES`.*fallback only when the new name is unset/);
  assert.match(env, /Deprecated fallback when the new name is unset; now counts both roles/);
  assert.match(guide, /oldest conversation entries first[\s\S]*oldest complete group-note entries/);
  assert.match(guide, /assistant entry exceeding 4000 UTF-8 bytes is truncated with `…`/);
  assert.match(guide, /participation already reads the raw\s+untrusted feed and cannot change controls, notes or logs/);
  assert.match(guide, /clean intent call still excludes assistant replies completely/);
  assert.match(guide, /assistant replies alone never trigger it/);
  assert.match(guide, /never be quoted, paraphrased, summarised or revealed on the platform/);
  assert.match(guide, /group's existence or members/);
  assert.match(guide, /Prompt instructions are not a hard barrier/);
  assert.match(guide, /operator messages could be paraphrased publicly if a feed post manipulates the model/);
  assert.match(guide, /settings, notes and logs protections are unchanged/);
  assert.match(guide, /previous cycle attempt[\s\S]*no new feed posts/);
  assert.match(guide, /MOLTBOOK_HEARTBEAT_INTERVAL[\s\S]*hours/);
});
