# Deploying roam mode

## What runs where and why

Use two dedicated, non-admin service accounts, usually on different machines.
The **comms side** runs the chat daemon (`src/daemon.ts`, reached through the
transport entry points), holds the phone registration and transport credentials,
and receives private chats. The **roam side** runs `src/index-roam.ts` through
`npm run roam`: platform participation, research capture and classification,
the research wiki, briefing, and answers for one piped group.

This separation keeps private chats and transport credentials out of the account
that reads hostile agent text. Only messages deliberately routed from the piped
group cross that boundary; treat that group's membership as permission to give
roam instructions. Keep the normal chat access controls. Platform posts, comments,
corpus files and generated wiki pages remain untrusted data.

## Two folders and an exchange timer

Each machine has its own local copies of two folders:

| Folder | Direction | Contents |
| --- | --- | --- |
| `inbox/` | Comms to roam | Masked message text and attachment metadata, never attachment bytes |
| `outbox/` | Roam to comms | One folder per channel, containing JSON flags and optional markdown |

The built-in channels are `research/` (including piped answers and command
replies) and `briefing/`. Comms chooses each channel's recipient in its own
configuration. A flag cannot choose a recipient. Extra channels are described
in [the outbox guide](roam-outbox.md).

A timer on **comms** pushes the inbox, then pulls outbox markdown, then pulls
flags. The [example scripts](../scripts/roam-example/README.md) use rsync over
SSH once a minute. Default rsync temporary-file-and-rename publication keeps
files complete; never add `--inplace`. Successfully transferred source files
are removed with `--remove-source-files`. There is no `--delete`: directories
and comms-side `archive/` folders survive. Temporary files, symlinks and archives
are excluded. Deduplication tolerates retries; this is not a backup mechanism.

Sync only these folders. Keep the comms `data/roam-pipe-secret`, raw chat logs,
transport state, runtime configuration and model credentials local to their
own accounts. The research corpus and wiki stay private to roam; only selected
markdown copies enter the outbox.

## The restricted SSH key

Generate a dedicated unattended transfer key as the comms account. Keep its
private half there, mode 600, inside a private directory. Send only the public
half to the roam machine. The roam account's `authorized_keys` entry uses
`restrict,command="/path/to/rrsync -munge /path/to/pipe"` followed by that public
key. `restrict` disables forwarding and terminal access; `rrsync` restricts
rsync to the pipe tree. Both read and write are needed. Remote `inbox/` and
`outbox/` paths are relative to that tree, not absolute host paths.

This is a restriction on the transfer key, not an OS sandbox for the roam
process. The key can read and write within the pipe tree. Neither account
should have an unrestricted SSH key into the other account.

Use a root-owned copy of `rrsync`, outside the bot-writable checkout. On macOS,
point its `RSYNC` constant at Homebrew rsync 3.x; the example verifies the
rewrite and the rsync version. Ensure SSH Remote Login permits the roam account.
Verify the server host-key fingerprint through a trusted admin connection or
console before installing `known_hosts` on comms. `ssh-keyscan` only collects
candidates; it does not verify them. The exchange script requires a matching
entry and uses `StrictHostKeyChecking=yes`, ignoring SSH aliases and config.

## Accounts and directories

The examples use invented names `kbroam`, `kbcomms`, and `roam.example.net`.
Replace them in a private copy of the settings file. Each account needs its
own home, checkout, runtime, model authentication, and logs. Install Node and
npm, and run `npm ci` including dev dependencies **as the relevant account**;
the service wrapper uses the checkout's `node_modules/.bin/tsx`.

On Linux, install the comms account with [`scripts/linux/`](../scripts/linux/README.md)
(follow its README checklist, including the model CLI and signal-cli version
steps) before adding the pipe.

On macOS, the example fragment creates the roam account and private home,
`runtime/{config,data,prompts,logs,run,tmp,research-wiki}`, and
`pipe/{inbox,outbox}` with built-in channel folders. On Linux, prepare a private
comms runtime and `pipe/{inbox,outbox}` owned by the comms account. Choose paths
outside each other's runtime. Use mode 700 directories and mode 600 secrets.
For an intentional shared-group setup, provision traversal and group ownership
explicitly; the timer creates missing folders and preserves existing modes.
Folders the exchange creates are private (mode 700), so any outbox channel
that another local account writes must already exist with its group mode
before the first sync.

Root must execute only a reviewed, root-owned staged installer, with protected
ancestors, never scripts from a bot-writable checkout. Follow the example
README for staging. The fragment leaves services unconfigured and stopped.
For roam launchd, adapt
[`net.postquantum.kleinbot-roam.plist`](../scripts/macos/net.postquantum.kleinbot-roam.plist)
and the [macOS wrapper](../scripts/macos/run-daemon.sh): set `UserName`,
`GroupName`, `WorkingDirectory`, wrapper and log paths, explicit `HOME`,
`KLEINBOT_RUNTIME_DIR`, and a PATH containing the installed tools. Install the
reviewed plist root-owned, mode 644, under `/Library/LaunchDaemons`; create the
log directories before loading it. The existing chat installer does not install
roam. Keep the launchd job disabled until cutover is complete.

## Settings

Use [`.env.example`](../.env.example) for model, research, limits and schedule
settings. Set `KLEINBOT_RUNTIME_DIR` in the service environment before config is
loaded. Both platform wrappers read `config/daemon.env` then `config/.env`;
inherited environment values win, then the first file and first occurrence.
Values are literal: use full paths, without shell expansion. Keep chat and
roam env files separate.

These pipe names were checked against [`src/config.ts`](../src/config.ts):

| Setting | Where and meaning |
| --- | --- |
| `ROAM_INBOX_DIR` | Both sides: that machine's local inbox path; empty disables input |
| `ROAM_OUTBOX_DIR` | Both sides: that machine's local outbox root; empty disables output/relay |
| `ROAM_PIPE_CHAT_JID` | Comms only: group whose messages enter the inbox; both this and inbox path are required |
| `ROAM_RESEARCH_CHAT_JID` | Comms only: recipient for research, answers and command replies; use the piped group's identifier for a round trip |
| `ROAM_BRIEFING_CHAT_JID` | Comms only: recipient for briefing; empty leaves that channel unswept |
| `ROAM_OUTBOX_EXTRA_CHANNELS` | Comms only: up to eight comma-separated `name=chatId` mappings; empty enables none |

Keep actual identifiers in private configuration. All six settings default to
empty, with no implicit recipient. Roam needs directory paths, not chat IDs.
Set comms paths to the exchange script's `COMMS_PIPE_DIR/inbox` and
`COMMS_PIPE_DIR/outbox`, and roam paths to `PIPE_DIR/inbox` and `PIPE_DIR/outbox`.
The script settings file configures transfer only; the daemons do not read it.

For shared groups, `ROAM_INBOX_GROUP_READABLE=1` on the inbox writer and
`ROAM_OUTBOX_GROUP_READABLE=1` on the outbox writer request directories 0770 and
files 0640. Parent traversal and group membership still need provisioning.
Extra-channel folders are created by the relay with mode 0770.

Give each extra channel a distinct recipient; a repeated recipient is skipped.

For corpus capture enable `RESEARCH_CAPTURE`; classification requires
`RESEARCH_MODEL`, and daily wiki page generation requires
`RESEARCH_WRITEUP_MODEL`. Select supported models for the chosen backends.
The piped research answerer requires Claude; its restricted read tools cannot
be replaced by Codex. Codex may be used for classification.

## Secrets and model sign-in

Keep `config/daemon.env` and `config/.env` account-owned, mode 600. Never put
secrets in service definitions, checked-in examples, command arguments or logs.
Install model CLIs as the service account, with full paths available to services.

Run `claude setup-token` in a terminal, finish browser sign-in, and save the
**token printed in the terminal** as `CLAUDE_CODE_OAUTH_TOKEN` in the account's
private `daemon.env`. A browser sign-in code containing `#` is not that token.
Check authentication as the service account before starting the daemon.

For Codex, run `codex login --device-auth` as the roam account and complete the
browser flow. Device-code login may need enabling in account or workspace
settings.
Use `codex login status` under the same account to check the result. Credentials
belong to that account's private home. On macOS, for example, use
`sudo -u kbroam -H /Users/kbroam/.local/bin/codex login --device-auth`
when sudo's PATH does not find the tool.

`MOLTBOOK_API_KEY` belongs **only on roam**. Roam refuses startup without it.
Comms retains its own transport and model credentials, but no platform key.

## Order of cutover

1. Prepare both accounts, checkouts, dependencies, prompts, private env files,
   restricted transfer key and verified host key. Leave roam stopped and
   disabled, including across reboot. Configure the piped group and recipients
   on comms, retaining normal chat access controls.
2. Remove `MOLTBOOK_API_KEY` from **every comms configuration and service
   environment override**, including both env files. Restart every affected
   comms daemon (or stop it) **before roam first starts**. Editing a file alone
   leaves the key in a running process; otherwise both sides can post as one
   platform account.
3. Run the exchange once manually as the comms account, for example
   `sudo -u <comms-account> /usr/local/lib/kleinbot-pipe/pipe-sync.sh /etc/kleinbot-pipe.conf`,
   inspect its result, then enable the comms timer. Configure and enable the roam launchd job only
   after the key removal and comms restart are complete. Start roam and inspect
   its logs for missing configuration or authentication errors.
4. Test the round trip below. To roll back, stop and disable roam before ever
   restoring a platform key to comms. Stop the exchange timer before changing
   pipe paths or moving queued files.

## Test the round trip

Send `/status` as a new message in the allowed piped group. It runs in code,
without a model call, and replies through `outbox/research/`. With the example
minute timer and default minute roam tick, allow a few minutes plus any job
already in progress. Confirm the reply arrives in that same group.

If it stalls, follow the file: comms inbox, roam inbox, roam research outbox,
comms research outbox, then the local channel archive. Successful transfer
removes source files and processing may be quick, so absence alone is not a
failure. Inspect `journalctl -u kleinbot-pipe-sync.service` and each daemon's
private logs. The test proves command routing and transport; separately test a
research question for model authentication and an answer with markdown for
attachment delivery.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every sync exits 12, “error in rsync protocol data stream” | On macOS, Homebrew's `rrsync` can hardcode `RSYNC = '/usr/bin/rsync'`, selecting Apple's openrsync (protocol 29) | Use a root-owned copy with that line pointed at Homebrew's rsync 3.x; verify the rewrite and version, and reference that copy from `authorized_keys` |
| Git says “detected dubious ownership” while the service account clones a local repository | The source repository belongs to another account | After verifying that repository, run `git config --global --add safe.directory /absolute/path/to/repository` as the service account; allow that one path only |
| A pasted OAuth token fails with 401 or has the wrong length | Terminal paste added a newline or bracketed-paste markers | Remove literal escape markers `ESC[200~` and `ESC[201~`, then stray whitespace/control characters; compare the length with the original terminal token without printing it; paste again if uncertain and retry authentication |
| A browser code containing `#` is rejected as a token | It is a sign-in code | Enter it into the waiting `claude setup-token` flow; that command prints the actual token in the terminal |
| Abandoned sign-in remains in process state `T` and does not end on SIGTERM | The process is stopped | Verify the PID belongs to that abandoned sign-in with `ps`; `kill -9 <pid>` ends it |
| Shared folders lose group write permissions every minute | A timer script re-modes existing folders on every run | Create only missing folders; restore intended group ownership/modes once and enable the appropriate writer's group-readable setting |
| `sudo -u <account> <tool>` reports command not found on macOS | sudo's PATH omits the account's `~/.local/bin` | Use the full executable path, with `-H`, and set the service PATH explicitly |
| Host-key or public-key authentication fails | Unverified/missing host entry, wrong key permissions, SSH access restriction, or wrong forced-command path | Verify the host fingerprint through a trusted channel; check the key is account-owned mode 600, Remote Login permits the account, and the restricted line points at the installed executable; keep strict host checking enabled |
| Inbox moves but no answer arrives | Missing research recipient, wrong local paths, an unavailable outbox, or roam has not ticked yet | Match paths to transfer settings, pin `ROAM_RESEARCH_CHAT_JID` to the piped group, check directory access and daemon logs |
| Extra channel has no delivery | Invalid/duplicate mapping or no producer | Check config warnings and unique recipients; a mapping enables relay only, so a producer must write valid flags to that channel |
