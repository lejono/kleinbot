#!/bin/bash
# Install the kleinbot launchd daemons on a macOS host.
#
#   sudo bash install.sh                        # all three
#   sudo bash install.sh --only kleinbot-signal # one (Signal before the WhatsApp cutover)
#   sudo bash install.sh --trust-checkout       # allow a non-root-owned source dir
#
# INTENDED INVOCATION: from a ROOT-OWNED copy of scripts/macos/. Root installs
# system LaunchDaemons out of these files, so a source directory the bot account
# can write is a source directory the bot can use to author what root installs.
# Running from a bot-writable checkout (e.g. /Users/kleinbot/src/team/...) is
# refused unless --trust-checkout is passed. The plist assertions below are a
# second line of defence, not a substitute.
#
# Idempotent: re-running reinstalls the wrapper, replaces each plist and
# re-bootstraps the daemon. Secrets are NOT this script's business — the env
# files under config/ are created by ops/mac/setup-bot-user.sh and populated by
# set-claude-token.sh; touching them here would risk clobbering a live token.
set -euo pipefail

BOT=kleinbot
BOTHOME=/Users/$BOT
RUNTIME=$BOTHOME/team/kleinbot
HERE="$(cd "$(dirname "$0")" && pwd)"
DAEMONS=(signal-cli kleinbot-signal kleinbot-whatsapp)
TRUST_CHECKOUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      ONLY="${2:?--only needs a daemon name}"
      case " ${DAEMONS[*]} " in
        *" $ONLY "*) DAEMONS=("$ONLY") ;;
        *) echo "unknown daemon: $ONLY (one of: ${DAEMONS[*]})" >&2; exit 64 ;;
      esac
      shift 2
      ;;
    --trust-checkout) TRUST_CHECKOUT=1; shift ;;
    *) echo "usage: sudo bash install.sh [--only <daemon>] [--trust-checkout]" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "must run with sudo"; exit 1; }
id "$BOT" >/dev/null 2>&1 || { echo "no $BOT user — run ops/mac/setup-bot-user.sh first"; exit 1; }

# This script runs as root over content that may live in a kleinbot-writable
# checkout (/Users/kleinbot/src/team/kleinbot/scripts/macos). The wrapper is
# not the escalation risk — it executes as kleinbot either way — but the
# plists are: they name the user launchd runs the job as, and every other key
# in them (Program, GroupName, Standard{Out,Error}Path, EnvironmentVariables)
# is equally root's problem at install time. The plutil assertions below pin
# the ones that matter, but they are a whitelist over an attacker-authored
# file; owning the source directory is the real control. Fatal by default.
if [ -n "$(find "$HERE" -maxdepth 0 ! -user root 2>/dev/null)" ]; then
  if [ "$TRUST_CHECKOUT" -eq 1 ]; then
    echo "warning: $HERE is not root-owned — proceeding on --trust-checkout; plist contents still verified" >&2
  else
    echo "REFUSING: $HERE is not root-owned." >&2
    echo "  Copy scripts/macos/ to a root-owned path and run it from there, e.g." >&2
    echo "    sudo rsync -a --chown=root:wheel $HERE/ /usr/local/kleinbot-install/" >&2
    echo "    sudo bash /usr/local/kleinbot-install/install.sh" >&2
    echo "  Or re-run with --trust-checkout if you are certain the source is not bot-writable." >&2
    exit 1
  fi
fi

# Refuse to write anything through a symlink. Root's `install` calls below all
# land under $RUNTIME, a tree the bot account owns and can rewrite between
# runs. `install -d -o kleinbot -m 700 <symlink>` exits 0, leaves the link
# alone, and applies the ownership and mode to its *target* — so
# `rm -rf logs && ln -s /etc logs` before the next `sudo bash install.sh`
# hands /etc to kleinbot. Same shape as the check in ops/mac/setup-bot-user.sh.
refuse_symlink() {
  if [ -L "$1" ]; then
    echo "$1 is a symlink — refusing to install through it (remove it and re-run)" >&2
    exit 1
  fi
}
for d in "$RUNTIME" "$RUNTIME/bin" "$RUNTIME/bin/run-daemon.sh" "$RUNTIME/logs" "$RUNTIME/run"; do
  refuse_symlink "$d"
done

echo "== 1. Wrapper =="
# The daemons run the wrapper out of the runtime tree, not out of this checkout:
# the runtime tree survives a re-clone of the repo, so re-cloning can never
# leave launchd pointing at a path that momentarily does not exist.
install -d -o "$BOT" -g staff -m 755 "$RUNTIME/bin"
install -o "$BOT" -g staff -m 755 "$HERE/run-daemon.sh" "$RUNTIME/bin/run-daemon.sh"
echo "installed $RUNTIME/bin/run-daemon.sh"

# launchd will not spawn a job whose Standard{Out,Error}Path directory is
# missing, and it fails with a bare status 5 — cheaper to guarantee the dirs.
# logs/ is 700: the daemons log recipient phone numbers and message excerpts,
# and the machine may have other local accounts.
install -d -o "$BOT" -g staff -m 700 "$RUNTIME/logs"
install -d -o "$BOT" -g staff -m 755 "$RUNTIME/run"

for f in daemon.env .env; do
  [ -f "$RUNTIME/config/$f" ] || echo "warning: $RUNTIME/config/$f missing — daemons will start without it"
done

echo "== 2. Daemons =="
for d in "${DAEMONS[@]}"; do
  LABEL=net.postquantum.$d
  SRC=$HERE/$LABEL.plist
  DEST=/Library/LaunchDaemons/$LABEL.plist
  [ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

  # Do not trust the checkout: read back the two keys that decide what root is
  # about to install as a system daemon. A compromised kleinbot account only
  # has to flip UserName to root, or repoint ProgramArguments, and wait for the
  # next `sudo bash install.sh`.
  SRC_USER=$(plutil -extract UserName raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
  if [ "$SRC_USER" != "$BOT" ]; then
    echo "REFUSING $SRC: UserName is '$SRC_USER', expected '$BOT'" >&2
    exit 1
  fi
  SRC_PROG=$(plutil -extract ProgramArguments.0 raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
  if [ "$SRC_PROG" != "$RUNTIME/bin/run-daemon.sh" ]; then
    echo "REFUSING $SRC: ProgramArguments[0] is '$SRC_PROG', expected '$RUNTIME/bin/run-daemon.sh'" >&2
    exit 1
  fi
  # launchd prefers `Program` over ProgramArguments[0] as the executable, so a
  # plist can satisfy the assertion above and still exec something else
  # entirely. None of our plists set it; require its absence (extract fails).
  if plutil -extract Program raw -o - "$SRC" >/dev/null 2>&1; then
    echo "REFUSING $SRC: it sets Program, which launchd execs in preference to ProgramArguments[0]" >&2
    exit 1
  fi
  SRC_GROUP=$(plutil -extract GroupName raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
  if [ "$SRC_GROUP" != "staff" ]; then
    echo "REFUSING $SRC: GroupName is '$SRC_GROUP', expected 'staff'" >&2
    exit 1
  fi
  # It is not established whether launchd opens these before or after dropping
  # to UserName; if before, an arbitrary path here is a root-authored file
  # creation anywhere on the disk. Pin them into the logs dir either way.
  for k in StandardOutPath StandardErrorPath; do
    SRC_LOG=$(plutil -extract "$k" raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
    case "$SRC_LOG" in
      "$RUNTIME/logs/"*) ;;
      *) echo "REFUSING $SRC: $k is '$SRC_LOG', expected a path under $RUNTIME/logs/" >&2; exit 1 ;;
    esac
  done

  # Pre-flight the things launchd needs but reports only as a bare status.
  if [ "$d" != "signal-cli" ]; then
    WD=$(plutil -extract WorkingDirectory raw -o - "$SRC" 2>/dev/null || echo "")
    [ -d "$WD" ] || echo "warning: $LABEL WorkingDirectory $WD is missing — the job will crash-loop"
    [ -x "$WD/node_modules/.bin/tsx" ] || echo "warning: $WD/node_modules/.bin/tsx not found — run npm ci there"
  fi

  install -o root -g wheel -m 644 "$SRC" "$DEST"

  # bootstrap refuses a label that is already loaded, so unload first; the
  # first ever run has nothing to unload, hence the ignored failure. bootout
  # returns before the job has finished tearing down, so wait for the label to
  # actually disappear — otherwise bootstrap intermittently fails with
  # "37: Operation already in progress" or "5: Input/output error".
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "system/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done

  # launchd keeps per-label disable state in its override database,
  # independently of the plist: without this, a label disabled once during
  # debugging stays disabled through every later install, silently.
  launchctl enable "system/$LABEL" 2>/dev/null || true

  if ! launchctl bootstrap system "$DEST" 2>/dev/null; then
    sleep 2
    if ! launchctl bootstrap system "$DEST"; then
      # One bad daemon must not strand the others: the plist is installed, so
      # a later re-run (or a reboot) will pick it up.
      echo "$LABEL: bootstrap FAILED twice — plist installed but not loaded, continuing" >&2
      continue
    fi
  fi
  echo "$LABEL: $(launchctl print "system/$LABEL" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1)"
done

echo "== Done =="
echo "logs: $RUNTIME/logs/"
