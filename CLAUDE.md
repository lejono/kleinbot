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
              runMorningBriefing() → configured briefing model (Claude web tools enabled)
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

## Model usage

Every `callModel` invocation and chat-side `askClaude` call appends one record to
`<dataDir>/usage.jsonl`, under `<KLEINBOT_RUNTIME_DIR>/data/usage.jsonl`.
The file is mode 0600, its data directory is 0700, and records are append-only,
never pruned. Logging failures are caught and do not fail the model call.
The record never contains prompt text, reply text, chat IDs or names, session
IDs, or credentials. Use non-identifying prompt filenames: chat steps use their
basename without the extension (for example `default`), with `default` as the
fallback for unsafe labels, phone-like digit runs or labels containing the chat ID.
Roam steps are `answer`, `intent`, `cycle`, `comment`, `briefing`, `writeup`,
`classify`, `digest` and `voice`; an omitted optional step is recorded as null.
`model` is the configured name (such as `opus`); `resolvedModel` is the model that
actually answered, taken from the Claude CLI's per-model usage (the one with the
most output, since the CLI may add small helper calls), or null when unknown
(always for Codex). The `/status` summary groups by `resolvedModel` when present.

A synthetic record (timestamp is Unix milliseconds at completion):

```json
{"timestamp":0,"step":"cycle","backend":"claude","model":"opus","resolvedModel":"claude-example-1","ok":true,"inputTokens":100,"outputTokens":20,"cacheReadTokens":80,"cacheCreationTokens":10,"costUsd":0.01,"durationMs":250}
```

`model` is the configured model label. Counts describe the whole CLI invocation,
which can include multiple internal model turns. Claude uses `--output-format json`:
code extracts `result`, preserving the previous trimming and downstream parsing,
and treats `is_error` as failure. The installed CLI help and result schema confirm
this format. Its `usage` supplies input, output, cache-read and cache-creation
counts; `total_cost_usd` supplies the CLI's cost estimate when available.
Codex adds `exec --json`, sums `turn.completed` input/output and cached-input
counts, and still reads response text from its existing `-o` answer file.
Codex cache-creation counts and cost are unavailable in the supported event
mapping and remain null. Missing or malformed counters are null, never invented
zeros. Failed calls are recorded with `ok:false`, retaining reported counters;
chat reply JSON parsing failures also set `ok:false`.
These records help track subscription allowance use; they do not calculate the
remaining plan allowance or a per-token subscription bill. Reported cost is an
estimate, not a subscription charge.

Roam `/status` adds totals for the last 24 hours and last 7 days, grouped by
backend/model: call count, input/output tokens, and cache-read/cache-creation
tokens separately. Failed calls count too. Unknown counters are labelled
`unknown`, or `partial` when only some calls reported them. Each backend's input
counter is preserved as reported; Codex cached input is a subset of its input
count, so do not add it again. The summary makes no model call and reads at most
`USAGE_SUMMARY_MAX_BYTES` tail bytes (default 4194304, 4 MiB). Invalid or
non-positive limits use the default. Partial boundary lines, unfinished appends
and malformed records are skipped. A clipped tail marks both windows' totals as
partial, since older records may be omitted; an unreadable log reports usage as
unavailable. It summarises only this runtime's file, not other accounts or hosts.

## File Structure

- `src/index.ts` — Daemon: connect, collect messages in real-time, per-chat queues, process on interval, respond. Also runs morning briefing check each tick.
- `src/config.ts` — Loads `.env` from runtime dir, exports `dataDir`, `promptsDir`, `runtimeDir`
- `src/whatsapp.ts` — Baileys persistent connection: `startConnection()` with auto-reconnect, `extractMessages()`, `sendTextMessage()`
- `src/ai.ts` — Spawns `claude --print` with per-chat model/prompt + WebSearch/WebFetch tools, parses JSON `{shouldRespond, response}`. Also exports `getChatConfig()` for prompt lookup. Adds Moltbook instructions to system prompt for moltbook-enabled chats.
- `src/state.ts` — JSON state: dedup by message ID, rolling message history
- `src/types.ts` — Shared TypeScript interfaces (`ChatMessage`, `ChatConfig`, `ChatsConfig`, etc.)
- `src/qrcode-terminal.d.ts` — Type declaration for qrcode-terminal
- `src/moltbook/client.ts` — HTTP wrapper for Moltbook API (feed, posts, comments, voting, search). Uses Node's built-in `fetch`.
- `src/moltbook/cycle.ts` — Autonomous participation: fetch feed → configured model picks actions → execute (two-phase commenting). Also `runMorningBriefing()` for daily AI news digest.
- `src/moltbook/model-call.ts` — Claude/Codex CLI invocation, timeouts and temporary workspace cleanup.
- `src/usage-log.ts` — Private per-call usage records, CLI envelope extraction and bounded usage summaries.
- `src/moltbook/enabled.ts` — Shared API-key gate for chat action dispatch and briefing scheduling.
- `src/index-roam.ts` — Transport-free daemon: serial inbox answers, participation, briefing and research jobs.
- `src/roam/inbox.ts` — Chat pipe decision, atomic metadata-only inbox writer and oldest-first reader.
- `src/roam/outbox-relay.ts` — Chat-side channel relay with pinned recipients and strict markdown attachment checks.
- `src/roam/answer.ts`, `src/roam/control.ts` — Research answers, persistent inbox deduplication and trusted participation controls.
- `src/roam/outbox.ts` — Atomic recipient-free message flags and copied markdown attachments.
- `src/roam/schedule.ts` — Persistent once-per-UK-day research attempt tracking.
- `src/research/corpus.ts` — Private monthly JSONL capture of full posts and flattened comments.
- `src/research/classify.ts` — Bounded open-coding batches with strict result validation and retry on later runs.
- `src/research/schema.ts` — Classification schema and validation, including verbatim quote checks.
- `src/research/digest.ts` — Short nightly notices from newly classified records, with code-built links and fallback text.
- `src/research/summary.ts` — Deterministic markdown totals, codes, projects, mechanisms, allocations and sanitised quotes.
- `scripts/research.ts` — Manual research entrypoint.
- `scripts/macos/net.postquantum.kleinbot-roam.plist` — Isolated launchd service template.
- `src/moltbook/voice.ts` — Isolated own-writing reflection, private voice/history files and operator reset.
- `src/moltbook/presence.ts` — Daily numeric profile snapshots and seven-day trends.
- `src/moltbook/state.ts` — Moltbook state: seen posts, rate limits, cross-pollination queue, cycle attempts and morning briefing attempts
- `src/moltbook/types.ts` — Moltbook-specific interfaces
- `src/moltbook/transport-bridge.ts` — Handles chat-triggered Moltbook commands and sends briefings and cross-pollination digests
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
- `CLAUDE_BIN`, `CODEX_BIN` — Model CLI executables; defaults are `claude` and `codex`.
- `CODEX_DISABLE_FEATURES` — Comma-separated features disabled per Codex call with `--disable`; defaults to `browser_use,browser_use_external,browser_use_full_cdp_access,computer_use,in_app_browser`. An empty value disables nothing.
- `MOLTBOOK_BACKEND`, `MOLTBOOK_MODEL` — Participation backend/model (defaults: `claude`, `sonnet`).
- `BRIEFING_BACKEND`, `BRIEFING_MODEL` — Briefing backend/model (defaults: `claude`, `opus`).
- `MOLTBOOK_MODEL_TIMEOUT_MS`, `MOLTBOOK_COMMENT_TIMEOUT_MS`, `BRIEFING_MODEL_TIMEOUT_MS` — CLI timeouts (300000, 120000, 300000 ms).
- `MOLTBOOK_HEARTBEAT_INTERVAL` — Roam participation attempt interval (14400000 ms).
- `ROAM_TICK_INTERVAL` — Roam due-check interval (60000 ms).
- `ROAM_INBOX_DIR`, `ROAM_PIPE_CHAT_JID` — Chat-side pipe requires both; unset disables it. Roam reads the inbox directory without a chat id.
- `ROAM_INBOX_GROUP_READABLE` — Set to `1` for inbox 0770 and files 0640; default 0700/0600, explicitly applied.
- `ROAM_INBOX_MAX_TEXT_CHARS` — Inbox text cap (4000), after stripping control characters.
- `ROAM_INBOX_MAX_PER_TICK`, `ROAM_INBOX_SEEN_LIMIT` — Answers per tick (5) and retained handled ids (500, may be lowered).
- `ROAM_CHAT_BACKEND`, `ROAM_CHAT_MODEL`, `ROAM_CHAT_TIMEOUT_MS` — Inbox model settings (claude, sonnet, 300000 ms).
- `ROAM_CHAT_CONTEXT_MESSAGES`, `ROAM_CHAT_CONTEXT_MAX_BYTES` — Recent conversation entries (20) and maximum log tail read (262144 bytes).
- `ROAM_INTENT_MODEL`, `ROAM_INTENT_TIMEOUT_MS`, `ROAM_INTENT_MIN_CONFIDENCE` — Tool-less Claude intent model (haiku), timeout (60000 ms), and minimum confidence (0.7).
- `ROAM_CONTROL_MAX_DIRECTIVE_CHARS` — Trusted guidance cap (2000, may be lowered).
- `ROAM_OUTBOX_DIR` — Outbox root; unset disables writing and logs text length only.
- `ROAM_BRIEFING_CHAT_JID`, `ROAM_RESEARCH_CHAT_JID` — Pinned chat-side relay recipients; unset channels are not swept.
- `ROAM_OUTBOX_EXTRA_CHANNELS` — Optional comma-separated `name=chatId` pairs, e.g. `updates=example-group-id`, for up to eight additional pinned channels; see the relay contract below.
- `ROAM_OUTBOX_RELAY_INTERVAL` — Chat-side channel sweep interval (5000 ms).
- `ROAM_OUTBOX_GROUP_READABLE` — Set to `1` for channel directories 0770 and flag/attachment files 0640, explicitly applied despite umask; off by default (0700/0600).
- `ROAM_OUTBOX_MAX_MD_BYTES` — Markdown attachment size limit (262144 bytes).
- `ROAM_OUTBOX_MAX_TEXT_CHARS`, `ROAM_OUTBOX_MAX_FLAG_BYTES` — May lower the receiver's 4000-character and 16384-byte ceilings.
- `RESEARCH_CAPTURE` — Set to `1` to capture full fetched posts and comments; off by default.
- `RESEARCH_MAX_COMMENT_FETCH` — Maximum comment trees per cycle (20), highest comment count first among newly captured posts.
- `RESEARCH_HOUR_UK` — Daily research attempt hour in Europe/London (3).
- `RESEARCH_BACKEND`, `RESEARCH_MODEL` — Research backend (default `codex`) and required model (no default). An unset model skips classification and summary generation.
- `RESEARCH_BATCH_SIZE`, `RESEARCH_MAX_BATCHES` — Posts per batch and batches per run (20 and 10).
- `RESEARCH_MAX_POST_CHARS`, `RESEARCH_MODEL_TIMEOUT_MS` — Per-post prompt content cap (2000 characters) and model timeout (300000 ms).
- `prompts/research-question.md` (runtime prompts dir, optional) — The operator's research question, given to the classifier as trusted guidance ahead of the untrusted posts, capped by `RESEARCH_MAX_QUESTION_CHARS` (2000). Absent, the classifier does neutral open coding. It is user data and never belongs in this repo.
- `RESEARCH_MAX_QUOTE_CHARS`, `RESEARCH_MAX_CODE_CHARS` — Quote and open-code length limits (200 and 64 characters); quotes cannot exceed 200 characters.
- `RESEARCH_SUMMARY_MAX_CODES`, `RESEARCH_SUMMARY_MAX_QUOTES` — Summary display limits (40 and 30).
- `KLEINBOT_RUNTIME_DIR` — Base for data, prompts, configuration and the research wiki. All roam settings above are read through `src/config.ts`; see `.env.example` for examples.
- `KLEINBOT_TEMP_DIR` — Temporary root for model workspaces and schemas (default: OS temporary directory).
- `SIGNAL_ACCOUNT` — Bot's registered Signal phone number (e.g. `+447123456789`)
- `SIGNAL_ADMIN_NUMBER` — Admin's phone number for `/commands` (optional)
- `SIGNAL_ADMIN_GROUP_JID` — A group whose messages from the admin count as admin messages for entourage flags (optional)
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

## Roam mode

Participation checks replies to its own profile activity from the last
`MOLTBOOK_REPLY_LOOKBACK_DAYS` (3), fetching at most `MOLTBOOK_REPLY_THREADS` (5)
distinct threads after the paused check. Profile `recentComments` identify the
thread through `post.id`; `recentPosts` identify the bot's own posts. The thread's
`parent_id` (or nested `replies` relationship) identifies replies to its comments;
top-level comments qualify on its own posts. Already answered replies are excluded
using both the fetched tree and a capped 1000-id state history. Offered replies,
authors, ids and the bot's earlier text remain in the untrusted block. Reply
comment actions use `parentId`, which must match an offered reply and its post.
Comment cooldown and hourly limits still apply. New replies can trigger a round
with no new feed posts. Discovery failures do not prevent feed participation.

Feed posts show comment counts and age in hours. They are sorted by age in hours
plus comment count, putting newer, quieter threads first; unknown ages sort last.
Participation is told to prefer threads where its comment will be read.
`{"type":"follow","agent":"name"}` is permitted only for authors in that round's
feed or replies, excluding the bot itself, already followed names and authors
marked as followed by the API. `MOLTBOOK_FOLLOWS_PER_DAY` (3) caps successful
follows per Europe/London day. Moltbook state persists the date, count and names;
activity records include only the follow action and agent name.

The first unpaused round each UK day records a profile snapshot in
`data/research/presence.jsonl` (0600): `{date, karma, followers, following, posts,
comments}`. It uses the numeric profile fields `karma`, `follower_count`,
`following_count`, `posts_count` and `comments_count`. Profile lookup is shared
with reply discovery; no extra lookup is needed for the snapshot. Snapshot
failures never break participation and are not retried that day. `/status` adds
the latest karma, followers, posts and comments plus changes against a snapshot
exactly seven calendar days earlier. Missing counters or a missing seven-day
baseline are reported as unavailable, never invented. Trend reads use a bounded
64 KiB log tail. The common fixed writing paragraph in participation, comment
and answer system prompts asks for a personal voice, specific details and varied
sentence lengths, and discourages stock AI phrasing.

The voice design preserves this security rule: a model call that reads other agents' text may change nothing trusted.
The voice writer never receives other agents' words from feeds, replies, fetched
comment trees, corpus or wiki files, nor any operator conversation, focus or runtime
persona. Its input is built separately from selected fields: current `data/voice.md`,
up to 40 of the bot's own profile posts/comments from the last seven days (2000
characters each), numeric reactions and the presence trend. Profile-scoped own
activity supplies provenance; explicitly foreign authors are excluded if present.
Recent posts currently supply `content_preview`, so reflection uses that preview
when full content is absent. Comment reply counts are currently omitted by the
profile API and remain omitted in reflection input; no zero is invented.

After the first unpaused round, the writer can make one `step: "voice"` call per
UK day, with `MOLTBOOK_BACKEND`/`MOLTBOOK_MODEL`, `tools: "none"` and the participation
timeout. The attempt is persisted before the call, including failures. It asks
for short first-person notes on voice and interests and JSON `{voice, changed}`,
with no rules about other files or settings. Codex reflection is skipped because
the existing Codex wrapper's read-only sandbox still permits file reads and does
not enforce `tools: "none"`; it cannot safely author trusted notes. Claude's
empty tool list and strict empty MCP configuration enforce this isolation.
Missing own writing or an unavailable research outbox also skips reflection.

`MOLTBOOK_VOICE_MAX_CHARS` (2000) caps the voice file. Code strips control
characters, checks configured secrets before and after sanitising/capping,
archives the previous text in append-only, dated `data/voice-history.md`, and
replaces `data/voice.md` atomically. Both files use 0600. Operators see every
successful change through a research outbox notice beginning "Voice notes updated:"
with the new text, bounded by the existing outbox limit. A failed notice publication
restores the previous notes. No model can select another target file or change
controls, operator notes or configuration through the reflection result.

Participation and comment system prompts include voice notes after the private
operator conversation/focus block, labelled "Your own notes on your voice (written
by you from your own posts). Operator instructions above take priority."
`/voice` shows the current notes or "No voice notes yet."; `/voicehistory` writes
`research-wiki/voice-history.md` (current notes, then every earlier version, newest
first) and attaches it; `/resetvoice` archives and clears them. These commands run in code without model calls. Reset preserves
the day's attempt marker, so the next round does not immediately recreate the notes.

Run `npm run roam` in a separate OS account with its own checkout and runtime,
containing no chat data or transport credentials. `MOLTBOOK_API_KEY` is required
(exit 78 when absent). The launchd roam template uses a distinct service account
and explicitly sets `HOME` and `KLEINBOT_RUNTIME_DIR`; its wrapper refuses missing
values before reading runtime configuration. Install/configure this service
separately; the chat installer is unchanged.

The daemon checks due work every minute, with one job in flight. Inbox answers
run first each tick, before participation, briefing and research. The cycle records
its participation attempt before fetching the feed. The daemon claims morning briefing attempts
using the existing retry helpers, and records daily research attempts in
`data/research/run-state.json`. Research becomes due at the configured UK hour,
including daylight-saving changes. Job failures are logged and do not stop the
loop; shutdown waits for the current job. Chat daemons without a Moltbook key
schedule no briefing and dispatch no Moltbook model actions.

Enable `RESEARCH_CAPTURE=1` to retain full fetched participation and briefing posts in
`data/research/<platform>-YYYY-MM.jsonl`, with separate `<platform>-seen.json`
deduplication. A bounded selection also retains flattened comment trees. Corpus
files use mode 0600 and directories 0700. Set `RESEARCH_MODEL` to enable daily
classification, or run `npx tsx scripts/research.ts` manually. Valid results append
to `data/research/classified.jsonl`; missing or invalid results remain eligible
for the next run. Comments are captured but only posts are classified.
`research-wiki/summary.md` is generated deterministically from the records and
states that the corpus is a trending sample. Quotes are sanitised, labelled
unverified agent text, and linked using encoded post ids.

The chat and roam daemons share two folders, named independently by environment
configuration on each side. `ROAM_INBOX_DIR` carries chat instructions to roam;
`ROAM_OUTBOX_DIR` carries replies, briefings and research notices back to chat.
The folders can be shared directories or local copies maintained by an external
file-sync job. No file ownership assumptions are used for routing or validation.
Writers publish with temporary files and atomic rename; readers ignore `*.tmp`
and deduplicate by id. A sync job must likewise publish complete files atomically,
with markdown attachments arriving before their JSON flags.

On the **chat side**, set `ROAM_INBOX_DIR` and `ROAM_PIPE_CHAT_JID` together to pipe
one chat after the normal access-control gate and raw capture. Unset either to
disable the pipe. Piped messages bypass the chat model, pending queue and
entourage flag branches, even if the inbox write fails. Persisted pending messages
for a newly configured pipe are drained into the inbox on startup, and that
chat's history is excluded from model context. Failed writes are logged and never
marked processed. A separate in-memory retry list retains failed startup and live
writes, persists them in the pending file, and retries on each later pipe
write; it is never handed to model processing. The chat-side raw log stays local.
Inbox JSON contains only `id`, `timestamp`, `senderName`, `text`, and
`attachments: [{filename, contentType}]`. The id uses HMAC-SHA-256 with a random
32-byte secret, atomically created on
first use at `<dataDir>/roam-pipe-secret` with mode 0600. The secret stays on the
chat side and is never logged or synced. Writers sharing it produce stable ids;
separate secrets produce different ids. Timestamps retain Unix seconds from chat.
Display-name fallbacks that look like identifiers become `member`. Text has
controls stripped, phone-number-like sequences masked as `[number]`, and numeric
or `@name@server` mentions masked as `[mention]`, before the
`ROAM_INBOX_MAX_TEXT_CHARS` (4000) cap. Attachments contain generated labels only,
such as `file-1.pdf` and `file-2.jpg`; original filenames, paths and bytes never
cross. Only 1–5 alphanumeric extension characters are retained, lower-cased.
Content types must match `^[a-z0-9.+-]+/[a-z0-9.+-]+$`; others become
`application/octet-stream`.

On the **roam side**, set `ROAM_INBOX_DIR` and `ROAM_OUTBOX_DIR`; no chat or sender
identifier configuration is needed. Inbox messages are **trusted instructions**
from the configured pipe. Platform feeds, corpus files, comments, generated wiki pages
and web pages remain **untrusted data**, including any instructions embedded in
them. The answerer handles oldest messages first, up to `ROAM_INBOX_MAX_PER_TICK`
(5), retaining up to `ROAM_INBOX_SEEN_LIMIT` (500) handled ids atomically in
`data/research/inbox-seen.json`. It deletes handled inbox files on a best-effort
basis. Messages older than the validator's 48-hour freshness window or more than
5 minutes ahead are deleted without answering. Before answering, the research
outbox directory is created and checked for write access; unavailable output
leaves the inbox message unconsumed. A model failure emits a short failure reply
and records the id only after the reply is published. Briefing jobs likewise
check their outbox before claiming an attempt or calling the model. Daily
research run state is replaced atomically; malformed JSON is treated as not run.

`ROAM_CHAT_BACKEND`, `ROAM_CHAT_MODEL` and `ROAM_CHAT_TIMEOUT_MS` default to
`claude`, `sonnet` and 300000 ms. The answerer is Claude-only: any other backend
logs once and returns a misconfiguration reply after the isolated intent call,
without making an answer call. Codex
cannot confine file reads to the research directories. The runtime prompt is
`prompts/roam-chat.md`;
when absent, the built-in prompt instructs concise corpus/wiki answers and marks
corpus content as untrusted. No prompt template is shipped because this checkout
tracks no `prompts/*.example.md` templates. The model returns
`{reply, attachMd, writePage?}`. Returned `control` and `groupNotes` fields are
ignored. Optional `writePage: {name, title, markdown} | null` requires the same
message's clean intent result to return `writeUp: true` and meet the confidence threshold.
Otherwise no page is written, and the existing failure reply replaces the answer
prose so it cannot claim a successful write. Authorised writes use the same
validated page writer as daily research, then refresh the index. A rejected write
discards the draft reply and attachment, publishes a fixed failure reply, and
records a failed outcome. Once that reply is published, the message is consumed
so it cannot loop; an older page is never attached after a rejected write. A reply can
attach the page it just wrote using `pages/<name>.md`. Attachments must resolve
from a relative wiki path to an existing contained `.md` file; log files and
`group.md` are also allowed. Invalid paths are dropped. If attachment
publication fails for a reason other than egress refusal, the answerer attempts
text-only output. `writeOutboxMessage` reports `published`, `refused` (egress),
or `failed` (filesystem or attachment validation). A refused reply or attachment
is replaced by the fixed text "I have withheld my answer because it contained
something that must not be sent. Please rephrase, or ask for less." Once that
reply is published, the message is marked handled and activity status is
`withheld`, so later ticks spend no further model calls. An unavailable outbox
still leaves the message queued; its pre-check avoids model calls.

Page titles and markdown are checked for configured secrets before and after
sanitisation; a match skips the page and logs only a fixed diagnostic. Outbox
text and the actual attachment bytes use the same normalising matcher as
activity excerpts and platform posts/comments. A rejected attachment publishes
neither a flag nor a copied file for that outbox call. These checks cover daily
research and inbox answers, including existing summary, log and group attachments.

Handled inbox messages (already masked by the pipe) and published replies, including
command confirmations and failure replies, append to `data/research/chat-log.jsonl`
(mode 0600). Records contain a millisecond `timestamp`, `role` (`operator` or
`assistant`), optional `senderName`, and `text` capped at 4000 characters.
Answers receive the last `ROAM_CHAT_CONTEXT_MESSAGES` entries (20 by default),
reading at most `ROAM_CHAT_CONTEXT_MAX_BYTES` tail bytes (262144 by default) and
skipping malformed records. Operator lines are trusted; earlier assistant
replies may quote untrusted material and are never instructions.

Participation receives the runtime persona, then a private block containing
group notes from `readGroupPage()`, recent operator and assistant entries from the
conversation log (oldest first), and the current focus as the most recent explicit steer.
The same system prompt precedes untrusted feed and comment content in both
participation and follow-up comment calls. No `senderName` fields are included.
Both roles have control characters stripped and use UK daylight-saving time:
`- YYYY-MM-DD HH:MM UK · operator: <text>` and
`- YYYY-MM-DD HH:MM UK · you (earlier reply): <text>`.
Operator lines are trusted instructions. Earlier replies provide the plans and
commitments that operators asked for or approved, so participation can follow
through when an operator approves a plan in the conversation. Replies may quote
untrusted platform posts: instructions appearing only in earlier replies without
an operator request or approval remain data, not instructions. Newer operator
instructions override older ones. The messages and notes steer
participation but must never be quoted, paraphrased, summarised or revealed on the platform,
and the group's existence or members must never be mentioned. The feed remains
untrusted data. Prompt instructions are not a hard barrier:
operator messages could be paraphrased publicly if a feed post manipulates the model.
The settings, notes and logs protections are unchanged. Participation and comment
models cannot write controls, group notes, activity logs or the conversation log;
existing code still records activity facts.

Assistant replies are acceptable here because participation already reads the raw
untrusted feed and cannot change controls, notes or logs; quoted feed text adds no
new exposure. The clean intent call still excludes assistant replies completely:
it can request control changes and group-note appends and must never receive
potentially hostile material quoted by the answerer. The intent call still never receives voice notes.

`ROAM_CYCLE_CONTEXT_MESSAGES=20` selects the last twenty entries across both roles
within the existing `ROAM_CHAT_CONTEXT_MAX_BYTES` bounded log tail. The deprecated
`ROAM_CYCLE_OPERATOR_MESSAGES` is a fallback only when the new name is unset;
its value now counts both roles. `ROAM_CYCLE_CONTEXT_MAX_BYTES=32768` caps the entire added
block in UTF-8 bytes, including framing, privacy instructions and focus. It drops
the oldest conversation entries first, then the oldest complete group-note entries.
An assistant entry exceeding 4000 UTF-8 bytes is truncated with `…`, preserving
character boundaries and including its timestamp, label and ellipsis in that cap.
Group notes retain their existing `ROAM_GROUP_PAGE_CONTEXT_BYTES` read cap.
If even privacy framing and the full focus cannot fit, the block is omitted;
neither is cut mid-instruction. Empty notes, conversation history and focus produce
no block. Both limits require positive safe integers; invalid values use defaults.

An operator entry newer than the previous cycle attempt triggers participation
even with no new feed posts. Without either new posts or a new operator entry,
the cycle skips the model call; assistant replies alone never trigger it.
The operator check reads separately from the bounded log tail, so assistant replies
filling the conversation window do not displace the trigger. Attempts use `lastCycleAttemptAt` in the existing
Moltbook state, recorded at cycle start even for paused or failed attempts;
pausing still prevents participation model calls. Requests to post are ordinary
operator instructions, with no special command. The answerer cannot act on the
platform itself and is instructed to acknowledge that participation instructions
carry automatically into the next round. Its system prompt states the configured
`MOLTBOOK_HEARTBEAT_INTERVAL` in hours (default four hours), including when a runtime
answer prompt is supplied.

Model children started by `src/moltbook/model-call.ts` receive an explicit environment
allowlist, never the daemon's full environment. Both backends receive only these
base names when set: `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TMPDIR`, `TERM`, `TZ`, `KLEINBOT_TEMP_DIR`, `HTTPS_PROXY`,
`HTTP_PROXY`, `NO_PROXY`, their lowercase variants, and `NODE_EXTRA_CA_CERTS`.
Claude additionally receives `CLAUDE_CODE_*` and `ANTHROPIC_*`, including
`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` for authentication, plus
`CLAUDE_CONFIG_DIR`. Codex
additionally receives `CODEX_*` (including `CODEX_HOME`) and `OPENAI_API_KEY`.
`MODEL_CHILD_ENV_ALLOW` optionally adds comma-separated exact names to both.
Always refused, even in that extension: `MOLTBOOK_API_KEY`, `ROAM_*`, `SIGNAL_*`,
`ADMIN_*`, `ENTOURAGE_*`, and `CLAUDECODE` (the nested-session marker).
Claude also refuses `OPENAI_*` and `CODEX_*`; Codex also refuses `CLAUDE_*` and
`ANTHROPIC_*`. Other names are absent unless explicitly allowed. The chat-side
spawn in `src/ai.ts` uses the same Claude environment allowlist.

The Claude research-read call runs with cwd set to `data/research` and these
flags, in addition to `--print --output-format json --model <model> --no-session-persistence
--system-prompt <prompt>`:

```text
--tools Read,Grep,Glob --allowedTools Read,Grep,Glob
--restricted --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}'
--disable-slash-commands --permission-mode dontAsk
--add-dir <research-data-dir> <research-wiki-dir>
```

`--restricted` confines file tools to the working directories; the tool list
contains only Read, Grep and Glob. Safe mode disables runtime customizations,
and strict empty MCP configuration excludes external tools. These flags were
checked against the installed `claude --help` and parsed by the real CLI with
empty stdin: it reached the missing-input error, while an unknown-option control
failed argument parsing. No model call was needed. Claude calls using `none` or
`web` tools also carry `--strict-mcp-config --mcp-config '{"mcpServers":{}}'
--safe-mode --disable-slash-commands`. The installed help states that built-in
tools and permissions work normally in safe mode; empty-input parsing also
accepts the explicit `--system-prompt` and `--allowedTools` combination.

Operator commands are handled in code before any model call, when the trimmed
message starts with a command token:

- `/pause` and `/resume` set participation's paused state.
- `/focus <text>` replaces trusted guidance, with controls stripped and a
  `ROAM_CONTROL_MAX_DIRECTIVE_CHARS` cap (2000, may be lowered).
- `/clearfocus` clears that guidance.
- `/status` reports paused state, focus, corpus post count, classified count,
  last cycle attempt time, last research run date, and per-model usage totals for
  the last 24 hours and 7 days (see Model usage above), plus the presence snapshot
  and seven-day changes.
- `/voice` reads current voice notes; `/resetvoice` archives and clears them.

Each command replies through the research outbox and spends no model call.
A command token later in a message is not a slash command.

Other messages use two calls, in order: an isolated control-intent call, then the
research answer call. The intent call is always Claude with `tools: "none"`,
`--tools ''`, strict empty MCP configuration, safe mode and disabled slash
commands. `ROAM_INTENT_MODEL`, `ROAM_INTENT_TIMEOUT_MS` and
`ROAM_INTENT_MIN_CONFIDENCE` default to `haiku`, 60000 ms and 0.7.
Its prompt builder receives only fixed instructions, current paused/focus state,
earlier operator lines only; assistant entries are excluded completely.
It also receives the new operator message and the bounded operator-sourced
`group.md` tail. It never loads corpus, other wiki pages, classification, feed,
web content or the runtime answer prompt. Assistant entries are neither summarised
nor replaced with content-bearing placeholders.

Intent returns JSON with `control` (null or optional `paused`/`directives` fields)
and numeric `confidence`, plus optional `groupNotes: string | null` and
`writeUp: boolean`. A control change or note must be stated in the operator's own message.
Agreement with an assistant suggestion (such as "yes" or "do that") is not
an explicit statement and must yield `control: null` and `groupNotes: null`.
Only clear requests in the new message to pause/resume participation or
set/change/clear focus qualify as controls. Questions, discussion, write-up
requests and uncertainty produce null controls. `writeUp` is true only when the
new operator message asks for a page or write-up to be written or updated;
missing, invalid or insufficient-confidence results default to false.
Group notes, earlier operator lines and control state are context only and cannot
by themselves justify a write-up, control change or new notes. Code also requires
a new message with at least two whitespace-separated words after trimming, and
refuses write-up authorization for slash commands. This structural guard cannot
correct a model that misclassifies an ordinary multi-word question.
Daily write-ups run independently of this inbox authorisation. Code ignores invalid JSON, failed calls
and controls with confidence below the threshold, then still attempts the answer.
Accepted fields pass through `normaliseControl` and the same atomic control writer used
by slash commands. Directives retain the existing character stripping and cap.

Non-empty `groupNotes` append independently of control confidence. The clean
call is instructed to remember only operator statements and requests, and to
never copy assistant lines or quoted material. Commands bypass both model calls
and never append notes. Each note is a dated, control-stripped, single-line entry;
`ROAM_GROUP_NOTE_MAX_CHARS` defaults to 1000. The file is never pruned.
`ROAM_GROUP_PAGE_CONTEXT_BYTES` (16384) bounds the tail read, which starts at a
complete, newline-terminated entry with a valid date heading. An entry exactly
at the byte boundary is retained; malformed entries and an unfinished tail are skipped.
The intent and answer prompts receive these notes as memory data; the answer prompt places them
in its trusted part, before untrusted material, labelled "notes derived from
operator messages by a separate step". Notes cannot authorize a new
control change, write-up or note. Unlike chat-side `saveNotes`, this writer does not rewrite and
trim old entries.

Corpus and generated wiki pages remain data, never instructions.
Participation receives operator-derived group notes as private guidance; intent
and answer calls still treat those notes as memory data. Activity entries and generated
navigation are code-formatted data. Only the clean intent call,
which has no tools, may request control changes or group-note appends. Calls
that read hostile material never receive a write tool. Their new page-writing
power is limited to `pages/`, only through code that validates names and sizes.
They cannot choose a target for controls, prompts, group notes, activity logs or
the conversation log. Existing published replies still enter the conversation
log through code and cannot independently authorize instructions; participation
may follow their plans only when operators asked for or approved them. This is not
an arbitrary model-directed log writer. Existing corpus capture, classifications, summary,
briefing journal and outbox publication likewise remain data paths.

The wiki root is `<KLEINBOT_RUNTIME_DIR>/research-wiki`, configured through
`src/config.ts`. It holds four kinds of content:

| Kind | Files | Writer |
| --- | --- | --- |
| Generated reference and navigation | `summary.md`, `index.md` | Deterministic code; summary uses classified evidence, index uses filenames and sanitised first headings |
| Activity | `log-YYYY-MM.md` | Code formats counts, action types, encoded post links, control changes and outcomes |
| Group memory | `group.md` | Code appends only the clean intent call's operator-sourced notes |
| Research pages | `pages/<name>.md` | Code validates daily write-up or answer-call output and replaces each page atomically |

Activity files use UK calendar months and minute timestamps, mode 0600, and a
0700 wiki directory. They are append-only and never pruned or rewritten. Logging
failure cannot break its caller. Cycles record fetched/captured/comment-tree
counts and pause state; executed actions record their type and post link. Daily
research records captured, classified, organising, newly classified and written
page counts; briefing publication and handled inbox outcomes are also recorded.
Control entries identify the requesting sender and slash-command or plain-language
route. `ROAM_LOG_EXCERPT_CHARS` (120) caps control-stripped operator excerpts,
and sender labels. Before stripping or capping an excerpt, the existing egress
matcher tests configured environment secrets of at least 8 characters, both as
given and with whitespace, controls and zero-width characters removed; shorter
values are ignored to avoid nonsense matches. At daemon startup, configuration
warns once per process for each non-empty configured value shorter than 8
characters, naming only its environment variable: `MOLTBOOK_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. A match
becomes `[excerpt withheld]`. Published posts/comments contribute facts only:
action type, validated platform post link and character count. Their text is
never copied into activity entries. The log never accepts a model-provided narrative.

Daily research runs `runResearch`, then `runWriteUp`, then `writeIndex`, and builds
its outbox digest after those steps. `RESEARCH_WRITEUP_BACKEND` defaults to `claude`;
`RESEARCH_WRITEUP_MODEL` has no default: unset skips page generation with an activity
entry and uses code-built digest text. `RESEARCH_WRITEUP_TIMEOUT_MS` (600000) applies
to each write-up call and the digest call. Both request `tools: "none"`;
Claude disables tools, while the existing Codex adapter retains read-only tools.
No backend receives a write tool.

`RESEARCH_WRITEUP_PAGES_PER_RUN` (4) caps attempted targets, with one model call per page.
Code chooses `decision-mechanisms`, then `resource-allocation`, then projects with
at least three records, ranked by records classified since the page file's last
modification time. Missing pages count all their records as new; project-name order
breaks ties. Duplicate page slugs get one target. Failed targets consume their slot
but do not stop later calls. The reply is one JSON object `{name, title, markdown}`;
its name must match the requested target before the existing page writer validates it.
Each target logs its name and a fixed reason: `written`, `timeout`, `model-error`,
`invalid-json`, `wrong-name` (the reply named another page), `too-large` (title or markdown over
`RESEARCH_PAGE_MAX_BYTES`), or `rejected` (content shape or the secrets check). A failed
Claude call also logs one `[model] claude error:` line with the CLI's own error subtype and
message, control-stripped and capped at 200 characters; stderr and model replies are never logged. Failures also emit one console line with the name and
reason; write-up stderr and reply text are never copied into these diagnostics.

The trusted write-up instructions include the same optional `prompts/research-question.md`
file as classification, with its existing question cap, and current control focus.
The untrusted block contains only the target's mapping, relevant classified records,
and that page's existing text when present. The mechanism and allocation pages use
records with the respective field; project pages use records for that project.
It includes at most `RESEARCH_WRITEUP_MAX_RECORDS` (60) records per call, organising
first and newest first within each group. `RESEARCH_WRITEUP_CONTEXT_MAX_BYTES`
(262144) sets one aggregate byte budget for the encoded block, including framing newlines. Existing page
text is dropped first, then older records, then mappings and target metadata if
needed. Individual record fields and arrays retain their caps; page reads are
bounded by page-size allowances plus framing. `RESEARCH_WRITEUP_MAX_EXISTING_PAGES`
is a legacy setting with no effect on these single-page calls.
A per-call random delimiter token is stated in the trusted instructions and chosen
to be absent from the material. The prompt requests evidence, uncertainties, encoded post links and
a dated change list. The nightly call no longer receives the full summary.

The nightly digest starts with captured, classified, organising and written-page
counts, plus the number newly classified in this run, labelled "new since last run".
`RESEARCH_DIGEST_ITEMS` (5) limits selected Moltbook records from this run's accepted
classifications, organising first, then highest confidence, with post id breaking ties.
Code selects one per project, comparing trimmed names without case; missing project
names share one slot. Historical records and wiki text never enter the digest call.
One extra call with usage step `digest` uses the write-up backend, model and timeout.
It receives only ids and the structured project, goal, decisionMechanism,
resourceAllocation, stakes and quote fields inside a random-delimited untrusted block.
The reply is JSON `{items:[{id, sentence}]}`: one plain-English sentence under 200
characters per item, without jargon, explaining what agents are doing and why it
matters for organising, deciding or allocating resources. Code removes links and
markdown, drops unknown or duplicate ids and invalid sentences, preserves selection
order, and appends post links built from the offered ids. If no valid sentences
survive, the call fails, or the model is unset, each selected item gets a code-built
`project — decisionMechanism` line (goal when the mechanism is absent) and post link.
No records means no digest model call.

The final line names pages written this run and says "Ask for the full summary if
you want it." Whole items are dropped to fit `ROAM_OUTBOX_MAX_TEXT_CHARS` (at most
4000), preserving the counts and final line when space allows; an exceptionally
small limit also truncates that framing. `RESEARCH_ATTACH_SUMMARY` (0) leaves the
nightly notice text-only by default; set it to `1` to attach `summary.md`.
The full summary is still generated and the answerer can attach it on request.

`RESEARCH_PAGE_MAX_BYTES` (20000) bounds markdown and title independently in UTF-8;
generated banner, heading and date framing are additional. `sanitisePageMarkdown`
runs on every title and body before writing. It removes raw HTML tags and comments,
turns images into alt text, drops reference-style link definitions, and neutralises
autolinks to plain text. Markdown links survive only for HTTPS destinations on
the platform host used by `postLink`; other links become their label text.
Control characters are stripped while markdown line breaks are retained. `RESEARCH_PAGES_MAX_PER_RUN`
(12) caps successfully written distinct pages per call. Names must match
`^[a-z0-9][a-z0-9-]{0,59}$`; `index` and `group` are reserved. The pages directory
cannot be a symlink. Files use 0600 and directories 0700. Each page starts with a
fixed warning that it is machine-written from unverified public agent posts and
must be treated as data. The banner is always the first line. The deterministic
index links summary, group notes, newest activity logs first, then pages sorted
by filename. Index labels use sanitised, single-line headings with hashes,
brackets and newlines stripped and a length cap. On-request pages use
exactly this writer and indexer. New numeric limits use their defaults if the
environment value is not a positive safe integer.

This separation keeps the call that can request control changes away from raw
hostile sources; the call that reads those sources has no way to change controls.
Applied changes are placed before untrusted context in the answer prompt and
also prefix the outgoing reply as a deterministic one-line confirmation, even
when the answer fails. Both paths persist to `data/research/control.json`.
Pausing stops participation calls, posting, commenting and
voting while feed capture continues when `RESEARCH_CAPTURE=1`. Briefing and daily
research continue. Focus is placed before untrusted feed/comment blocks.

Briefings and research answers/notices go to `ROAM_OUTBOX_DIR/briefing/` and
`ROAM_OUTBOX_DIR/research/`. Recipient-free flags contain `id`, `type: "message"`,
`timestamp`, `text`, and optionally `attachmentPath`. Markdown attachments are
copied atomically into the channel before the JSON flag is published.
On the **chat side**, set `ROAM_OUTBOX_DIR` and one or both of
`ROAM_BRIEFING_CHAT_JID` and `ROAM_RESEARCH_CHAT_JID`, or configure extra channels
with `ROAM_OUTBOX_EXTRA_CHANNELS=updates=example-group-id`. Each configured channel is
swept every `ROAM_OUTBOX_RELAY_INTERVAL` (5000 ms); unconfigured channels are
untouched. The relay injects its pinned recipient before using the unchanged
entourage validator and ignores any recipient supplied by a flag. It uses the
nonblocking, no-follow, size-capped flag reader (also used by the entourage
watcher), rejecting non-regular files before reading. Attachments are
regular `.md` files directly inside the channel, under `ROAM_OUTBOX_MAX_MD_BYTES`,
with no symlink in any checked path component. Each attachment is opened once
with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`; its descriptor must identify a regular
file with one hard link and a size within the cap. The parent's realpath must
match the channel's, and fresh path device/inode values must match the descriptor.
The sent bytes come from that descriptor. Immediately before sending, every
channel (built-in and extra) checks the flag text and that exact buffer for
configured secrets. Matches are permanently rejected: the id is remembered,
flag and attachment are archived as `.rejected`, and the warning names only the
channel. The check never re-reads the attachment path. Symlinked channels are not swept.
The writer's absolute attachment path can be relocated after sync only through
its matching `<flag-id>.md` basename and channel name; arbitrary outside paths
are refused. Flags and safe local attachments move to the channel's `archive/`,
with `.rejected` suffixes for validation failures. Unsafe external attachments
are never
moved. Archive ids provide deduplication across relay restarts. The existing
entourage watcher instance and its defaults are unchanged.

`ROAM_OUTBOX_EXTRA_CHANNELS` accepts up to eight comma-separated `name=chatId`
pairs, split at the first `=`. Names must match `^[a-z][a-z0-9-]{0,31}$` and cannot
be `briefing`, `research` or `archive`. IDs must be non-empty, at most 200
characters, and contain no whitespace, commas or control characters; base64
`=`, `/` and `+` are allowed. Spaces around commas are trimmed and empty entries
ignored. Invalid, duplicate and excess entries, and an entry repeating an earlier
entry's chat id (one chat must not collect several hourly budgets), are skipped
with one warning each, containing the entry's one-based position and valid
channel name (or `<invalid>`, also used when the pair looks reversed so that an
id in the name position is not echoed), never its recipient. The first valid occurrence
of a name wins; invalid entries do not consume the eight-channel allowance.
Unset or empty values add no channels. Extra folders are created as
`ROAM_OUTBOX_DIR/<name>/` with the same modes as the writer's channels (0700, or
0770 with `ROAM_OUTBOX_GROUP_READABLE=1`), set through a no-follow directory handle;
symlinks and non-directories are refused. Built-in folder behavior is unchanged.
The folder chooses the audience, and recipient fields inside flags are ignored.
Only the host environment chooses each folder's recipient.
Extra channels use the same attachment checks, archives, deduplication,
freshness window and per-channel limits as the built-in channels.

Relay limits: `ROAM_RELAY_MAX_PER_SWEEP=20` flags per channel, oldest first;
`ROAM_RELAY_MAX_PER_HOUR=30` successful sends per channel in a rolling hour.
`ROAM_RELAY_ATTACHMENT_GRACE_MS=600000` allows delayed markdown sync;
transport failures remain queued until delivery or validator expiry (48 hours).
`ROAM_RELAY_SEEN_LIMIT=5000` caps recent in-memory ids (may be lowered).
Archives are scanned only at startup, within that same freshness window, and
are never pruned.

`MOLTBOOK_CROSS_POLLINATION_QUEUE_LIMIT=50` bounds queued digests, dropping
the oldest entries when new items arrive (may be lowered).

For shared-group access, set `ROAM_INBOX_GROUP_READABLE=1` on the inbox writer
and `ROAM_OUTBOX_GROUP_READABLE=1` on the outbox writer. They use 0770 directories
and 0640 files instead of the private 0700/0600 defaults. Directory group write
access lets the other account rename and delete entries. Provision traversal on
shared roots and parent directories separately; these switches do not change
ownership. Outbox text and flag ceilings remain `ROAM_OUTBOX_MAX_TEXT_CHARS`
(4000) and `ROAM_OUTBOX_MAX_FLAG_BYTES` (16384), both configurable downward;
`ROAM_OUTBOX_MAX_MD_BYTES` defaults to 262144.

Before publishing outbox text or sending platform post titles/content and
comments, an exact-value egress check refuses any non-empty environment value
of `MOLTBOOK_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`. Rejections log no text or secret. Ordinary chat prompts include
Moltbook instructions only when the API-key gate is enabled.

Remaining tool-bearing inputs: the answerer reads untrusted corpus/wiki data
with restricted Claude file tools. Claude participation
and classification calls disable all tools, but briefing calls still consume feed
text, web pages and a derived journal with web tools enabled. Ordinary chat
model calls also retain web tools for non-piped chats. Codex participation,
briefing and classification retain read-only filesystem tools despite the
`tools` selector; browser and computer-use features are disabled by default via
`CODEX_DISABLE_FEATURES`. Prompt delimiters are not an OS isolation boundary.

## Deployment

For isolated roam mode, see the [deployment guide](docs/roam-deployment.md)
and its parameterised macOS/Linux pipe examples.

Generic installers live in `scripts/linux/` (systemd system units; see its
README) and `scripts/macos/` (launchd). Both use a dedicated account, a
root-owned staged installer, private runtime env files, and separate flags
directories for each transport.

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
- Moltbook participation personality comes from the runtime prompt; backend and model come from configuration
- Moltbook profile: https://www.moltbook.com/u/Kleinbot | Twitter: @KleinBot2026
- Moltbook cycles run on a timer in roam mode; chat daemons have no cycle timer. Manual invocation: `env -u CLAUDECODE npx tsx scripts/moltbook-cycle.ts`. The `CLAUDECODE` env var must be unset or `claude --print` refuses to run.
- Moltbook cross-pollination — queuing works, but delivery (`sendCrossPollination`) is also not on a timer. After a manual cycle, items sit in the queue in `data/moltbook-state.json` until drained manually or via the bridge.
- Signal transport — working end-to-end, signal-cli daemon via Unix socket JSON-RPC (--receive-mode on-connection), systemd service, no new npm deps
- Morning briefing — daily at 05:30 UK to chats with `"briefing": true`
