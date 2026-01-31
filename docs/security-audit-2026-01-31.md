# Security Audit: Kleinbot

**Date:** 2026-01-31
**Auditor:** Claude (Opus 4.5), prompted by project maintainer
**Scope:** Full codebase, all dependencies, configuration, credential storage, scripts
**Tools used:** Manual source review, `npm audit`, dependency tree analysis

---

## Overall Assessment

The codebase is clean and well-structured. No malware, data exfiltration, telemetry, or suspicious code was found. `npm audit` reports **0 known vulnerabilities** across 81 installed packages. The main risks relate to credential storage location and an unpinned git dependency.

---

## Critical Findings

### 1. WhatsApp credentials synced to Dropbox

The project lives under `~/Dropbox/`, which means `data/auth/creds.json` (containing private keys, device signatures, and account credentials for `[redacted]@s.whatsapp.net`) is being synced to Dropbox's cloud servers. If the Dropbox account is compromised, the WhatsApp session is compromised.

- **Files at risk:** `data/auth/creds.json`, 30 pre-key files, 2 session files (148KB total)
- **Contents:** Base64-encoded private keys (`noiseKey`, `signedIdentityKey`, `signedPreKey`), device signatures, registration state
- **Note:** `.gitignore` correctly excludes these from version control, but Dropbox sync is a separate exposure vector

**Recommended fix:** Symlink `data/auth/` to a local-only directory outside Dropbox, e.g.:

```bash
mv data/auth ~/.local/share/kleinbot-auth
ln -s ~/.local/share/kleinbot-auth data/auth
```

### 2. Unpinned git dependency (libsignal-node)

Baileys depends on `@whiskeysockets/libsignal-node` loaded directly from GitHub (`git+https://github.com/whiskeysockets/libsignal-node`). The package-lock.json pins it to commit `1c30d7d`, which provides reasonable protection. However, this dependency bypasses npm registry integrity checks and `npm audit` coverage entirely. If the WhiskeySockets GitHub org were compromised, a future `npm install` (without a lock file) could pull malicious code.

**Mitigation:** This is an inherent Baileys design choice. Keep `package-lock.json` intact. Be cautious with `npm update` — review changes to this dependency manually.

---

## Medium Findings

### 3. File permissions are too open

Auth files are created with `644` permissions (world-readable). Private keys should be owner-only.

**Fix:**

```bash
chmod 600 data/auth/*
```

Add `umask 077` to `scripts/setup.sh` before directory creation.

### 4. No audit logging

Claude's decisions (what it chose to respond to and why) are not logged. If the bot sends something inappropriate, there is no trail to investigate. Error output goes to `data/cron.log` but successful decisions are silent.

**Fix:** Log Claude prompts and responses to a separate rotating log file, e.g. `data/decisions.log`.

### 5. JSON parsing uses regex fallback

In `src/ai.ts`, if Claude's output is not clean JSON, a regex `result.match(/\{[\s\S]*\}/)` attempts extraction. This is fragile but safe in practice — the fallback returns `{ shouldRespond: false }`, so the bot stays silent on unparseable output.

---

## Low Findings

### 6. No input validation on GROUP_JID

`config.ts` accepts any string for `GROUP_JID` without format validation. Low risk since this is set by the operator, not external input.

### 7. No rate limiting beyond per-run cap

`MAX_RESPONSES_PER_RUN` (default: 2) limits responses per cron invocation, but with a 5-minute cron interval that allows up to 24 messages/hour. No per-user or per-day limiting exists.

### 8. Hardcoded 10-second message collection window

The message collection timeout in `src/index.ts` is not configurable. If the WhatsApp connection is slow, messages could be missed.

---

## Positive Findings

- No secrets in source code or git history
- `.env` and `data/` properly gitignored
- Uses `execFile` (not `exec`) for Claude CLI — no shell injection
- TypeScript strict mode enabled throughout
- No `eval()`, `Function()`, or dynamic code execution
- No telemetry or analytics in any dependency
- No postinstall/preinstall scripts in project
- No native compilation required — sharp and esbuild use prebuilt binaries
- Rate limiting via `MAX_RESPONSES_PER_RUN` and flock-based concurrency control
- Safe defaults — bot stays silent when Claude output is unparseable
- `markOnlineOnConnect: false` reduces WhatsApp ban risk

---

## Dependency Inventory

| Package | Version | Risk | Notes |
|---|---|---|---|
| baileys | 6.7.21 | Accepted | Unofficial WhatsApp Web API; ban risk acknowledged |
| dotenv | 16.6.1 | Low | Simple env loader, well-audited |
| pino | 9.14.0 | Low | Standard structured logger |
| qrcode-terminal | 0.12.0 | Low | Terminal QR display, no network |
| @whiskeysockets/libsignal-node | git:1c30d7d | Medium | Git dependency, bypasses npm audit |
| axios | 1.7.x | Low | No current advisories; transitive via Baileys |
| sharp (prebuilt) | via @img scope | Low | Official prebuilt binaries, no compilation |
| protobufjs | 7.2.4+ | Low | Protocol buffer parser; transitive via Baileys |
| ws | 8.x | Low | WebSocket client; transitive via Baileys |

Total installed packages: 81 directories in `node_modules/`.

---

## Recommended Actions (Priority Order)

1. **Move `data/auth/` out of Dropbox** — symlink to local-only storage
2. **Tighten file permissions** — `chmod 600` on auth files, `umask 077` in scripts
3. **Add decision logging** — log what Claude decided and why
4. **Preserve package-lock.json** — main protection against git dependency drift
5. **Add log rotation** for `data/cron.log` and any future decision logs

---

## Scope Limitations

- This audit covers the application code and direct/transitive npm dependencies
- Baileys' internal protocol implementation was not audited at the cryptographic level
- WhatsApp's server-side behaviour and data handling are outside scope
- The Claude CLI tool itself was not audited (trusted as a system dependency)
- No penetration testing was performed
