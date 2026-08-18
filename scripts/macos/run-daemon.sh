#!/bin/bash
# The single entry point launchd uses for every kleinbot daemon on macOS.
#
#   run-daemon.sh signal-cli | kleinbot-signal | kleinbot-whatsapp
#
# Why a wrapper at all: plists in /Library/LaunchDaemons are world-readable, so
# the Claude OAuth token, the Signal numbers and the Moltbook key cannot be put
# in <EnvironmentVariables>. They live in two mode-600 files owned by kleinbot
# and are sourced here, after launchd has already dropped to the bot account.
set -euo pipefail

RUNTIME=${KLEINBOT_RUNTIME_DIR:-/Users/kleinbot/team/kleinbot}

# launchd's job_postfork_become_user() should set HOME from the passwd record,
# but nothing here depends on whether it does so before or after applying
# <EnvironmentVariables>. Cheap insurance for ~/.claude, the npm cache and
# signal-cli's data dir.
export HOME="${HOME:-/Users/kleinbot}"

# daemon.env — machine secrets (CLAUDE_CODE_OAUTH_TOKEN), written by
#              ops/mac/set-claude-token.sh in the team monorepo.
# .env       — kleinbot's own runtime config; src/config.ts reads this file
#              directly too, but signal-cli needs SIGNAL_ACCOUNT in the
#              environment, so it is exported here as well.
#
# Loaded by hand rather than with `set -a; . file`, for three reasons:
#
#  1. Precedence. A shell assignment is unconditional, so sourcing would let
#     .env override the plist's <EnvironmentVariables> — the opposite of the
#     systemd behaviour this is ported from, where dotenv leaves an
#     already-set process.env alone and Environment= in the unit wins. A
#     live .env may carry PROCESS_INTERVAL=60000, which would silently undo the
#     per-transport 5000/600000 the plists exist to set, and a .env migrated
#     from Linux could carry a SIGNAL_SOCKET_PATH that cannot exist on macOS.
#     Here a variable already present in the environment is never touched.
#  2. Literal values. `.` evaluates the right-hand side, so a secret
#     containing $(...) or backticks is silently mangled (or executed).
#     Values here are taken exactly as written, with at most one layer of
#     surrounding quotes stripped.
#  3. Loud failure. `.` on a line like `BOT_NAME=Klein Bot` dies with
#     "Bot: command not found" and launchd crash-loops on it forever. A line
#     that is not a plain KEY=VALUE aborts with the file and line number.
load_env_file() {
  local file=$1 lineno=0 line key value
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    case "$line" in
      ''|'#'*) continue ;;
    esac
    # Tolerate `export KEY=VALUE`, which people write out of habit.
    case "$line" in
      'export '*) line=${line#export } ;;
    esac
    if ! printf '%s' "$line" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*='; then
      echo "$(basename "$0"): $file line $lineno is not KEY=VALUE — refusing to start" >&2
      echo "  (comments start with #; do not quote the key; no spaces around =)" >&2
      exit 78   # EX_CONFIG
    fi
    key=${line%%=*}
    value=${line#*=}
    # Strip one layer of matching surrounding quotes; everything else is
    # literal — no expansion, no command substitution.
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    # Only when unset: launchd's <EnvironmentVariables> stay authoritative.
    # printenv rather than ${!key+x} indirection — /bin/bash on macOS is 3.2,
    # and printenv asks the question we actually mean (is it in the exported
    # environment we are about to hand to the daemon?) with no version risk.
    if ! printenv "$key" >/dev/null 2>&1; then
      export "$key=$value"
    fi
  done < "$file"
}

for f in daemon.env .env; do
  [ -f "$RUNTIME/config/$f" ] && load_env_file "$RUNTIME/config/$f"
done

case "${1:-}" in
  signal-cli)
    : "${SIGNAL_ACCOUNT:?SIGNAL_ACCOUNT is not set in $RUNTIME/config/.env}"
    # A SIGKILL'd or power-lost daemon leaves its unix socket behind (run/ is
    # a plain directory, not tmpfs), and signal-cli does not unlink an
    # existing socket before bind — it exits 3 ("Address already in use") and
    # launchd crash-loops on it forever (verified by a repeated kill drill).
    # launchd guarantees a single instance of this label and this job is the
    # socket's only writer, so removing a stale *socket* here is safe. A
    # symlink is deliberately left in place to fail loudly, not followed.
    SOCK="$RUNTIME/run/signal.sock"
    if [ ! -L "$SOCK" ] && [ -S "$SOCK" ]; then
      rm -f "$SOCK"
    fi
    # The env key is SIGNAL_CLI_CONFIG_DIR, NOT SIGNAL_CLI_CONFIG: signal-cli
    # itself reads an environment variable named SIGNAL_CLI_CONFIG and treats
    # it as a config FILE, dying with "Failed to load config from <dir>:
    # <dir> (Is a directory)" — established by per-variable bisection against
    # 0.14.6. Since this wrapper exports every key in config/.env, the key
    # name must not collide with anything signal-cli reads.
    # --config is a GLOBAL option, so it goes before -a and the `daemon`
    # subcommand. Set SIGNAL_CLI_CONFIG_DIR in config/.env to point at the
    # migrated identity (Task 8 rsyncs it to /Users/kleinbot/
    # signal-cli-data); unset, signal-cli keeps its own default
    # ($XDG_DATA_HOME/signal-cli, else ~/.local/share/signal-cli).
    # Written as two full command lines rather than building an args array:
    # /bin/bash on macOS is 3.2, where expanding an empty array under `set -u`
    # is itself an "unbound variable" error.
    if [ -n "${SIGNAL_CLI_CONFIG_DIR:-}" ]; then
      exec /opt/homebrew/bin/signal-cli --config "$SIGNAL_CLI_CONFIG_DIR" \
        -a "$SIGNAL_ACCOUNT" daemon \
        --socket "$RUNTIME/run/signal.sock" --receive-mode on-connection
    fi
    exec /opt/homebrew/bin/signal-cli -a "$SIGNAL_ACCOUNT" daemon \
      --socket "$RUNTIME/run/signal.sock" --receive-mode on-connection
    ;;
  # WorkingDirectory (the repo checkout) is set by the plist, so the entry
  # points stay relative and the wrapper never hardcodes the checkout path.
  kleinbot-signal)
    exec /opt/homebrew/bin/npx tsx src/index-signal.ts
    ;;
  kleinbot-whatsapp)
    exec /opt/homebrew/bin/npx tsx src/index-whatsapp.ts
    ;;
  *)
    echo "usage: $(basename "$0") signal-cli|kleinbot-signal|kleinbot-whatsapp" >&2
    exit 64
    ;;
esac
