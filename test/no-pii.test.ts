// Guard: user data and secrets must never enter the tracked source tree.
// This repo is public — see the "Privacy & data/source separation" section in CLAUDE.md.
// If this test fails, DO NOT whitelist the value: move it to env / config (src/config.ts)
// and keep the real value in the gitignored runtime .env.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Placeholder numbers used in docs/.env.example — these are intentionally fake.
const PHONE_ALLOWLIST = new Set(["+447123456789", "+447987654321"]);

// .plist: launchd daemon definitions are installed world-readable, so a phone
// number leaking into one is worse than in ordinary source.
const TEXT_EXT = new Set([".ts", ".js", ".md", ".json", ".yaml", ".yml", ".sh", ".plist", ".service"]);
const SKIP = new Set(["package-lock.json", "no-pii.test.ts"]);

function tracked(predicate: (f: string) => boolean): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter(f => !SKIP.has(path.basename(f))).filter(predicate);
}

function isTextFile(f: string): boolean {
  const base = path.basename(f);
  if (base === ".gitignore" || base.endsWith(".example")) return true;
  return TEXT_EXT.has(path.extname(base));
}

function read(f: string): string {
  return fs.readFileSync(path.join(repoRoot, f), "utf8");
}

describe("no PII / secrets in the tracked source tree", () => {
  it("scans a non-trivial set of tracked files", () => {
    assert.ok(tracked(isTextFile).length > 5);
  });

  it("has no hardcoded real phone numbers (use env / config)", () => {
    const offenders: string[] = [];
    for (const f of tracked(isTextFile)) {
      for (const m of read(f).match(/\+447\d{9}/g) || []) {
        if (!PHONE_ALLOWLIST.has(m)) offenders.push(`${f}: ${m}`);
      }
    }
    assert.deepEqual(offenders, [],
      `Hardcoded phone number(s) found — move to env:\n${offenders.join("\n")}`);
  });

  it("has no hardcoded base64 group IDs in source code (use env / config)", () => {
    // A Signal group ID is 32 bytes => a 44-char base64 string ending in "=".
    // Scan only code files; docs use the @g.us digit form, checked separately below.
    const jidShape = /["'`][A-Za-z0-9+/]{43}=["'`]/g;
    const offenders: string[] = [];
    for (const f of tracked(f => /\.(ts|js)$/.test(f))) {
      for (const m of read(f).match(jidShape) || []) {
        offenders.push(`${f}: ${m.slice(1, 13)}…`);
      }
    }
    assert.deepEqual(offenders, [],
      `Hardcoded group ID(s) found — move to env:\n${offenders.join("\n")}`);
  });

  // WhatsApp identifiers in their digit form: group JIDs (@g.us) and LIDs (@lid).
  // These leak just as badly as phone numbers but are easy to paste in from a log or
  // a runtime chats.json while writing a doc or a test, so scan EVERY tracked text
  // file — docs included, which is where they are most likely to end up.
  //
  // Placeholders must be obviously synthetic. Prefer the existing repo convention
  // (120363000000000000@g.us) or a repdigit run. If this fails, do NOT add the real
  // value here — replace it with a placeholder.
  it("has no real WhatsApp group JIDs or LIDs, in code OR docs", () => {
    const PLACEHOLDERS = new Set([
      "120363000000000000",  // repo-wide fake group, used in CLAUDE.md/README
      "555000111222333",     // fake bot LID (tests)
      "777000111222333",     // fake stranger LID (tests)
      "111000111222333",     // fake admin LID (tests)
      "447700900123",        // Ofcom reserved-for-drama range (tests)
    ]);
    const waId = /(\d{11,20})(@g\.us|@lid)/g;
    const offenders: string[] = [];
    for (const f of tracked(isTextFile)) {
      for (const m of read(f).matchAll(waId)) {
        if (!PLACEHOLDERS.has(m[1])) offenders.push(`${f}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [],
      `Real WhatsApp identifier(s) found — replace with a placeholder:\n${offenders.join("\n")}`);
  });

  // The worst thing that could land in this repo is a live credential, and the
  // launchd work makes it worse: a plist in /Library/LaunchDaemons is
  // world-readable on the Mac. Match the two secret shapes this project
  // actually handles — the Claude OAuth/API token (sk-ant-oat…, sk-ant-api…)
  // and the Moltbook key — rather than trying to catch every secret in
  // general. Offenders are reported by file and prefix only; the matched
  // secret is never printed in full, since CI output is not a safe place for
  // it either.
  it("has no Claude or Moltbook credentials in any tracked text file", () => {
    // [a-z0-9]+ for the middle segment, NOT [a-z]+: real tokens are
    // sk-ant-oat01-… / sk-ant-api03-…, and a letters-only class never reaches
    // the second hyphen, so it would silently match nothing. Moltbook keys
    // carry an underscore-separated middle segment (moltbook_xx_<32 alnum>),
    // so the class after the prefix must admit underscores or the scanner
    // stops at the second underscore and never accumulates 16 chars.
    const secretShape = /sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}|moltbook_[A-Za-z0-9_]{16,}/g;
    const offenders: string[] = [];
    for (const f of tracked(isTextFile)) {
      for (const m of read(f).match(secretShape) || []) {
        offenders.push(`${f}: ${m.slice(0, 12)}…`);
      }
    }
    assert.deepEqual(offenders, [],
      `Credential-shaped string(s) found — revoke the secret, then move it to a mode-600 env file:\n${offenders.join("\n")}`);
  });

  // Personal-content backstop: reads an operator-maintained ban list from
  // OUTSIDE the repo, so the list itself is never published. On machines
  // without the file this check silently passes. Keyword matching cannot judge
  // prose — the real gate is the pre-push review required by the Privacy
  // section of CLAUDE.md; this only pins terms that have already leaked once
  // so they can never regress.
  it("contains no terms from the operator's private ban list (if present)", () => {
    const termsPath = process.env.KLEINBOT_PRIVATE_TERMS ||
      path.join(process.env.HOME || "", "team/config/kleinbot/private-terms.txt");
    if (!fs.existsSync(termsPath)) return;
    const terms = fs.readFileSync(termsPath, "utf8").split("\n")
      .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    const offenders: string[] = [];
    for (const f of tracked(isTextFile)) {
      const text = read(f).toLowerCase();
      for (const t of terms) {
        if (text.includes(t.toLowerCase())) offenders.push(`${f}: "${t}"`);
      }
    }
    assert.deepEqual(offenders, [],
      `Private term(s) in tracked files — personal content, must not be published:\n${offenders.join("\n")}`);
  });
});
