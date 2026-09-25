import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelConfig, researchConfig, roamConfig } from "../src/config.js";
import { answerInbox } from "../src/roam/answer.js";

const FAILURE = "I could not save that page (the name, size or content was not acceptable), so nothing was written. Please ask again.";

for (const failure of ["name", "size", "filesystem", "secret", "split-secret"] as const) {
  it(`discards success prose and stale attachments after a ${failure} page rejection`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "page-rejection-"));
    const original = { ...researchConfig }, roam = { ...roamConfig }, model = { ...modelConfig };
    const previousSecret = process.env.OPENAI_API_KEY;
    const secretPage = failure === "secret" || failure === "split-secret";
    try {
      process.env.OPENAI_API_KEY = "synthetic-page-secret";
      Object.assign(researchConfig, { dir: path.join(dir, "research"), wikiDir: path.join(dir, "wiki"), pageMaxBytes: 200 });
      Object.assign(roamConfig, { inboxDir: path.join(dir, "inbox"), outboxDir: path.join(dir, "outbox"), chatBackend: "claude" });
      modelConfig.claudeBin = path.join(dir, "model");
      const pageName = failure === "name" ? "group" : "synthetic-page";
      const pages = path.join(researchConfig.wikiDir, "pages");
      fs.mkdirSync(pages, { recursive: true });
      const pageFile = path.join(pages, `${pageName}.md`);
      if (!secretPage) fs.writeFileSync(pageFile, "Existing synthetic page");
      fs.writeFileSync(path.join(dir, "reply"), JSON.stringify({ reply: secretPage ? "Synthetic innocuous reply" : "Synthetic page saved successfully", attachMd: `pages/${pageName}.md`,
        writePage: { name: pageName, title: "Synthetic title", markdown: failure === "size" ? "x".repeat(201) : failure === "secret" ? process.env.OPENAI_API_KEY
          : failure === "split-secret" ? "synthetic-\npage-secret" : "Synthetic new page" } }));
      fs.writeFileSync(modelConfig.claudeBin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(process.argv[1]);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(root, 'calls'), 'call\\n');
process.stdout.write(JSON.stringify({result:input.includes('ROAM_CONTROL_INTENT') ? '{"control":null,"confidence":1,"writeUp":true}' : fs.readFileSync(path.join(root, 'reply'), 'utf8')}));
`, { mode: 0o700 });
      let injected = 0;
      const rename = fs.renameSync;
      if (failure === "filesystem") t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === pageFile) { injected++; throw Error("Synthetic write failure"); }
        return rename(from, to);
      });
      fs.mkdirSync(roamConfig.inboxDir);
      const inboxFile = path.join(roamConfig.inboxDir, "synthetic.json");
      const message = JSON.stringify({ id: "synthetic-request", timestamp: Math.floor(Date.now() / 1000), senderName: "Member", text: "Write a synthetic page", attachments: [] });
      fs.writeFileSync(inboxFile, message);
      await answerInbox();
      const outbox = path.join(roamConfig.outboxDir, "research");
      const files = fs.readdirSync(outbox);
      assert.equal(files.length, 1);
      const flag = JSON.parse(fs.readFileSync(path.join(outbox, files[0]), "utf8"));
      assert.equal(flag.text, FAILURE);
      assert.equal(flag.attachmentPath, undefined);
      if (secretPage) assert.equal(fs.existsSync(pageFile), false);
      else assert.equal(fs.readFileSync(pageFile, "utf8"), "Existing synthetic page");
      assert.deepEqual(fs.readdirSync(pages), secretPage ? [] : [`${pageName}.md`]);
      const chat = fs.readFileSync(path.join(researchConfig.dir, "chat-log.jsonl"), "utf8");
      assert.doesNotMatch(chat, /saved successfully|Synthetic innocuous reply|synthetic-page-secret/);
      assert.equal(JSON.parse(chat.trim().split("\n").at(-1)!).text, FAILURE);
      const logFile = fs.readdirSync(researchConfig.wikiDir).find(n => n.startsWith("log-"))!;
      assert.match(fs.readFileSync(path.join(researchConfig.wikiDir, logFile), "utf8"), /inbox ·.* failed\n/);
      assert.equal(fs.existsSync(inboxFile), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(researchConfig.dir, "inbox-seen.json"), "utf8")), ["synthetic-request"]);
      fs.writeFileSync(inboxFile, message);
      await answerInbox();
      assert.equal(fs.existsSync(inboxFile), false);
      assert.deepEqual(fs.readdirSync(outbox), files);
      assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), "call\ncall\n");
      assert.equal(injected, failure === "filesystem" ? 1 : 0);
    } finally {
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousSecret;
      t.mock.restoreAll(); Object.assign(researchConfig, original); Object.assign(roamConfig, roam); Object.assign(modelConfig, model);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
