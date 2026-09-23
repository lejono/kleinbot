#!/bin/bash
# System services execute this wrapper after dropping to the bot account.
set -euo pipefail

: "${HOME:?HOME must be set to the bot account home}"
runtime=${KLEINBOT_RUNTIME_DIR:-$HOME/team/kleinbot}
export KLEINBOT_RUNTIME_DIR="$runtime"
export PATH="$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
default_checkout=$HOME/src/kleinbot
default_signal_cli=$HOME/.local/bin/signal-cli

# Keep this parser and command dispatcher identical on Linux and macOS.
# Parse into data only: no env-file key is assigned in this shell.
env_pairs=()
load_env_file() {
  local file=$1 lineno=0 line key value pair duplicate
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line=${line%$'\r'}
    case "$line" in
      ''|'#'*) continue ;;
      'export '*) line=${line#export } ;;
    esac
    if [[ ! "$line" =~ ^[A-Z][A-Z0-9_]*= ]]; then
      echo "$(basename "$0"): $file line $lineno is not KEY=VALUE (uppercase keys required) — refusing to start" >&2
      exit 78
    fi
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|IFS|HOME|SHELLOPTS|PS4|NODE_OPTIONS)
        echo "$(basename "$0"): $file line $lineno sets a forbidden environment key — refusing to start" >&2
        exit 78 ;;
    esac
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    # The inherited environment wins, including empty values. First file and
    # first occurrence win too, without exporting anything during parsing.
    if printenv "$key" >/dev/null 2>&1; then continue; fi
    duplicate=0
    for pair in ${env_pairs[@]+"${env_pairs[@]}"}; do
      if [ "${pair%%=*}" = "$key" ]; then duplicate=1; break; fi
    done
    [ "$duplicate" = 1 ] || env_pairs+=("$key=$value")
  done < "$file"
}

for file in daemon.env .env; do
  if [ -f "$runtime/config/$file" ]; then load_env_file "$runtime/config/$file"; fi
done

# Look up only the settings needed to build argv; other pairs go directly to
# env at exec time. Even shell-special uppercase keys never alter this shell.
setting() {
  local key=$1 fallback=$2 pair
  if printenv "$key"; then return; fi
  for pair in ${env_pairs[@]+"${env_pairs[@]}"}; do
    if [ "${pair%%=*}" = "$key" ]; then printf '%s\n' "${pair#*=}"; return; fi
  done
  printf '%s\n' "$fallback"
}

# Dry runs are opt-in through the inherited environment, never an env file.
launch() {
  if [ "${KLEINBOT_DRY_RUN:-}" = 1 ]; then
    printf 'command:'
    printf ' %q' "$@"
    printf '\ncwd=%s\n' "$PWD"
    env ${env_pairs[@]+"${env_pairs[@]}"}
  else
    exec env ${env_pairs[@]+"${env_pairs[@]}"} "$@"
  fi
}

checkout=$(setting KLEINBOT_CHECKOUT "$default_checkout")
case "${1:-}" in
  signal-cli)
    account=$(setting SIGNAL_ACCOUNT '')
    [ -n "$account" ] || { echo "SIGNAL_ACCOUNT is not set in $runtime/config/.env" >&2; exit 78; }
    sock="$runtime/run/signal.sock"
    # A dry run must leave even stale sockets alone.
    if [ "${KLEINBOT_DRY_RUN:-}" != 1 ] && [ ! -L "$sock" ] && [ -S "$sock" ]; then
      rm -f -- "$sock"
    fi
    config=$(setting SIGNAL_CLI_CONFIG_DIR '')
    binary=$(setting SIGNAL_CLI_BIN "$default_signal_cli")
    args=()
    if [ -n "$config" ]; then args+=(--config "$config"); fi
    launch "$binary" ${args[@]+"${args[@]}"} -a "$account" daemon --socket "$sock" --receive-mode on-connection
    ;;
  kleinbot-signal|kleinbot-whatsapp|kleinbot-roam)
    cd "$checkout"
    tsx="$checkout/node_modules/.bin/tsx"
    if [ "${KLEINBOT_DRY_RUN:-}" != 1 ] && [ ! -x "$tsx" ]; then
      echo "Missing executable $tsx; run npm ci (including dev dependencies) as the bot user" >&2
      exit 78
    fi
    launch "$tsx" "src/index-${1#kleinbot-}.ts"
    ;;
  *)
    echo "usage: $(basename "$0") signal-cli|kleinbot-signal|kleinbot-whatsapp|kleinbot-roam" >&2
    exit 64
    ;;
esac
