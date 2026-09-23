import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { roamConfig } from "../src/config.js";
import { writeOutboxMessage } from "../src/roam/outbox.js";
import { startOutboxRelay } from "../src/roam/outbox-relay.js";
import type { Transport } from "../src/transport.js";

it("relays real flags to pinned channels, archives attachments, and deduplicates across restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  const original = { ...roamConfig };
  const sent: { to: string; text: string; bytes?: string }[] = [];
  const transport = { isConnected: () => true,
    sendText: async (to: string, text: string) => { sent.push({ to, text }); },
    sendFile: async (to: string, bytes: Buffer, name: string, mime: string, text: string) => {
      assert.equal(mime, "text/markdown"); sent.push({ to, text, bytes: bytes.toString() }); return true;
    } } as Transport;
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "synthetic-briefing", researchChatJid: "synthetic-research" });
    const md = path.join(dir, "summary.md");
    fs.writeFileSync(md, "Synthetic summary");
    writeOutboxMessage("research", "Research", md);
    writeOutboxMessage("briefing", "Briefing");
    const folder = path.join(dir, "research");
    const name = fs.readdirSync(folder).find(f => f.endsWith(".json"))!;
    const file = path.join(folder, name);
    const flag = JSON.parse(fs.readFileSync(file, "utf8"));
    flag.targetChatJid = "untrusted-recipient";
    flag.attachmentPath = path.join("/synthetic/copied/outbox/research", `${flag.id}.md`);
    fs.writeFileSync(file, JSON.stringify(flag));
    fs.writeFileSync(path.join(folder, "ignored.tmp"), "{}");
    relay = startOutboxRelay(transport);
    await relay.sweep();
    assert.deepEqual(sent, [{ to: "synthetic-briefing", text: "Briefing" },
      { to: "synthetic-research", text: "Research", bytes: "Synthetic summary" }]);
    assert.ok(fs.existsSync(path.join(folder, "archive", `${flag.id}.md`)));
    relay.stop();
    fs.writeFileSync(file, JSON.stringify({ ...flag, attachmentPath: undefined }));
    relay = startOutboxRelay(transport);
    await relay.sweep();
    assert.equal(sent.length, 2);
    assert.ok(fs.existsSync(path.join(folder, "archive", name + ".rejected")));
    relay.stop();
    Object.assign(roamConfig, { briefingChatJid: "", researchChatJid: "" });
    writeOutboxMessage("briefing", "Unconfigured");
    relay = startOutboxRelay(transport);
    await relay.sweep();
    assert.equal(sent.length, 2);
  } finally { relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("refuses unsafe attachments, symlinked channels and flags, and defers send failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reject-"));
  const original = { ...roamConfig };
  let sends = 0;
  const transport = { isConnected: () => true, sendText: async () => { sends++; throw new Error("synthetic failure"); },
    sendFile: async () => { sends++; return false; } } as unknown as Transport;
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "synthetic-research", maxMdBytes: 8 });
    const folder = path.join(dir, "research");
    fs.mkdirSync(folder);
    const outside = path.join(dir, "outside.md"); fs.writeFileSync(outside, "Outside");
    fs.symlinkSync(outside, path.join(folder, "link.md"));
    fs.writeFileSync(path.join(folder, "wrong.txt"), "Text");
    fs.writeFileSync(path.join(folder, "large.md"), "x".repeat(9));
    fs.mkdirSync(path.join(folder, "nested")); fs.writeFileSync(path.join(folder, "nested", "file.md"), "Nested");
    const candidates = ["link.md", outside, "wrong.txt", "large.md", "nested/file.md"];
    candidates.forEach((attachmentPath, i) => fs.writeFileSync(path.join(folder, `${i}.json`), JSON.stringify({
      id: `synthetic-${i}`, type: "message", timestamp: Date.now(), text: "Test", attachmentPath,
    })));
    fs.symlinkSync(outside, path.join(folder, "symlink.json"));
    relay = startOutboxRelay(transport);
    await relay.sweep();
    assert.equal(sends, 0);
    assert.equal(fs.readdirSync(path.join(folder, "archive")).filter(f => f.endsWith(".json.rejected")).length, 6);
    assert.equal(fs.readFileSync(outside, "utf8"), "Outside");
    writeOutboxMessage("research", "Send failure");
    await relay.sweep();
    assert.equal(sends, 1);
    relay.stop();
    fs.renameSync(folder, path.join(dir, "real"));
    fs.symlinkSync(path.join(dir, "real"), folder);
    fs.writeFileSync(path.join(folder, "keep.json"), "{}");
    relay = startOutboxRelay(transport);
    await relay.sweep();
    assert.ok(fs.existsSync(path.join(folder, "keep.json")));
  } finally { relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("refuses hard links and attachments replaced by symlinks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-links-"));
  const original = { ...roamConfig };
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  let sends = 0;
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "synthetic-research" });
    const source = path.join(dir, "source.md"); fs.writeFileSync(source, "Synthetic");
    for (const kind of ["hard", "symbolic"]) {
      writeOutboxMessage("research", kind, source);
      const flagFile = path.join(dir, "research", fs.readdirSync(path.join(dir, "research")).find(n => n.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(dir, "research", n), "utf8")).text === kind)!);
      const flag = JSON.parse(fs.readFileSync(flagFile, "utf8"));
      fs.unlinkSync(flag.attachmentPath);
      if (kind === "hard") fs.linkSync(source, flag.attachmentPath);
      else fs.symlinkSync(source, flag.attachmentPath);
    }
    relay = startOutboxRelay({ isConnected: () => true, sendFile: async () => { sends++; return true; } } as unknown as Transport);
    await relay.sweep();
    assert.equal(sends, 0);
  } finally { relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("a FIFO flag cannot block a sweep", { timeout: 5000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fifo-"));
  try {
    fs.mkdirSync(path.join(dir, "research"));
    const fifo = path.join(dir, "research", "x.json");
    if (spawnSync("mkfifo", [fifo]).status !== 0) { t.skip("mkfifo unavailable"); return; }
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { roamConfig } from './src/config.ts';
      import { startOutboxRelay } from './src/roam/outbox-relay.ts';
      Object.assign(roamConfig, { outboxDir: process.argv[1], researchChatJid: 'synthetic', briefingChatJid: '' });
      const relay = startOutboxRelay({ isConnected: () => true });
      await relay.sweep(); relay.stop();
    `, dir], { timeout: 3000 });
    assert.equal(result.status, 0, String(result.error));
    assert.ok(fs.existsSync(fifo.replace('x.json', 'archive/x.json.rejected')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("limits oldest-first sweeps and rolling-hour sends, retries transport and missing attachments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-limits-"));
  const original = { ...roamConfig }; const originalNow = Date.now;
  let now = originalNow(); let fail = true; let connected = false; const sent: string[] = [];
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "synthetic", relayMaxPerSweep: 1, relayMaxPerHour: 2 });
    Date.now = () => now;
    const folder = path.join(dir, "research"); fs.mkdirSync(folder);
    const put = (name: string, timestamp: number, attachmentPath?: string) => fs.writeFileSync(path.join(folder, name + ".json"), JSON.stringify({ id: name, type: "message", timestamp, text: name, attachmentPath }));
    put("z-old", now - 10); put("a-new", now);
    relay = startOutboxRelay({ isConnected: () => connected, sendText: async (_: string, text: string) => { if (fail) throw Error(); sent.push(text); }, sendFile: async () => { sent.push("file"); return true; } } as unknown as Transport);
    await relay.sweep(); assert.ok(fs.existsSync(path.join(folder, "z-old.json")));
    assert.deepEqual(sent, []); connected = true;
    await relay.sweep(); assert.ok(fs.existsSync(path.join(folder, "z-old.json")));
    fail = false; await relay.sweep(); assert.deepEqual(sent, ["z-old"]);
    await relay.sweep(); assert.deepEqual(sent, ["z-old", "a-new"]);
    put("later", now, "later.md"); await relay.sweep(); assert.ok(fs.existsSync(path.join(folder, "later.json")));
    now += 3600001; put("later", now, "later.md");
    await relay.sweep(); assert.ok(fs.existsSync(path.join(folder, "later.json")));
    fs.writeFileSync(path.join(folder, "later.md"), "Synthetic"); await relay.sweep(); assert.equal(sent.at(-1), "file");
    now += 3600001;
    put("missing", now - 600001, "missing.md"); await relay.sweep();
    assert.ok(fs.existsSync(path.join(folder, "archive", "missing.json.rejected")));
    put("stale", now - 49 * 3600000); await relay.sweep();
    assert.ok(fs.existsSync(path.join(folder, "archive", "stale.json.rejected")));
  } finally { Date.now = originalNow; relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("loads only fresh archive ids once and bounds the seen set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-archive-"));
  const original = { ...roamConfig }; let relay: ReturnType<typeof startOutboxRelay> | undefined;
  const sent: string[] = [];
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "synthetic", relaySeenLimit: 2 });
    const folder = path.join(dir, "research"); const archive = path.join(folder, "archive"); fs.mkdirSync(archive, { recursive: true });
    const put = (root: string, id: string) => { const file = path.join(root, id + ".json"); fs.writeFileSync(file, JSON.stringify({ id, type: "message", timestamp: Date.now(), text: id })); return file; };
    const old = put(archive, "old"); fs.utimesSync(old, 0, 0); put(archive, "fresh");
    relay = startOutboxRelay({ isConnected: () => true, sendText: async (_: string, text: string) => { sent.push(text); } } as Transport);
    put(archive, "after-start"); put(folder, "old"); put(folder, "fresh"); await relay.sweep();
    assert.deepEqual(sent, ["old"]);
    put(folder, "after-start"); await relay.sweep(); assert.equal(sent.at(-1), "after-start");
    put(folder, "extra"); await relay.sweep();
    put(folder, "old"); await relay.sweep(); assert.equal(sent.filter(x => x === "old").length, 2);
    assert.ok(fs.existsSync(old));
  } finally { relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("parses extra channels from the environment without exposing recipients in warnings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-"));
  const recipient = "example-group-id/+==";
  const pairs = (count: number) => Array.from({ length: count }, (_, i) => `channel-${i}=${recipient}${i}`).join(",");
  const cases: { value?: string; names: string[]; warnings: [number, string][] }[] = [
    { names: [], warnings: [] },
    { value: "", names: [], warnings: [] },
    { value: `updates=${recipient}`, names: ["updates"], warnings: [] },
    { value: `a=${"x".repeat(200)},${"a".repeat(32)}=${recipient}`, names: ["a", "a".repeat(32)], warnings: [] },
    { value: `Bad=${recipient},../escape=${recipient},${"a".repeat(33)}=${recipient}`, names: [], warnings: [[1, "<invalid>"], [2, "<invalid>"], [3, "<invalid>"]] },
    { value: `updates\n=${recipient}, updates=${recipient},updates =${recipient}`, names: ["updates"], warnings: [[1, "<invalid>"], [3, "<invalid>"]] },
    { value: `first=${recipient}, second=example-other-id ,`, names: ["first", "second"], warnings: [] },
    { value: `first=${recipient},second=${recipient}`, names: ["first"], warnings: [[2, "second"]] },
    { value: `briefing=${recipient},research=${recipient},archive=${recipient}`, names: [], warnings: [[1, "briefing"], [2, "research"], [3, "archive"]] },
    { value: `updates=${recipient},updates=Example/Other+Id=`, names: ["updates"], warnings: [[2, "updates"]] },
    // A skipped entry whose right-hand side looks like a channel name may be a reversed pair (`id=name`),
    // so its left-hand side is not echoed.
    { value: `updates=${recipient},updates=notices`, names: ["updates"], warnings: [[2, "<invalid>"]] },
    { value: `updates=,=${recipient},missing`, names: [], warnings: [[1, "updates"], [2, "<invalid>"], [3, "<invalid>"]] },
    { value: `long=${"x".repeat(201)},space=example id,control=example\u007fid,tab=example\tid`, names: [], warnings: [[1, "long"], [2, "space"], [3, "control"], [4, "tab"]] },
    { value: pairs(10), names: Array.from({ length: 8 }, (_, i) => `channel-${i}`), warnings: [[9, "channel-8"], [10, "channel-9"]] },
    { value: `bad=,${pairs(8)}`, names: Array.from({ length: 8 }, (_, i) => `channel-${i}`), warnings: [[1, "bad"]] },
    { value: recipient, names: [], warnings: [[1, "<invalid>"]] },
  ];
  try {
    for (const { value, names, warnings } of cases) {
      const env = { ...process.env, KLEINBOT_RUNTIME_DIR: dir };
      delete env.ROAM_OUTBOX_EXTRA_CHANNELS;
      if (value !== undefined) env.ROAM_OUTBOX_EXTRA_CHANNELS = value;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        const warnings = [];
        console.warn = (...args) => warnings.push(args.join(' '));
        const { roamConfig } = await import('./src/config.ts');
        console.log(JSON.stringify({ channels: roamConfig.outboxExtraChannels, warnings }));
      `], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(result.stdout);
      assert.deepEqual(actual.channels.map((entry: { channel: string }) => entry.channel), names);
      if (value === `updates=${recipient}`) assert.equal(actual.channels[0].recipient, recipient);
      assert.deepEqual(actual.warnings, warnings.map(([position, name]) =>
        `[roam] ROAM_OUTBOX_EXTRA_CHANNELS entry ${position} (${name}) skipped`));
      assert.ok(!actual.warnings.join("\n").includes(recipient));
      assert.ok(!actual.warnings.join("\n").includes("example-other-id"));
      assert.ok(!actual.warnings.join("\n").includes("Example/Other+Id="));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("relays extra channels to pinned recipients with attachment, stale and duplicate checks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-extra-"));
  const original = { ...roamConfig };
  const sent: { to: string; text: string; bytes?: string }[] = [];
  const recipient = "example-group-id/+==";
  const transport = { isConnected: () => true,
    sendText: async (to: string, text: string) => { sent.push({ to, text }); },
    sendFile: async (to: string, bytes: Buffer, _name: string, mime: string, text: string) => {
      assert.equal(mime, "text/markdown"); sent.push({ to, text, bytes: bytes.toString() }); return true;
    } } as Transport;
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "",
      outboxExtraChannels: [{ channel: "updates", recipient }] });
    const folder = path.join(dir, "updates"); fs.mkdirSync(folder);
    const put = (id: string, extra = {}) => fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify({
      id, type: "message", timestamp: Date.now(), text: "Synthetic notice", targetChatJid: "example-untrusted-id", ...extra,
    }));
    put("text"); put("markdown", { attachmentPath: "markdown.md" });
    fs.writeFileSync(path.join(folder, "markdown.md"), "Synthetic markdown");
    put("stale", { timestamp: Date.now() - 49 * 3600000 });
    put("unsafe", { attachmentPath: "../outside.md" });
    fs.writeFileSync(path.join(dir, "outside.md"), "Synthetic outside attachment");
    relay = startOutboxRelay(transport); await relay.sweep();
    assert.equal(sent.length, 2);
    assert.ok(sent.every(send => send.to === recipient));
    assert.equal(sent.find(send => send.bytes)?.bytes, "Synthetic markdown");
    for (const name of ["text.json", "markdown.json", "markdown.md", "stale.json.rejected", "unsafe.json.rejected"])
      assert.ok(fs.existsSync(path.join(folder, "archive", name)), name);
    assert.ok(fs.existsSync(path.join(dir, "outside.md")));
    relay.stop(); put("text");
    relay = startOutboxRelay(transport); await relay.sweep();
    assert.equal(sent.length, 2);
    assert.ok(fs.existsSync(path.join(folder, "archive", "text.json.rejected")));
  } finally { relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("creates extra folders with shared mode and refuses symlinks and non-directories without logging ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-extra-folders-"));
  const original = { ...roamConfig }; const oldWarn = console.warn;
  const warnings: string[] = []; let sends = 0;
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  const oldUmask = process.umask(0o077);
  try {
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "", groupReadable: true,
      outboxExtraChannels: ["updates", "linked", "file", "dangling"].map(channel => ({ channel, recipient: "example-group-id" })) });
    const target = path.join(dir, "target"); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.json"), JSON.stringify({ id: "keep", type: "message", timestamp: Date.now(), text: "Synthetic" }));
    fs.symlinkSync(target, path.join(dir, "linked"));
    fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "dangling"));
    fs.writeFileSync(path.join(dir, "file"), "Synthetic obstruction");
    relay = startOutboxRelay({ isConnected: () => true, sendText: async () => { sends++; } } as unknown as Transport);
    await relay.sweep();
    assert.equal(fs.statSync(path.join(dir, "updates")).mode & 0o777, 0o770);
    assert.equal(sends, 0);
    assert.deepEqual(fs.readdirSync(target), ["keep.json"]);
    assert.ok(!fs.existsSync(path.join(dir, "missing")));
    assert.equal(fs.readFileSync(path.join(dir, "file"), "utf8"), "Synthetic obstruction");
    assert.equal(warnings.length, 3);
    assert.ok(!warnings.join("\n").includes("example-group-id"));
    // Each warning names its channel (never the recipient), so an operator can tell which folder is broken.
    for (const channel of ["linked", "file", "dangling"]) {
      assert.ok(warnings.some(w => w.includes(`Outbox channel unavailable (channel ${channel})`)), channel);
    }
  } finally { process.umask(oldUmask); console.warn = oldWarn; relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("never re-modes existing channel or archive folders, and keeps an inherited setgid bit on ones it creates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-shared-modes-"));
  const original = { ...roamConfig };
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  const oldUmask = process.umask(0o007);
  try {
    fs.chmodSync(dir, 0o2770);
    // An installer's shared layout: setgid, group-writable, already present.
    for (const p of ["briefing", "briefing/archive", "updates", "updates/archive"]) {
      fs.mkdirSync(path.join(dir, p)); fs.chmodSync(path.join(dir, p), 0o2770);
    }
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "example-briefing-id", researchChatJid: "", groupReadable: true,
      outboxExtraChannels: ["updates", "fresh"].map(channel => ({ channel, recipient: "example-group-id" })) });
    relay = startOutboxRelay({ isConnected: () => true, sendText: async () => {} } as unknown as Transport);
    await relay.sweep(); await relay.sweep();
    for (const p of ["briefing", "briefing/archive", "updates", "updates/archive"]) {
      assert.equal(fs.statSync(path.join(dir, p)).mode & 0o7777, 0o2770, p);
    }
    // A folder the relay had to create under the setgid parent keeps setgid and gets the shared mode.
    assert.equal(fs.statSync(path.join(dir, "fresh")).mode & 0o7777, 0o2770);
  } finally { process.umask(oldUmask); relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the 20-flag sweep and 30-send rolling-hour limits independent per channel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-extra-limits-"));
  const original = { ...roamConfig }; const oldNow = Date.now;
  let now = oldNow(); const sent: string[] = [];
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  try {
    Date.now = () => now;
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "example-briefing-id", researchChatJid: "example-research-id",
      relayMaxPerSweep: 20, relayMaxPerHour: 30,
      outboxExtraChannels: ["updates", "notices"].map(channel => ({ channel, recipient: `example-${channel}-id` })) });
    for (const channel of ["briefing", "research", "updates", "notices"]) {
      const folder = path.join(dir, channel); fs.mkdirSync(folder);
      for (let i = 0; i < 31; i++) fs.writeFileSync(path.join(folder, `${i}.json`), JSON.stringify({
        id: `${channel}-${i}`, type: "message", timestamp: now - 31 + i, text: String(i),
      }));
    }
    relay = startOutboxRelay({ isConnected: () => true, sendText: async (to: string, text: string) => { sent.push(`${to}:${text}`); } } as Transport);
    for (const expected of [20, 30, 30, 31]) {
      if (expected === 31) now += 3600001;
      await relay.sweep();
      for (const channel of ["briefing", "research", "updates", "notices"])
        assert.deepEqual(sent.filter(s => s.startsWith(`example-${channel}-id:`)),
          Array.from({ length: expected }, (_, i) => `example-${channel}-id:${i}`));
    }
  } finally { Date.now = oldNow; relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("creates extra folders owner-only unless the outbox is marked group readable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-extra-mode-"));
  const original = { ...roamConfig };
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  const oldUmask = process.umask(0o000);
  try {
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "", groupReadable: false,
      outboxExtraChannels: [{ channel: "updates", recipient: "example-group-id" }] });
    relay = startOutboxRelay({ isConnected: () => true, sendText: async () => {} } as unknown as Transport);
    await relay.sweep();
    assert.equal(fs.statSync(path.join(dir, "updates")).mode & 0o777, 0o700);
  } finally { process.umask(oldUmask); relay?.stop(); Object.assign(roamConfig, original); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("permanently rejects configured secrets on every channel without logging values or recipients", async (t) => {
  for (const channel of ["briefing", "research", "updates"]) {
    for (const kind of ["text", "attachment", "split-attachment"]) await t.test(`${channel}: ${kind}`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-egress-"));
      const original = { ...roamConfig }, previousSecret = process.env.MOLTBOOK_API_KEY;
      const secret = "invented-relay-secret-value";
      const warnings: string[] = [], sent: unknown[] = [];
      let relay: ReturnType<typeof startOutboxRelay> | undefined;
      try {
        process.env.MOLTBOOK_API_KEY = secret;
        Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "invented-briefing-recipient",
          researchChatJid: "invented-research-recipient", outboxExtraChannels: [{ channel: "updates", recipient: "invented-extra-recipient" }] });
        t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.join(" ")); });
        const folder = path.join(dir, channel); fs.mkdirSync(folder, { recursive: true });
        const attachment = path.join(folder, "invented.md"), file = path.join(folder, "invented.json");
        const flag = { id: "invented-egress-id", type: "message", timestamp: Date.now(),
          text: kind === "text" ? secret : "Safe text", attachmentPath: attachment };
        fs.writeFileSync(attachment, kind === "text" ? "Safe attachment" : kind === "attachment" ? secret : secret.split("-").join("-\n"));
        fs.writeFileSync(file, JSON.stringify(flag));
        relay = startOutboxRelay({ isConnected: () => true,
          sendText: async (...args: unknown[]) => { sent.push(args); },
          sendFile: async (...args: unknown[]) => { sent.push(args); return true; } } as unknown as Transport);
        await relay.sweep();
        assert.deepEqual(sent, []);
        assert.ok(fs.existsSync(path.join(folder, "archive", "invented.json.rejected")));
        assert.ok(fs.existsSync(path.join(folder, "archive", "invented.md.rejected")));
        assert.deepEqual(warnings, [`[roam] Outbox flag rejected (channel ${channel})`]);
        assert.ok(!warnings.join(" ").includes(secret));
        assert.doesNotMatch(warnings.join(" "), /recipient/);
        // A safe replacement with the same id is still rejected in this process and after restart.
        for (const restart of [false, true]) {
          if (restart) {
            relay.stop();
            relay = startOutboxRelay({ isConnected: () => true, sendText: async () => { sent.push("unexpected"); } } as unknown as Transport);
          }
          fs.writeFileSync(file, JSON.stringify({ ...flag, text: "Safe replacement", attachmentPath: undefined }));
          await relay.sweep();
          assert.deepEqual(sent, []);
        }
      } finally {
        relay?.stop(); t.mock.restoreAll(); Object.assign(roamConfig, original);
        if (previousSecret === undefined) delete process.env.MOLTBOOK_API_KEY; else process.env.MOLTBOOK_API_KEY = previousSecret;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

it("checks the descriptor buffer even when the attachment path is replaced after reading", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-buffer-"));
  const original = { ...roamConfig }, previousSecret = process.env.MOLTBOOK_API_KEY;
  const secret = "invented-buffer-secret";
  const readSync = fs.readSync;
  let relay: ReturnType<typeof startOutboxRelay> | undefined;
  try {
    process.env.MOLTBOOK_API_KEY = secret;
    Object.assign(roamConfig, { outboxDir: dir, briefingChatJid: "", researchChatJid: "invented-recipient", outboxExtraChannels: [] });
    const folder = path.join(dir, "research"); fs.mkdirSync(folder);
    for (const originalBytes of [secret, "Safe descriptor bytes"]) {
      const file = path.join(folder, "buffer.md");
      fs.writeFileSync(file, originalBytes);
      const inode = fs.statSync(file).ino;
      let swapped = false;
      t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
        const count = readSync(...args);
        if (!swapped && fs.fstatSync(args[0]).ino === inode) {
          swapped = true;
          fs.unlinkSync(file);
          fs.writeFileSync(file, originalBytes === secret ? "Safe replacement" : secret);
        }
        return count;
      });
      fs.writeFileSync(path.join(folder, "buffer.json"), JSON.stringify({ id: `invented-${originalBytes === secret}`,
        type: "message", timestamp: Date.now(), text: "Safe caption", attachmentPath: file }));
      const sent: string[] = [];
      relay = startOutboxRelay({ isConnected: () => true, sendFile: async (_to: string, bytes: Buffer) => {
        sent.push(bytes.toString()); return true;
      } } as unknown as Transport);
      await relay.sweep(); relay.stop(); t.mock.restoreAll();
      assert.equal(swapped, true);
      assert.deepEqual(sent, originalBytes === secret ? [] : [originalBytes]);
    }
  } finally {
    relay?.stop(); t.mock.restoreAll(); Object.assign(roamConfig, original);
    if (previousSecret === undefined) delete process.env.MOLTBOOK_API_KEY; else process.env.MOLTBOOK_API_KEY = previousSecret;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
