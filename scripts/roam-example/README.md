# Roam deployment examples

Read [the deployment guide](../../docs/roam-deployment.md) first. These fragments
prepare a macOS roam account and a Linux comms exchange timer; they do not
install dependencies, model CLIs, secrets, transport accounts or the roam daemon.
Keep roam stopped until the guide's cutover steps are complete.

Copy `settings.conf.example` to a private, non-checkout `settings.conf`, edit
all values, and use the same settings on both hosts. Values are literal, with
no quotes or expansion. Paths must be absolute with plain components and no
symlinks. `PIPE_DIR` is remote; `COMMS_PIPE_DIR` is local. Runtime and pipe must
be separate trees under `ROAM_HOME`. The Linux service account must already
exist; see [the Linux installer](../linux/README.md).

## Prepare the transfer credentials

As the comms account, create the private parent of `PIPE_KEY` and run
`ssh-keygen -t ed25519 -N '' -f /chosen/private/key/path`, using that setting's
path. Keep the private key account-owned mode 600. Copy only its `.pub` file to
an admin-controlled staging location on macOS as `pipe.pub`.

Collect the roam SSH server's host public key and compare its fingerprint with
the server console or a trusted admin session. Install the verified entry for
`ROAM_HOST` as `PIPE_KNOWN_HOSTS` on Linux, account-owned mode 600. A keyscan alone
is not verification. The script uses DNS names directly and ignores SSH config.

## macOS fragment

Install Homebrew rsync 3.x through an admin account first. Set `RSYNC_BIN` to
its executable. Review the Homebrew `rrsync` source and its interpreter path.
The commands below assume `/opt/homebrew/bin/rrsync`; adjust for your installation.

From a trusted admin session, stage the reviewed files. Root must never execute
an installer from a bot-writable checkout. Use a fresh destination with no
symlinks and root-owned, non-writable ancestors (including `/Library`). All
paths below are invented examples; `/path/to/prepared/` holds your edited inputs.

```bash
sudo install -d -o root -g wheel -m 755 /Library/kleinbot-roam-install
sudo install -o root -g wheel -m 644 scripts/roam-example/common.sh scripts/roam-example/install-roam-macos.sh /Library/kleinbot-roam-install/
sudo install -o root -g wheel -m 644 /path/to/prepared/settings.conf /path/to/prepared/pipe.pub /Library/kleinbot-roam-install/
sudo install -o root -g wheel -m 644 /opt/homebrew/bin/rrsync /Library/kleinbot-roam-install/rrsync.source
sudo /bin/bash /Library/kleinbot-roam-install/install-roam-macos.sh
```

The fragment checks staged files and all their ancestors before reading helpers
or settings. It creates a hidden, password-disabled non-admin account if absent;
existing accounts must have the expected home, staff group and UID range.
The home must be mode 700. Keep the service stopped during preparation.
Directories below the home and `authorized_keys` are written as the roam
account. Existing directory modes are preserved; inspect them before reuse.
An existing `authorized_keys` is accepted only if it already matches exactly;
the fragment never overwrites other keys. Review any difference manually.

A root-owned patched `rrsync` remains in the staging directory, which becomes
its permanent install location. Do not remove that directory afterwards. The
fragment verifies rsync 3.x, the exact replacement of `RSYNC = '/usr/bin/rsync'`,
and `-munge` support. A changed upstream source layout fails for manual review.
Homebrew binaries and their interpreter must remain admin-controlled. Enable
Remote Login separately; if an SSH access group already exists, the fragment
adds the roam account without replacing that group's membership.

Prepare the checkout, model tools, private env files and adapted roam launchd
plist as described in the guide. No service is installed or started here.

## Linux exchange and timer

Requires Bash, rsync 3.x, OpenSSH, coreutils, findutils and `flock` (util-linux).
The script reads the settings file as data, requires `COMMS_ACCOUNT`, and
refuses root. It creates missing pipe and lock directories with a private umask;
prepare a writable parent first. Existing modes are never reset. For shared
groups, pre-create the trees with the intended group and traversal permissions,
and set the corresponding daemon writer's group-readable option.

Stage reviewed files root-owned, then render the unit from the same settings.
Use fresh destinations without symlinks or writable ancestors. The commands
read the account name from the settings and look up its primary group. Never
source the settings as shell code. Root runs only standard install tools here;
the exchange runs as the service account.

```bash
COMMS_ACCOUNT=$(awk -F= '$1 == "COMMS_ACCOUNT" {print $2}' /path/to/prepared/settings.conf)
[[ "$COMMS_ACCOUNT" =~ ^[a-z][a-z0-9_-]*$ ]] && [ "$COMMS_ACCOUNT" != root ] || exit 1
COMMS_GROUP=$(id -gn "$COMMS_ACCOUNT")
sudo install -d -o root -g root -m 755 /usr/local/lib/kleinbot-pipe
sudo install -o root -g root -m 755 scripts/roam-example/pipe-sync.sh /usr/local/lib/kleinbot-pipe/
sudo install -o root -g root -m 644 scripts/roam-example/common.sh /usr/local/lib/kleinbot-pipe/
sudo install -o root -g "$COMMS_GROUP" -m 640 /path/to/prepared/settings.conf /etc/kleinbot-pipe.conf
sudo install -o root -g root -m 644 scripts/roam-example/kleinbot-pipe-sync.service scripts/roam-example/kleinbot-pipe-sync.timer /etc/systemd/system/
sudo sed -i "s/@COMMS_ACCOUNT@/$COMMS_ACCOUNT/" /etc/systemd/system/kleinbot-pipe-sync.service
sudo systemd-analyze verify /etc/systemd/system/kleinbot-pipe-sync.service /etc/systemd/system/kleinbot-pipe-sync.timer
sudo -u "$COMMS_ACCOUNT" /usr/local/lib/kleinbot-pipe/pipe-sync.sh /etc/kleinbot-pipe.conf
sudo systemctl daemon-reload
sudo systemctl enable --now kleinbot-pipe-sync.timer
```

The manual run must succeed before enabling the timer. Failures retain a nonzero
exit status and log rsync's last nonempty error line; transient failures retry
on the next tick. Exit 24 (a concurrent consumer removed a listed file) is
harmless. A lock prevents overlapping manual/timer runs. Check the journal with
`journalctl -u kleinbot-pipe-sync.service`.

The exchange pushes inbox JSON, pulls all outbox markdown, then pulls JSON
flags, including extra channels. Each pass uses `--remove-source-files` and
rsync's atomic rename, never `--delete` or `--inplace`. It excludes `*.tmp`,
`archive/`, and links; it does not prune directories or archives. New received
files are private; existing shared directory modes are preserved by
`--no-perms`. Extra-channel producers must obey the [outbox contract](../../docs/roam-outbox.md).
To stop exchanges, run `sudo systemctl disable --now kleinbot-pipe-sync.timer`
and stop `kleinbot-pipe-sync.service` if an exchange is still running.
