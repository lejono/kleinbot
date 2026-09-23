import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initConfig, promptsDir, researchConfig, roamConfig, modelConfig } from "../src/config.js";
import { answerInbox } from "../src/roam/answer.js";
import { readRecentChat } from "../src/roam/chat-log.js";

const withheld = "I have withheld my answer because it contained something that must not be sent. Please rephrase, or ask for less.";

for (const kind of ["text", "attachment", "split-attachment", "unwritable"] as const) {
  it(`handles ${kind} without repeated model calls across three ticks`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-withheld-"));
    const originals = [{ ...roamConfig }, { ...researchConfig }, { ...modelConfig }];
    const previous = process.env.MOLTBOOK_API_KEY;
    const secret = "invented-withheld-secret";
    const read = fs.readFileSync;
    try {
      process.env.MOLTBOOK_API_KEY = secret;
      initConfig("roam");
      Object.assign(roamConfig, { inboxDir: path.join(dir, "inbox"), outboxDir: path.join(dir, "outbox"), chatBackend: "claude" });
      Object.assign(researchConfig, { dir: path.join(dir, "research"), wikiDir: path.join(dir, "wiki") });
      modelConfig.claudeBin = path.join(dir, "claude");
      fs.mkdirSync(roamConfig.inboxDir); fs.mkdirSync(researchConfig.wikiDir);
      fs.writeFileSync(path.join(researchConfig.wikiDir, "summary.md"), kind === "split-attachment" ? secret.split("-").join("-\n") : secret);
      // Avoid loading any optional runtime prompt.
      t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === path.join(promptsDir, "roam-chat.md")) throw new Error("No test prompt");
        return read(...args);
      });
      fs.writeFileSync(modelConfig.claudeBin, `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const intent = input.includes('ROAM_CONTROL_INTENT');
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, intent ? 'intent\\n' : 'answer\\n');
process.stdout.write(JSON.stringify(intent ? {control:null,confidence:1} : ${JSON.stringify({ reply: kind === "text" ? secret : "Safe answer", attachMd: kind.includes("attachment") ? "summary.md" : null })}));
`, { mode: 0o700 });
      const inboxFile = path.join(roamConfig.inboxDir, "invented.json");
      fs.writeFileSync(inboxFile, JSON.stringify({ id: "invented-message", timestamp: Math.floor(Date.now() / 1000),
        senderName: "Synthetic Member", text: "Explain this please", attachments: [] }));
      if (kind === "unwritable") {
        const access = fs.accessSync;
        t.mock.method(fs, "accessSync", (file: fs.PathLike, mode?: number) => {
          if (String(file) === path.join(roamConfig.outboxDir, "research")) throw new Error("Invented permission failure");
          return access(file, mode);
        });
      }
      for (let tick = 0; tick < 3; tick++) await answerInbox();
      if (kind === "unwritable") {
        assert.equal(fs.existsSync(path.join(dir, "calls")), false);
        assert.equal(fs.existsSync(inboxFile), true);
        assert.equal(fs.existsSync(path.join(researchConfig.dir, "inbox-seen.json")), false);
        // Restoring write access allows the retained request to be answered.
        t.mock.restoreAll();
        t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
          if (String(args[0]) === path.join(promptsDir, "roam-chat.md")) throw new Error("No test prompt");
          return read(...args);
        });
        await answerInbox();
        assert.equal(fs.existsSync(inboxFile), false);
      } else {
        const folder = path.join(roamConfig.outboxDir, "research");
        const names = fs.readdirSync(folder);
        assert.equal(names.length, 1);
        const flag = JSON.parse(read(path.join(folder, names[0]), "utf8"));
        assert.equal(flag.text, withheld); assert.equal(flag.attachmentPath, undefined);
        assert.equal(fs.existsSync(inboxFile), false);
        assert.deepEqual(JSON.parse(read(path.join(researchConfig.dir, "inbox-seen.json"), "utf8")), ["invented-message"]);
        assert.equal(readRecentChat().at(-1)?.text, withheld);
        const log = read(path.join(researchConfig.wikiDir, fs.readdirSync(researchConfig.wikiDir).find(n => n.startsWith("log-"))!), "utf8");
        assert.match(log, /withheld/); assert.ok(!log.includes(secret));
      }
      // One answer generation, plus the existing isolated intent classification.
      assert.equal(read(path.join(dir, "calls"), "utf8"), "intent\nanswer\n");
    } finally {
      t.mock.restoreAll(); Object.assign(roamConfig, originals[0]); Object.assign(researchConfig, originals[1]); Object.assign(modelConfig, originals[2]);
      if (previous === undefined) delete process.env.MOLTBOOK_API_KEY; else process.env.MOLTBOOK_API_KEY = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

it("warns once per short configured secret during daemon configuration, naming no values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-secret-warning-"));
  const keys = ["MOLTBOOK_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { initConfig } from './src/config.ts';
const keys = ${JSON.stringify(keys)};
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
for (const key of keys) process.env[key] = '';
initConfig('roam');
for (const key of keys) process.env[key] = 'abcdefgh';
initConfig('roam');
assert.deepEqual(warnings, []);
for (const [i, key] of keys.entries()) process.env[key] = ['x','tiny','shorter','small'][i];
initConfig('roam'); initConfig('roam');
assert.deepEqual(warnings, keys.map(key => '[egress] Configured secret shorter than 8 characters is ignored: ' + key));
`], { env: { ...process.env, KLEINBOT_RUNTIME_DIR: dir }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
