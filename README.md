# Kleinbot

A multi-transport chat bot that participates in group chats and DMs using Claude. Runs as a daemon, calling Claude via the `claude` CLI. Supports **WhatsApp**, **Signal**, **Discord**, and **Slack**.

## How it works

Kleinbot connects to a messaging platform and stays connected, receiving messages in real-time. Every N seconds it checks for new messages in each chat, calls `claude --print` with the conversation transcript and a per-chat personality prompt, and sends a reply if Claude decides to respond.

Each chat can have its own personality prompt, model, verbosity level, and feature flags. The bot writes its own persistent notes about conversations.

```
Transport ──▶ daemon collects messages in per-chat queues
                    │
              every N seconds, for each chat with new messages:
                    │
              load prompt + context + bot notes from config
                    │
              claude --print (stdin: transcript, system: assembled prompt)
                    │
              if shouldRespond: send reply back via transport
```

### Transport architecture

All transports implement a common `Transport` interface (`src/transport.ts`), so the core daemon logic (`src/daemon.ts`) is platform-agnostic. Each transport is a separate entry point:

| Transport | Entry point | Connection method | Dependencies |
|-----------|-------------|-------------------|-------------|
| WhatsApp | `src/index-whatsapp.ts` | Baileys (linked device) | `baileys` npm package |
| Signal | `src/index-signal.ts` | signal-cli daemon (Unix socket JSON-RPC) | signal-cli binary (no npm deps) |
| Discord | `src/index-discord.ts` | Discord.js | `discord.js` npm package |
| Slack | `src/index-slack.ts` | Slack Bolt | `@slack/bolt` npm package |

## Prerequisites

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- A separate account for the bot on your chosen platform

## Setup

```bash
npm install
cp .env.example .env
cp prompts/chats.example.json prompts/chats.json
```

## Running

```bash
# Pick your transport:
npx tsx src/index-whatsapp.ts     # WhatsApp
npx tsx src/index-signal.ts       # Signal
npx tsx src/index-discord.ts      # Discord
npx tsx src/index-slack.ts        # Slack
```

## Signal setup

Signal uses [signal-cli](https://github.com/AsamK/signal-cli) running as a daemon, communicating over a Unix socket with JSON-RPC. No npm dependencies needed — Kleinbot uses Node's built-in `net` module.

### 1. Install signal-cli

```bash
bash scripts/signal-setup.sh
```

This downloads the native Linux build (GraalVM-compiled, no Java needed) to `~/.local/bin/signal-cli`.

### 2. Register a phone number

```bash
signal-cli -a +44XXXXXXXXXX register
signal-cli -a +44XXXXXXXXXX verify CODE
```

### 3. Start the signal-cli daemon

Install the systemd user service:

```bash
cp scripts/signal-cli.service ~/.config/systemd/user/
# Edit the service file: set your phone number in ExecStart
systemctl --user daemon-reload
systemctl --user enable --now signal-cli
```

The daemon creates a Unix socket at `$XDG_RUNTIME_DIR/signal-cli/socket`.

### 4. Configure Kleinbot

Add to `.env`:

```
SIGNAL_ACCOUNT=+44XXXXXXXXXX
SIGNAL_ADMIN_NUMBER=+44YYYYYYYYYY   # optional: admin commands
```

Create `prompts/signal-chats.json` (same format as `prompts/chats.json`, but keyed by phone number or base64 group ID).

### 5. Run

```bash
npx tsx src/index-signal.ts
```

### How it works

```
signal-cli daemon ──(Unix socket)──▶ SignalRpcClient (JSON-RPC)
        ↑                                    │
  systemd service                     Kleinbot daemon
  listens for messages               processes per-chat queues
  --receive-mode on-connection        calls claude --print
                                      sends replies via RPC
```

- `SignalRpcClient` handles connection, reconnection, and JSON-RPC framing
- `createSignalTransport()` wraps the RPC client in the common `Transport` interface
- Messages arrive as JSON-RPC notifications from the daemon
- No history sync — signal-cli only receives messages while connected (same limitation as WhatsApp/Baileys)

## WhatsApp setup

On first run, a QR code appears in the terminal. Scan it with WhatsApp on the bot's phone (Settings > Linked Devices > Link a Device). Auth credentials are saved to `data/whatsapp/auth/` — you only need to scan once.

Important: Baileys companion devices only receive real-time messages. The bot must stay running or it misses messages.

## Systemd services

For always-on operation, create systemd user services (no root required):

```bash
mkdir -p ~/.config/systemd/user
```

Example for Signal (`~/.config/systemd/user/kleinbot-signal.service`):

```ini
[Unit]
Description=Kleinbot Signal Bot
After=network-online.target signal-cli.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/kleinbot
ExecStart=/usr/bin/npm exec tsx src/index-signal.ts
Restart=on-failure
RestartSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kleinbot-signal
journalctl --user -u kleinbot-signal -f   # tail logs
```

To survive reboots without a login session: `loginctl enable-linger $USER`.

## Per-chat configuration

Maps chat IDs to settings. Format is the same across transports; only the chat ID format differs (WhatsApp JIDs, Signal phone numbers, Discord channel IDs, Slack channel IDs).

`prompts/chats.json` (WhatsApp) / `prompts/signal-chats.json` (Signal):

```json
{
  "default": {
    "prompt": "prompts/default.md",
    "model": "opus",
    "verbosity": 3
  },
  "+44123456789": {
    "prompt": "prompts/dm-friend.md",
    "model": "sonnet",
    "description": "DM with a friend",
    "verbosity": 4
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | yes | Path to a `.md` file with the bot's personality |
| `model` | yes | Claude model: `opus`, `sonnet`, `haiku` |
| `description` | no | What this chat is about (injected into system prompt) |
| `verbosity` | no | 1-5, how eagerly the bot participates (default 3) |
| `context` | no | Path to a static `.md` file with background info |
| `moltbook` | no | Enable Moltbook social platform integration |
| `briefing` | no | Enable daily morning briefing delivery |

**Verbosity scale:**

1. Almost never — only @mentions
2. Rarely — direct questions only
3. Moderate — helpful when asked, quiet during banter
4. Chatty — joins conversations, offers opinions
5. Very active — participates like a regular group member

## Features

- **Per-chat personalities** — each chat gets its own prompt, model, and verbosity
- **Bot notes** — persistent memory written by the bot itself (`data/notes/`)
- **Polls** — Claude can create native polls (WhatsApp)
- **Calendar invites** — Claude generates `.ics` files for events mentioned in chat
- **DM access control** — admin approval required for new DM conversations
- **Admin commands** — `/status`, `/notes`, `/help`, `/allow`, `/allowed`
- **Morning briefing** — daily AI news digest with web search (configurable per-chat)
- **Moltbook integration** — cross-pollination with Moltbook social platform for AI agents
- **Auto-reconnect** — reconnects on disconnect (except when logged out)
- **Message persistence** — pending messages survive restarts

## Environment (.env)

```
BOT_NAME=Kleinbot
PROCESS_INTERVAL=60000        # ms between processing cycles
HISTORY_WINDOW=50             # rolling message context size per chat
LOG_LEVEL=warn                # Baileys log level

# Signal
SIGNAL_ACCOUNT=+44XXXXXXXXXX
SIGNAL_ADMIN_NUMBER=+44YYYYYYYYYY
SIGNAL_SOCKET_PATH=            # override signal-cli socket path

# Optional
MOLTBOOK_API_KEY=              # Moltbook social platform integration
```

## File structure

```
src/
  daemon.ts          shared daemon: per-chat queues, process interval, respond
  transport.ts       Transport interface (common to all platforms)
  ai.ts              claude CLI invocation, prompt assembly, chat config, notes
  config.ts          loads .env, builds config
  types.ts           TypeScript interfaces
  whatsapp.ts        Baileys connection, message extraction, sending
  signal.ts          signal-cli Unix socket JSON-RPC client
  discord.ts         Discord.js connection
  slack.ts           Slack Bolt connection
  index-whatsapp.ts  WhatsApp entry point
  index-signal.ts    Signal entry point
  index-discord.ts   Discord entry point
  index-slack.ts     Slack entry point
prompts/
  chats.json             per-chat config (WhatsApp)
  signal-chats.json      per-chat config (Signal)
  discord-chats.json     per-chat config (Discord)
  default.md             default bot personality
data/
  whatsapp/auth/     Baileys auth credentials
  signal/            signal-cli data
  state.json         message dedup and history
  pending.json       unprocessed message queue
  notes/             bot's self-written notes per chat
scripts/
  setup.sh               initial setup
  signal-setup.sh         install signal-cli
  signal-cli.service      systemd service for signal-cli daemon
```

## Security notes

- `data/*/auth/` contains private keys — keep out of cloud-synced directories, `chmod 600`
- Baileys is an unofficial WhatsApp API — some risk of account bans
- signal-cli is an unofficial Signal client — uses the official Signal protocol
- See `docs/` for security audit reports

## License

[AGPL-3.0-or-later](LICENSE)
