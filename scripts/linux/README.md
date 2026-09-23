# Linux system services

Ubuntu 24.04 system units run `signal-cli`, `kleinbot-signal`, and
`kleinbot-whatsapp` as a dedicated, non-admin account (default `kleinbot`). No
login session or user service manager is required. Services log to journald.

## Deploying on a new host: checklist

Each step is explained in the sections below. Steps marked *bot* run as the
bot account (`sudo -u "$BOT_USER" -H bash`), never as root.

1. Stage `scripts/linux/` root-owned and run the installer once without
   `--start`. It creates the account, directories and units.
2. *bot*: clone the repository into `CHECKOUT` and run `npm ci` (with dev dependencies).
3. *bot*: `bash scripts/signal-setup.sh` for signal-cli (pinned version, checksum checked).
4. *bot*: install Claude Code and give it a token (see [Claude Code](#claude-code)).
5. *bot*: fill `config/daemon.env` and `config/.env` (mode 600) and `prompts/`.
6. Register a new Signal number, or migrate an existing identity with the old
   host stopped (see [Operation and migration](#operation-and-migration)).
7. Re-run the staged installer with `--start`. It refuses to start while
   `claude`, `signal-cli` or `tsx` is missing, and warns when no Claude token is set.
8. Check the journals, then send the bot a direct message and confirm it replies.

## Prerequisites

- Node.js and npm on the system `PATH` (`/usr/local/bin` or `/usr/bin`), git,
  Bash, and the standard Ubuntu account/core utilities. Use Node 22 or newer
  for the development/test commands. The **locked dependency engine minimum
  is Node 20.3.0**: `package.json` has no `engines` field;
  `package-lock.json` locks `baileys` 6.7.21 with `>=20.0.0` and `sharp` 0.34.5
  with `^18.17.0 || ^20.3.0 || >=21.0.0`. Intersecting all locked `engines.node`
  ranges gives 20.3.0. Ubuntu's Node 18 package is insufficient. The test
  command also uses Node's test-runner glob support; use Node 22+ for it.
- `npm ci` in the checkout, as the bot account, including dev dependencies:
  the daemons run `CHECKOUT/node_modules/.bin/tsx`, and `tsx` is a dev
  dependency. A missing executable fails startup; nothing is downloaded.
- Native Linux signal-cli, installed **as the bot account** with
  `bash scripts/signal-setup.sh` (requires curl and tar). That script downloads
  an x86_64 build into `~/.local/bin`; other architectures need a compatible
  native binary via `SIGNAL_CLI_BIN`. Ignore its older user-service setup
  instructions: use the system units here, with no second signal-cli daemon.
- Claude Code installed and authenticated for the bot account; see
  [Claude Code](#claude-code). The units look for `claude` on
  `~/.local/bin:/usr/local/bin:/usr/bin:/bin`; no shell profile is loaded.

## Claude Code

Every chat reply is a `claude --print` call made by the bot account. If
`claude` is not on the unit PATH the bot receives messages but every reply
fails with `spawn claude ENOENT` and the message is dropped after three tries.

1. As the bot account, install Claude Code with Anthropic's native installer
   (see the Claude Code documentation), which puts `claude` in `~/.local/bin`.
   Copying an existing `claude` binary into `~/.local/bin` also works.
2. On any machine where you can open a browser, run `claude setup-token` with
   the Claude account the bot should use. Put the token in
   `$RUNTIME/config/daemon.env` as `CLAUDE_CODE_OAUTH_TOKEN=...` (mode 600).
3. Check it as the bot account, with the same PATH as the units:

   ```bash
   env PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" CLAUDE_CODE_OAUTH_TOKEN=... \
     claude -p --model haiku --tools "" 'Reply with the single word ok.'
   ```

The model process gets only an allowlisted environment (`src/child-env.ts`):
basic locale and path variables, proxy settings and `NODE_EXTRA_CA_CERTS`, plus
`CLAUDE_CODE_*`, `ANTHROPIC_*` and `CLAUDE_CONFIG_DIR`. Signal, admin,
entourage, roam and Moltbook settings are never passed on. Add other names
(cloud-provider credentials such as `AWS_*`, say) with
`MODEL_CHILD_ENV_ALLOW=NAME1,NAME2`.

## Stage and install

Root must run the installer from a root-owned staged copy. Root installs
system services, so the bot must not be able to edit the source that root
reads. Stage the whole directory (including `unit-tools.sh`):

```bash
sudo install -d -o root -g root -m 755 /usr/local/kleinbot-install
sudo install -o root -g root -m 644 scripts/linux/* /usr/local/kleinbot-install/
sudo bash /usr/local/kleinbot-install/install.sh
```

The installer checks source files and ancestor directories for root ownership
and group/other write permissions before sourcing any helper. The staged copy
is the only supported entry point; `--trust-checkout` has been removed. Review
the source before staging it: validation cannot protect against an
attacker-supplied installer or validator. Root-touched destination symlinks
(including ancestors) are refused, and their parents must be protected.

The installer creates a system account with `/bin/bash`, a home directory and
no password if missing. An existing account must have the configured home and
primary group; it should be dedicated and non-admin. It creates runtime
directories as the bot user, installs the mode-755 wrapper in the root-owned
mode-755 `/usr/local/lib/kleinbot` directory outside the home, validates all three
rendered units (including `systemd-analyze verify` when available), installs
them into `/etc/systemd/system`, reloads systemd, and enables them.

**It starts services only with `--start`.** Enabling also schedules them for
the next boot, so finish setup before rebooting. Re-running preserves secrets
and data. **Before re-running the installer, stop all three units:**

```bash
sudo systemctl stop kleinbot-signal-cli kleinbot-signal kleinbot-whatsapp
```

Keep them stopped while copying runtime data or the Signal identity. Use
`--start` once preparation is complete.

Installer environment variables (pass them with `sudo env NAME=value ...`):

| Variable | Default |
| --- | --- |
| `BOT_USER` | `kleinbot` |
| `BOT_GROUP` | `$BOT_USER` |
| `BOT_HOME` | `/home/$BOT_USER` |
| `CHECKOUT` | `$BOT_HOME/src/kleinbot` |
| `RUNTIME` | `$BOT_HOME/team/kleinbot` |
| `WRAPPER_DIR` | `/usr/local/lib/kleinbot` |
| `FLAGS_SIGNAL` | `/srv/entourage/signal` |
| `FLAGS_WHATSAPP` | `/srv/entourage/whatsapp` |
| `FLAGS_GROUP` | empty; use `BOT_GROUP` for flags ownership |

Use absolute paths with plain components (letters, digits, dots, underscores
and hyphens), without trailing slashes, `.` or `..` components. Spaces,
systemd specifiers and other metacharacters are rejected before rendering.
`BOT_HOME` must be directly under the root-owned `/home`; `useradd --create-home`
creates it, and root checks its type and owner before setting mode 700.
All runtime directories and intermediate directories below the home are
created by and owned by the bot. A custom `RUNTIME` outside the home must
already be writable by the bot, which creates its contents. The installer
does not create or use `$RUNTIME/bin`. `WRAPPER_DIR` and its existing ancestors
must be root-owned and have no group/other write access.
Flags trees must not overlap each other or private runtime subdirectories,
or contain the wrapper, system units, or staged installer.

The complete unit placeholder set is `@BOT_USER@`, `@BOT_GROUP@`, `@BOT_HOME@`,
`@RUNTIME@`, `@WRAPPER_DIR@`, `@CHECKOUT@`, `@FLAGS_SIGNAL@`, and
`@FLAGS_WHATSAPP@`. The unit PATH uses `@BOT_HOME@/.local/bin`.
`unit-tools.sh` provides the renderer shared by the installer and tests. Unit files contain only
non-secret environment settings; secret-shaped `Environment=` names ending
in `_TOKEN` or `_KEY`, or containing `PASSWORD`, are rejected.

## Prepare the runtime

After the first install:

1. Clone this repository into `CHECKOUT` as the bot account. Create its parent
   directories as that account, then run `npm ci` there.
2. Run `scripts/signal-setup.sh` as the bot account and set up
   Claude Code (see [Claude Code](#claude-code)). `sudo -u "$BOT_USER" -H bash` gives a setup shell without
   requiring an interactive login session; define `BOT_USER` first.
3. Populate `$RUNTIME/config/daemon.env` and `$RUNTIME/config/.env`. The
   installer creates an empty `daemon.env` only if absent. Existing env files
   must be regular, non-symlink, bot-owned files with mode **600**, or the
   installer refuses them. It never rewrites their contents or silently fixes
   their permissions. `config/`, `data/`, `prompts/`, `run/`, and `logs/` are
   mode 700; `logs/` is reserved, and services write to journald.
4. With all three units stopped, copy or prepare `data/`, `prompts/`, and the
   Signal identity as described below. Run the staged installer with the same variables and `--start`.

For a separate roam account and an SSH exchange timer, see the
[roam deployment guide](../../docs/roam-deployment.md) and [example scripts](../roam-example/README.md).
For optional roam outbox channels, see [the environment example](daemon.env.example)
and [the channel configuration guide](../../docs/roam-outbox.md).

The wrapper reads `daemon.env` then `.env`, after systemd drops privileges.
Already exported values, including empty ones, win; thus unit settings win
over both files, and `daemon.env` wins over `.env`. Lines must be `KEY=VALUE`,
with uppercase keys matching `[A-Z][A-Z0-9_]*`, optionally prefixed by `export `.
CRLF line endings are accepted and the trailing carriage return is removed.
Blank lines and lines beginning with `#` are ignored. One matching layer of surrounding quotes is removed. Values
are otherwise literal: no expansion, command substitution, inline comments,
or shell evaluation. Malformed lines fail with a file and line number (exit 78).
The files cannot set `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`,
`IFS`, `HOME`, `SHELLOPTS`, `PS4`, or `NODE_OPTIONS`. Parsed entries are passed
to the daemon through `env`, never assigned in the parsing shell.
For testing, inherited `KLEINBOT_DRY_RUN=1` prints the resolved command and
environment without launching a daemon or requiring its executable; its output
includes env-file values, so use it only with non-secret fixtures.

Wrapper variables are `KLEINBOT_RUNTIME_DIR` (default `$HOME/team/kleinbot`),
`KLEINBOT_CHECKOUT` (default `$HOME/src/kleinbot`), `SIGNAL_CLI_BIN` (default
`$HOME/.local/bin/signal-cli`), and optional `SIGNAL_CLI_CONFIG_DIR`. The first
two are set by the units. Set the latter two in a runtime env file when needed;
write full paths, since `$HOME` in an env-file value is literal. `SIGNAL_ACCOUNT`
also belongs in the private env files. Leave `SIGNAL_CLI_CONFIG_DIR` unset for
signal-cli's default (`$XDG_DATA_HOME/signal-cli`, otherwise
`$HOME/.local/share/signal-cli`); do not use `SIGNAL_CLI_CONFIG`, which upstream
treats as a config *file*. The socket is always `$RUNTIME/run/signal.sock`;
the wrapper removes an existing socket before startup, but leaves symlinks and
regular files in place to fail visibly.

## Shared flags directories

For a consumer running under another account on the same host, put each flags
tree outside the private bot home. For example:

```bash
sudo env FLAGS_GROUP=entourage \
  FLAGS_SIGNAL=/srv/entourage/signal \
  FLAGS_WHATSAPP=/srv/entourage/whatsapp \
  bash /usr/local/kleinbot-install/install.sh
```

Use a separate shared group such as `entourage`, rather than the bot's primary
group, so the consumer receives access only to the shared trees.
The flags parent (for example `/srv/entourage`) is root-owned by design. If
absent, root creates it with mode **0751**; existing parents are left unchanged.
Each flags root must be directly under a root-owned parent with no group/other
write access, with equally protected ancestors. Unsafe parents are refused.
The old runtime-local flags paths are therefore no longer supported; setting
`FLAGS_GROUP` with paths under the private runtime also prints a traversal warning.

`FLAGS_GROUP` is created if absent, and the bot is added to it. Each flags
directory and its `incoming/`, `outgoing/`, `archive/`, and `attachments/`
subdirectories are owned by the bot with that group and mode **2770**. Root
creates the two flags roots; the bot creates their four subdirectories and
inherits the shared group through the setgid bit.
Systemd initializes supplementary groups from account membership. Add the
consumer's account to the same group using `usermod -aG "$FLAGS_GROUP"
"$CONSUMER_USER"`, with both variables set for the deployment. Restart the
consumer to pick up membership. Ensure both accounts can traverse any
pre-existing parent directories; the installer does not relax private home
permissions or change unrelated parents.

The setgid bit preserves the shared group on new entries. The bot units use
`UMask=0007`; configure the consumer similarly, and make transferred files
group-writable where needed. Existing files are not recursively chmodded or
chowned. Keep Signal and WhatsApp `outgoing/` directories distinct. Each unit
sets `ENTOURAGE_ALLOW_ROOTS` to **its own flags tree's `attachments/` only**,
never to the runtime/config tree. Restart already running bot services after
changing paths or group membership.

## Operation and migration

```bash
sudo systemctl restart kleinbot-signal-cli kleinbot-signal kleinbot-whatsapp
sudo systemctl status kleinbot-signal-cli kleinbot-signal kleinbot-whatsapp
sudo journalctl -u kleinbot-signal -f
sudo journalctl -u kleinbot-whatsapp -u kleinbot-signal-cli
```

All units use `Restart=always`, a 30-second delay, and no start-rate limit:
SIGTERM/SIGINT handlers exit successfully, so successful exits also need a
restart. An explicit `systemctl stop` keeps a unit stopped. See the
[systemd restart rules](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
Signal requires and starts after signal-cli; WhatsApp is independent. Ordering
does not guarantee that the socket is ready: the bot retries after an early
connection failure. Restart the Signal pair together when maintaining the
socket daemon, since explicitly stopping its required unit also stops the bot.
For a persistent maintenance stop, disable the units as well so reboot does not
start them. Journal access is controlled by system permissions; logs can
contain private message content.

When migrating from another host:

1. Prepare the new checkout, dependencies, Claude Code and native signal-cli,
   leaving new services stopped. **The new signal-cli must be the same version
   as the old host's or newer** (`signal-cli --version` on both). An older
   signal-cli on data from a newer one fails to decrypt every incoming message
   (`getServerGuid(...) must not be null`) and the messages are lost, while
   sending still works. **Stop the old daemons before taking the final copy. The
   same Signal identity must never run on two hosts at once.** Disable their
   automatic startup on the old host as well.
2. Securely copy runtime `data/`, `prompts/`, and `config/`, plus signal-cli's
   config directory. Preserve private permissions and assign ownership to the
   destination bot account. Do not copy a stale socket; `run/` is recreated.
3. Review configuration for old-host paths; set `SIGNAL_CLI_CONFIG_DIR` to the
   copied identity directory if needed. Keep secrets in the mode-600 env files.
   Transfer queued flags and attachments separately if needed, preserving
   transport separation and adjusting their shared group permissions.
4. Re-run the staged installer with the chosen variables and `--start`, then
   inspect the journals. If Baileys auth does not transfer, re-pair WhatsApp
   using the project's QR flow. Keep the old services stopped throughout.
