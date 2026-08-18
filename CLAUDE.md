# Kleinbot — Multi-Transport Chat Facilitation Bot

## Privacy — read before committing, and again before every push

This repo is **public**. Two rules. The second is the one that has failed before.

**Rule 1 — user data and secrets are never part of the source.**

- `data/` (message history, state, notes, auth), **all prompts including per-group
  prompts** (a group's personality/context is user data — only `*.example`
  templates belong here), and `config/.env` live only in the gitignored runtime
  dir, never in the repo.
- Never hardcode phone numbers, JIDs, group IDs, real names, emails, or
  `/home/...` paths — read them from env via `src/config.ts`
  (`ADMIN_JID`, `SIGNAL_ADMIN_NUMBER`, `SIGNAL_EDITOR_GROUP_JID`, … see `.env.example`).

**Rule 2 — prose about people is user data too.** For every sentence in docs,
code comments, and commit messages, ask: *does this describe the software, or
its operator and users?* Facts about anyone's life are private even when they
contain no identifier: family, friends, homes, schedules, trips, purchases,
finances, group memberships and a group's internal affairs, usage patterns and
statistics, quoted chat messages, home-directory layouts, authored personas,
politics. Incident reports and plans that draw on real usage belong in the
operator's private docs, never here; this repo gets a sanitized version only
if it is useful to any user of the software. (2026-08-18: this repo's history
had to be replaced because "private" was read as Rule 1 only.)

**Enforcement:**

- `test/no-pii.test.ts` fails the build on identifiers, credential shapes, and
  any term from an operator-maintained ban list kept *outside* the repo. If it
  fails, move the value out — do not whitelist it.
- Keyword scans cannot judge prose. **Before any push, a fresh agent session
  must read the full diff since the last pushed commit — commit messages
  included — applying the Rule 2 test, and report what it found.** Push only
  after that review passes.
- Anything pushed to a public repo lives in git history forever: scrub before
  pushing, never after.

## Transports — WhatsApp AND Signal

Kleinbot runs on **two transports simultaneously**:

1. **WhatsApp** (`index-whatsapp.ts`) — group chats + DMs. Baileys companion device, persistent daemon.
2. **Signal** (`index-signal.ts`) — DMs and small groups. signal-cli daemon via Unix socket JSON-RPC.

Each transport has its own entry point, state, pending queue, and notes directory:

| | WhatsApp | Signal |
|---|---|---|
| Entry point | `src/index-whatsapp.ts` | `src/index-signal.ts` |
| Pending messages | `~/team/kleinbot/data/whatsapp/pending.json` | `~/team/kleinbot/data/signal/pending.json` |
| Bot notes | `~/team/kleinbot/data/whatsapp/notes/` | `~/team/kleinbot/data/signal/notes/` |
| Chat config | `prompts/chats.json` (JIDs) | `prompts/signal-chats.json` (phone numbers) |
| State | `~/team/kleinbot/data/whatsapp/state.json` | `~/team/kleinbot/data/signal/state.json` |

## Architecture

Persistent daemon per transport. Messages arrive in real-time, accumulate in per-chat buffers, and are processed on a configurable interval by calling `claude --print` with per-chat prompt and model settings.

```
index.ts → startConnection(Baileys) → stays connected, receives messages in real-time
                                            ↓
              onNewMessages → dedup, save to state, add to per-chat pending queue
                                            ↓
              setInterval(processPending) → for each chat with pending messages:
                load prompt from chats.json → claude --print (per-chat model + prompt via stdin)
                                            ↓
              send response (if Claude says to) → handle moltbookAction if present → save state
                                            ↓
              send queued Moltbook cross-pollination digests to moltbook-enabled chats

index.ts → checkMorningBriefing() → every process tick, if past 05:30 UK and not run today:
              runMorningBriefing() → claude --print (opus + WebSearch/WebFetch)
              reads Moltbook feed (non-fatal) + web searches for AI news
                                            ↓
              sends conversational briefing to moltbook-enabled WhatsApp chats
              appends journal entry to data/moltbook-journal.md
```

Baileys as a linked/companion device does NOT receive offline messages — it only gets messages while the socket is connected. This is why a persistent daemon is required instead of cron-based connect/disconnect.

## Runtime directories

- **Data**: `~/team/kleinbot/data/` (signal, whatsapp, slack state, activity log, moltbook state)
- **Prompts**: `~/team/kleinbot/prompts/` (per-chat configs, personality prompts)
- **Config**: `~/team/kleinbot/config/.env`
- Code reads runtime paths via `KLEINBOT_RUNTIME_DIR` env var (default: `~/team/kleinbot/`)

## File Structure

- `src/index.ts` — Daemon: connect, collect messages in real-time, per-chat queues, process on interval, respond. Also runs morning briefing check each tick.
- `src/config.ts` — Loads `.env` from runtime dir, exports `dataDir`, `promptsDir`, `runtimeDir`
- `src/whatsapp.ts` — Baileys persistent connection: `startConnection()` with auto-reconnect, `extractMessages()`, `sendTextMessage()`
- `src/ai.ts` — Spawns `claude --print` with per-chat model/prompt + WebSearch/WebFetch tools, parses JSON `{shouldRespond, response}`. Also exports `getChatConfig()` for prompt lookup. Adds Moltbook instructions to system prompt for moltbook-enabled chats.
- `src/state.ts` — JSON state: dedup by message ID, rolling message history
- `src/types.ts` — Shared TypeScript interfaces (`ChatMessage`, `ChatConfig`, `ChatsConfig`, etc.)
- `src/qrcode-terminal.d.ts` — Type declaration for qrcode-terminal
- `src/moltbook/client.ts` — HTTP wrapper for Moltbook API (feed, posts, comments, voting, search). Uses Node's built-in `fetch`.
- `src/moltbook/cycle.ts` — Autonomous participation: fetch feed → Claude picks actions → execute (two-phase commenting). Also `runMorningBriefing()` for daily AI news digest.
- `src/moltbook/state.ts` — Moltbook state: seen posts, rate limit tracking, cross-pollination queue
- `src/moltbook/types.ts` — Moltbook-specific interfaces
- `src/moltbook/whatsapp-bridge.ts` — Handles WhatsApp-triggered Moltbook commands; sends cross-pollination digests to moltbook-enabled chats
- `src/signal.ts` — Signal transport: `SignalRpcClient` (Unix socket JSON-RPC to signal-cli daemon), `createSignalTransport()` factory. No npm deps (uses Node `net` module).
- `src/index-signal.ts` — Signal entry point (same pattern as index-discord.ts)
- `prompts/chats.json` — Per-chat config for WhatsApp: maps JIDs to prompt files and model names
- `prompts/signal-chats.json` — Per-chat config for Signal (phone numbers / base64 group IDs)
- `prompts/default.md` — Default bot personality and decision rules
- `prompts/moltbook.md` — System prompt for autonomous Moltbook participation (with prompt injection defense)
- `prompts/briefing.md` — System prompt for daily morning briefing (Moltbook + web search)
- `scripts/setup.sh` — npm install + directory setup
- `scripts/cron-run.sh` — Simple runner script (for systemd or manual use)
- `scripts/signal-setup.sh` — Downloads native signal-cli binary, creates data dirs
- `scripts/signal-cli.service` — Systemd user service for signal-cli daemon (socket mode)
- `scripts/moltbook-cycle.ts` — Manually trigger one Moltbook participation cycle (must run with `env -u CLAUDECODE`)
- `scripts/moltbook-register.ts` — One-time Moltbook registration (prints API key + claim URL)
- `data/notes/` — Bot's self-written notes per chat (persistent memory)
- `data/moltbook-state.json` — Seen posts, rate limits, cross-pollination queue, lastRunDate (gitignored)
- `data/moltbook-journal.md` — Rolling journal for briefing continuity (~8000 chars, ~40 days)
- `docs/security-audit-*.md` — Security audit reports

## Config (.env)

- `BOT_NAME` — Display name (default: "Kleinbot")
- `PROCESS_INTERVAL` — How often to process accumulated messages, in ms (default: 60000). Per-transport overrides are set in systemd service files (Signal: 5000ms for responsive DMs, WhatsApp: 600000ms/10min to avoid over-eager group chat replies). The `.env` value is a fallback for running outside systemd.
- `HISTORY_WINDOW` — Rolling message context size (default: 50)
- `LOG_LEVEL` — Pino log level for Baileys (default: "warn", use "debug" for troubleshooting)
- `MOLTBOOK_API_KEY` — Moltbook API key (get from `npx tsx scripts/moltbook-register.ts`). If unset, Moltbook features are disabled. Morning briefing runs daily at 05:30 UK time.
- `SIGNAL_ACCOUNT` — Bot's registered Signal phone number (e.g. `+447123456789`)
- `SIGNAL_ADMIN_NUMBER` — Admin's phone number for `/commands` (optional)
- `SIGNAL_SOCKET_PATH` — Override signal-cli socket path (default: `$XDG_RUNTIME_DIR/signal-cli/socket`)

## Per-chat Configuration (prompts/chats.json)

Maps chat JIDs to prompt files and Claude model names. The `default` key is used for any chat not explicitly listed.

```json
{
  "default": { "prompt": "prompts/default.md", "model": "opus" },
  "120363000000000000@g.us": { "prompt": "prompts/my-group.md", "model": "opus" },
  "440000000000@s.whatsapp.net": { "prompt": "prompts/dm-friend.md", "model": "sonnet" }
}
```

To add a custom personality for a chat: create a new `.md` file in `prompts/`, add a mapping in `chats.json`.

Add `"moltbook": true` to a chat config to enable Moltbook cross-pollination and WhatsApp commands for that chat.

## State

JSON file at `data/state.json` (gitignored). Tracks:
- `lastProcessedTimestamp` — Unix epoch of most recent processed message
- `processedMessageIds` — Dedup list (trimmed to 500)
- `messageHistory` — Rolling window of recent messages for cross-run context

## Auth

Baileys multi-file auth state in `data/auth/` (gitignored). Created on first QR scan. Bot uses a separate WhatsApp Business account on its own phone number.

Important: `fetchLatestBaileysVersion()` is called on startup to get the current WhatsApp Web version. The version bundled with Baileys goes stale quickly and WhatsApp will reject it with a 405 error.

## Key Design Decisions

- `claude --print` over SDK — uses Claude Code CLI, no API key needed
- Persistent daemon (not cron) — Baileys companion devices only receive real-time messages
- JSON over SQLite — state is small, no DB dependency needed
- Per-chat model selection — configurable in `prompts/chats.json` (default: opus)
- `--allowedTools WebSearch,WebFetch` — Claude can search the web when answering questions
- `--no-session-persistence` — each Claude call is independent
- `markOnlineOnConnect: false` — reduces ban risk on unofficial API
- Auto-reconnect on disconnect (except loggedOut)
- Prompt sent via stdin to avoid shell argument issues with long text
- Multi-chat support — responds to all groups and DMs, with per-chat prompt/model config
- Moltbook integration — no new deps (uses built-in `fetch`), gracefully disabled without API key
- Two-phase Moltbook comments — Claude picks posts from feed, then fetches existing comments before writing (avoids repetition)
- Moltbook prompt injection defense — feed content marked as untrusted, placed after instructions, truncated to 500 chars per post

## Running

```bash
npm install                    # install deps
npx tsc --noEmit               # type check
npx tsx src/index-whatsapp.ts   # WhatsApp transport
npx tsx src/index-discord.ts    # Discord transport
npx tsx src/index-slack.ts      # Slack transport
npx tsx src/index-signal.ts     # Signal transport (requires signal-cli daemon)
```

These commands are the dev loop on a checkout. Production runs from its own deployment host — see Deployment below. A bare `npx tsx src/index-whatsapp.ts` on macOS also needs `ENTOURAGE_FLAGS_DIR` set (the watcher's default is a Linux `/run/user/<uid>` path).

## Deployment

Production deployment specifics (hosts, accounts, runbooks, monitoring) are the
operator's private business and live outside this repo. Generic notes that any
deployment needs:

- The daemon must run persistently (systemd user service, launchd, …):
  Baileys/signal-cli companion devices receive nothing while disconnected.
- `Logged out` (Baileys `DisconnectReason.loggedOut`) means the linked device
  was invalidated — delete `data/whatsapp/auth/` and re-pair via QR; restarts
  alone will crash-loop.
- `fetchLatestBaileysVersion()` runs at startup because the bundled WhatsApp
  Web version goes stale quickly (405 errors otherwise).
- Decrypt errors after days offline ("Over N messages into the future") mean
  stale session state: delete `data/whatsapp/auth/`, restart, re-pair.

## Multi-Agent Development

Multiple Claude Code instances (and Codex) may work on this project concurrently. All agents should:

1. **Read this file first** before making changes
2. **Update this file** if the architecture changes
3. **Use git branches** for non-trivial features to avoid conflicts
4. **Don't commit sensitive data** — real JIDs, phone numbers, paths. See `.gitignore` and the `.example` files.

Codex: read this file as your project context. It serves the same purpose as `AGENTS.md`.

## Current Status

- Connect, read, respond — working end-to-end
- Per-chat config (model, prompt, verbosity) — working
- Polls — working (native WhatsApp polls via Baileys)
- DM and new-group access control — working (a DM, or a brand-new group's first message, needs to come from the admin or be approved via `/allow`; an already-onboarded group is never gated). On WhatsApp, a group is auto-approved when the **admin adds the bot to it** (Baileys `group-participants.update`) — but only if the daemon was connected at the moment of the add, since companion devices receive nothing offline. The gate remains the fallback for adds that happen while it's down. The auto-approve path only works if the daemon was connected at the moment of the add.
- JID comparison — use `isSameJid()`/`isAdminAddEvent()` from `src/jid.ts`, never Baileys' `areJidsSameUser()`: that helper ignores the server, so `areJidsSameUser("123@lid", "123@s.whatsapp.net")` is `true`. A LID is an opaque id in a different namespace from a phone number; using it for an auth check is a bypass.
- Admin commands (/status, /notes, /allow, /allowed, /help) — working
- Bot notes (persistent memory) — working
- History sync on reconnect — implemented but unreliable (WhatsApp limitation)
- Messages only marked processed after Claude succeeds (retry-safe)
- Systemd user service for persistence — configured
- Moltbook integration — registered, claimed, all operations working (upvote/comment/post/feed/profile)
- Moltbook comment verification — automated solver handles obfuscated word-number math challenges
- Moltbook personality — "Klein Bottle", sharp/witty; uses opus model
- Moltbook profile: https://www.moltbook.com/u/Kleinbot | Twitter: @KleinBot2026
- Moltbook cycle is **manual only** — no timer in the daemon. Run with: `env -u CLAUDECODE npx tsx scripts/moltbook-cycle.ts`. The `CLAUDECODE` env var must be unset or `claude --print` refuses to run.
- Moltbook cross-pollination — queuing works, but delivery (`sendCrossPollination`) is also not on a timer. After a manual cycle, items sit in the queue in `data/moltbook-state.json` until drained manually or via the bridge.
- Signal transport — working end-to-end, signal-cli daemon via Unix socket JSON-RPC (--receive-mode on-connection), systemd service, no new npm deps
- Morning briefing — daily at 05:30 UK to chats with `"briefing": true`
