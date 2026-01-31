# Kleinbot

A WhatsApp bot that participates in group chats and DMs using Claude. Runs as a daemon on your machine, calling Claude via the `claude` CLI.

## How it works

Kleinbot connects to WhatsApp as a linked device (like WhatsApp Web) using Baileys. It stays connected, receiving messages in real-time from all chats. Every 60 seconds it checks for new messages, calls `claude --print` with the conversation transcript, and sends a reply if Claude decides to respond.

Each chat can have its own personality prompt, model, and verbosity level configured in `prompts/chats.json`.

Incoming messages are queued and persisted to `data/pending.json`, so a restart won't drop messages that were already received while the bot was running.

```
WhatsApp ──(Baileys)──▶ daemon collects messages in per-chat queues
                              │
                        every 60s, for each chat with new messages:
                              │
                        load prompt + context + bot notes from config
                              │
                        claude --print (stdin: transcript, system: assembled prompt)
                              │
                        if shouldRespond: send reply back to WhatsApp
```

## Prerequisites

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- A separate WhatsApp account for the bot (on its own phone number)

## Setup

```bash
npm install
cp .env.example .env                       # edit with your settings
cp prompts/chats.example.json prompts/chats.json  # configure per-chat behaviour
```

On first run, a QR code appears in the terminal. Scan it with WhatsApp on the bot's phone (Settings → Linked Devices → Link a Device). Auth credentials are saved to `data/auth/` — you only need to scan once.

## Running

```bash
npx tsx src/index.ts
```

The bot stays running in the foreground. Ctrl+C to stop. While stopped, it misses messages (Baileys companion devices only receive real-time messages).

For always-on operation, set up a systemd user service (no root required):

```bash
mkdir -p ~/.config/systemd/user
```

Create `~/.config/systemd/user/kleinbot.service`:

```ini
[Unit]
Description=Kleinbot WhatsApp Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/kleinbot
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
RestartSec=30
Environment=NODE_ENV=production
# Add your PATH if claude CLI is not in /usr/bin:
# Environment=PATH=/home/you/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Then enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable kleinbot
systemctl --user start kleinbot
```

Useful commands:

```bash
systemctl --user status kleinbot      # check status
systemctl --user restart kleinbot     # restart
systemctl --user stop kleinbot        # stop
journalctl --user -u kleinbot -f      # tail logs
```

User services run while you are logged in. To survive reboots without a login session, enable lingering: `loginctl enable-linger $USER`.

## Configuration

### Environment (.env)

```
BOT_NAME=Kleinbot
PROCESS_INTERVAL=60000    # ms between processing cycles
HISTORY_WINDOW=50         # rolling message context size (per chat)
LOG_LEVEL=warn            # Baileys log level (debug for troubleshooting)
```

### Per-chat config (prompts/chats.json)

Maps chat JIDs to settings. The `default` key is used for any chat not explicitly listed.

```json
{
  "default": {
    "prompt": "prompts/default.md",
    "model": "opus",
    "verbosity": 3
  },
  "120363000000000000@g.us": {
    "prompt": "prompts/default.md",
    "model": "sonnet",
    "description": "AI Club discussion group",
    "verbosity": 4
  },
  "4412345678@s.whatsapp.net": {
    "prompt": "prompts/dm-jono.md",
    "model": "sonnet",
    "description": "DM with Jono",
    "verbosity": 5,
    "context": "prompts/jono-context.md"
  }
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | yes | Path to a `.md` file with the bot's personality and rules |
| `model` | yes | Claude model: `opus`, `sonnet`, etc. |
| `description` | no | What this chat/group is about — injected into the system prompt |
| `verbosity` | no | 1–5, controls how eagerly the bot participates (default 3) |
| `context` | no | Path to a static `.md` file with background info you maintain |

**Verbosity scale:**

1. Almost never — only responds when @mentioned by name
2. Rarely — direct questions and @mentions only
3. Moderate — helpful when asked, facilitates when needed, quiet during banter
4. Chatty — joins conversations, offers opinions, reacts to topics
5. Very active — participates like a regular group member

### Personality prompts

Create `.md` files in `prompts/` with the bot's personality, tone, and rules. See `prompts/default.md` for the format. The prompt must end with instructions to output JSON:

```
{"shouldRespond": true/false, "response": "message or null", "notes": "anything to remember, or null"}
```

### Static context files

For background info that doesn't belong in the personality prompt (people's names, preferences, group conventions), create a context `.md` file and reference it in `chats.json`:

```
prompts/ai-club-context.md:
  - The first rule of AI Club is you don't talk about AI Club
  - Sarah's P(doom) = 1
  - Group meets every other Thursday at the pub
```

### Bot notes

The bot writes its own notes to `data/notes/{chatJid}.md` — things people told it, preferences it observed, instructions it was given ("don't talk so much"). These are appended automatically and capped at 50 lines. Notes are fed back into the system prompt each cycle, giving the bot persistent memory across restarts.

You can also edit the notes files directly.

## Adding the bot to a new group

1. The bot responds to all chats by default using the `default` config — no pre-configuration needed
2. Add the bot's phone number to the WhatsApp group
3. Send a message — the bot logs the group JID: `[new] [120363...@g.us] You: hello`
4. Add the JID to `prompts/chats.json` with custom settings
5. Optionally create a custom prompt `.md` and/or context file
6. Restart the bot to pick up config changes (config is read per-cycle, but a restart ensures a clean state)

## Security notes

- `data/auth/` contains WhatsApp private keys — keep these out of cloud-synced directories and set permissions to `chmod 600 data/auth/*`
- See `docs/` for a full security audit
- Baileys is an unofficial WhatsApp API — there is always some risk of account bans

## File structure

```
src/
  index.ts       daemon: connect, per-chat queues, process interval, respond
  config.ts      loads .env, builds config
  whatsapp.ts    Baileys connection, message extraction, sending
  ai.ts          claude CLI invocation, prompt assembly, chat config, notes
  state.ts       JSON state: dedup, rolling history
  types.ts       TypeScript interfaces
prompts/
  chats.json     per-chat config (JID → prompt/model/verbosity)
  default.md     default bot personality
data/
  auth/          Baileys auth credentials (created on first QR scan)
  state.json     message dedup and history
  pending.json   unprocessed messages queued for the next cycle
  notes/         bot's self-written notes per chat
scripts/
  setup.sh           initial setup
```

## License

[AGPL-3.0-or-later](LICENSE)
