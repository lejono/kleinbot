# Kleinbot — WhatsApp Chat Facilitation Bot

## Architecture

Persistent daemon that stays connected to WhatsApp via Baileys. Messages arrive in real-time from all chats (groups + DMs), accumulate in per-chat buffers, and are processed on a configurable interval by calling `claude --print` with per-chat prompt and model settings.

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

index.ts → setInterval(runMoltbookCycle) → every 4 hours (if MOLTBOOK_API_KEY set):
              fetch hot feed → filter unseen → claude --print with moltbook prompt
                                            ↓
              execute actions (upvote/comment/post) → queue cross-pollination items
```

Baileys as a linked/companion device does NOT receive offline messages — it only gets messages while the socket is connected. This is why a persistent daemon is required instead of cron-based connect/disconnect.

## File Structure

- `src/index.ts` — Daemon: connect, collect messages in real-time, per-chat queues, process on interval, respond. Also starts Moltbook heartbeat timer.
- `src/config.ts` — Loads `.env`, builds config object
- `src/whatsapp.ts` — Baileys persistent connection: `startConnection()` with auto-reconnect, `extractMessages()`, `sendTextMessage()`
- `src/ai.ts` — Spawns `claude --print` with per-chat model/prompt + WebSearch/WebFetch tools, parses JSON `{shouldRespond, response}`. Also exports `getChatConfig()` for prompt lookup. Adds Moltbook instructions to system prompt for moltbook-enabled chats.
- `src/state.ts` — JSON state: dedup by message ID, rolling message history
- `src/types.ts` — Shared TypeScript interfaces (`ChatMessage`, `ChatConfig`, `ChatsConfig`, etc.)
- `src/qrcode-terminal.d.ts` — Type declaration for qrcode-terminal
- `src/moltbook/client.ts` — HTTP wrapper for Moltbook API (feed, posts, comments, voting, search). Uses Node's built-in `fetch`.
- `src/moltbook/cycle.ts` — Autonomous participation: fetch feed → Claude picks actions → execute (two-phase commenting). Called on a timer from index.ts.
- `src/moltbook/state.ts` — Moltbook state: seen posts, rate limit tracking, cross-pollination queue
- `src/moltbook/types.ts` — Moltbook-specific interfaces
- `src/moltbook/whatsapp-bridge.ts` — Handles WhatsApp-triggered Moltbook commands; sends cross-pollination digests to moltbook-enabled chats
- `prompts/chats.json` — Per-chat config: maps JIDs to prompt files and model names
- `prompts/default.md` — Default bot personality and decision rules
- `prompts/moltbook.md` — System prompt for autonomous Moltbook participation (with prompt injection defense)
- `scripts/setup.sh` — npm install + directory setup
- `scripts/cron-run.sh` — Simple runner script (for systemd or manual use)
- `scripts/moltbook-register.ts` — One-time Moltbook registration (prints API key + claim URL)
- `data/notes/` — Bot's self-written notes per chat (persistent memory)
- `data/moltbook-state.json` — Seen posts, rate limits, cross-pollination queue (gitignored)
- `docs/security-audit-*.md` — Security audit reports

## Config (.env)

- `BOT_NAME` — Display name (default: "Kleinbot")
- `PROCESS_INTERVAL` — How often to process accumulated messages, in ms (default: 60000)
- `HISTORY_WINDOW` — Rolling message context size (default: 50)
- `LOG_LEVEL` — Pino log level for Baileys (default: "warn", use "debug" for troubleshooting)
- `MOLTBOOK_API_KEY` — Moltbook API key (get from `npx tsx scripts/moltbook-register.ts`). If unset, Moltbook features are disabled.
- `MOLTBOOK_HEARTBEAT_INTERVAL` — How often to browse Moltbook autonomously, in ms (default: 14400000 = 4 hours)

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
npx tsx src/index.ts            # run (shows QR on first run, then stays connected)
```

For production, use a systemd user service (see README.md for full setup).

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
- DM access control — working (admin approval required)
- Admin commands (/status, /notes, /allow, /allowed, /help) — working
- Bot notes (persistent memory) — working
- History sync on reconnect — implemented but unreliable (WhatsApp limitation)
- Messages only marked processed after Claude succeeds (retry-safe)
- Systemd user service for persistence — configured
- Moltbook integration — registered, claimed, feed browsing works
- Moltbook write operations (upvote/comment/post) — blocked by platform bug ([moltbook/api#19](https://github.com/moltbook/api/issues/19))
- Moltbook WhatsApp commands ("what's hot on Moltbook") — wired up, waiting on API fix
- Moltbook cross-pollination — queuing works, delivery to WhatsApp chats works
- Moltbook profile: https://www.moltbook.com/u/Kleinbot | Twitter: @KleinBot2026
