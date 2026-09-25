#!/bin/bash
# Run as root from a root-owned staged copy of scripts/linux/.
set -euo pipefail
umask 077

BOT_USER=${BOT_USER:-kleinbot}
BOT_GROUP=${BOT_GROUP:-$BOT_USER}
BOT_HOME=${BOT_HOME:-/home/$BOT_USER}
CHECKOUT=${CHECKOUT:-$BOT_HOME/src/kleinbot}
RUNTIME=${RUNTIME:-$BOT_HOME/team/kleinbot}
WRAPPER_DIR=${WRAPPER_DIR:-/usr/local/lib/kleinbot}
FLAGS_SIGNAL=${FLAGS_SIGNAL:-/srv/entourage/signal}
FLAGS_WHATSAPP=${FLAGS_WHATSAPP:-/srv/entourage/whatsapp}
FLAGS_GROUP=${FLAGS_GROUP:-}
HERE=$(cd -- "$(dirname -- "$0")" && pwd -P)
START=0
UNITS=(kleinbot-signal-cli kleinbot-signal kleinbot-whatsapp)

die() { echo "$*" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --start) START=1 ;;
    *) die "usage: sudo bash install.sh [--start]" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "must run as root"

# Bootstrap trust BEFORE sourcing any helper. The installer itself must also
# be invoked from a protected stage; no validator can make untrusted code safe.
for source_path in "$HERE/install.sh" "$HERE/unit-tools.sh"; do
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || die "REFUSING untrusted source"
  p=$source_path
  while :; do
    [ ! -L "$p" ] && [ "$(stat -c %u -- "$p")" = 0 ] &&
      [ $(( 8#$(stat -c %a -- "$p") & 8#022 )) -eq 0 ] ||
      die "REFUSING untrusted source: use a root-owned staged copy of scripts/linux/"
    [ "$p" = / ] && break
    p=$(dirname -- "$p")
  done
done
. "$HERE/unit-tools.sh"
check_stage "$HERE"
validate_settings
check_root_path /home
refuse_symlinks "$BOT_HOME"
check_root_path "$WRAPPER_DIR"
for unit in "${UNITS[@]}"; do
  check_root_path /etc/systemd/system
  refuse_symlinks "/etc/systemd/system/$unit.service"
done

# Refuse --start before changing anything if the units could not do their work.
# It runs as the bot: the paths it reads are bot-controlled, and the bot's view is the units' view.
if [ "$START" -eq 1 ]; then
  id "$BOT_USER" >/dev/null 2>&1 || die "not starting: account $BOT_USER does not exist yet; run once without --start"
  runuser -u "$BOT_USER" -- bash -c '. "$1/unit-tools.sh"; check_start_ready "$2" "$3" "$4"' \
    check_start_ready "$HERE" "$BOT_HOME" "$CHECKOUT" "$RUNTIME" ||
    die "not starting: fix the items above (scripts/linux/README.md, Prepare the runtime), then re-run with --start"
fi

if [ -n "$FLAGS_GROUP" ]; then
  for p in "$FLAGS_SIGNAL" "$FLAGS_WHATSAPP"; do
    if [[ "$p/" = "$RUNTIME/"* ]]; then
      echo "warning: FLAGS_GROUP consumers cannot traverse the mode-700 runtime to reach $p" >&2
    fi
  done
fi

getent group "$BOT_GROUP" >/dev/null || groupadd --system "$BOT_GROUP"
[ "$(getent group "$BOT_GROUP" | cut -d: -f3)" != 0 ] || die "BOT_GROUP must not have GID 0"
if ! id "$BOT_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$BOT_HOME" --gid "$BOT_GROUP" --shell /bin/bash "$BOT_USER"
fi
[ "$(id -u "$BOT_USER")" != 0 ] || die "BOT_USER must not have UID 0"
[ "$(getent passwd "$BOT_USER" | cut -d: -f6)" = "$BOT_HOME" ] || die "existing account home differs from BOT_HOME"
[ "$(id -g "$BOT_USER")" = "$(getent group "$BOT_GROUP" | cut -d: -f3)" ] || die "existing account primary group differs from BOT_GROUP"
if [ -n "$FLAGS_GROUP" ]; then
  getent group "$FLAGS_GROUP" >/dev/null || groupadd --system "$FLAGS_GROUP"
  [ "$(getent group "$FLAGS_GROUP" | cut -d: -f3)" != 0 ] || die "FLAGS_GROUP must not have GID 0"
  usermod --append --groups "$FLAGS_GROUP" "$BOT_USER"
fi

# /home is protected, so the bot cannot replace the home directory entry.
[ "$(stat -c %F -- "$BOT_HOME")" = directory ] || die "REFUSING non-directory BOT_HOME"
[ "$(stat -c %u -- "$BOT_HOME")" = "$(id -u "$BOT_USER")" ] || die "REFUSING home not owned by bot"
chmod 700 "$BOT_HOME"
# Every operation below the home runs with the bot's privileges, including
# creation of intermediate directories. A bot-controlled symlink cannot grant root.
runuser -u "$BOT_USER" -- install -d -m 700 "$RUNTIME"
for p in config data prompts run logs; do
  runuser -u "$BOT_USER" -- install -d -m 700 "$RUNTIME/$p"
done
for p in "$FLAGS_SIGNAL" "$FLAGS_WHATSAPP"; do
  parent=$(dirname -- "$p")
  refuse_symlinks "$parent"
  check_root_path "$parent"
  if [ ! -e "$parent" ]; then
    install -d -o root -g root -m 751 "$parent"
  fi
  check_flags_parent "$p" "$(id -u "$BOT_USER")"
  refuse_symlinks "$p"
  [ ! -e "$p" ] || [ -d "$p" ] || die "REFUSING non-directory flags root $p"
  install -d -o "$BOT_USER" -g "${FLAGS_GROUP:-$BOT_GROUP}" -m 2770 "$p"
  for sub in incoming outgoing archive attachments; do
    runuser -u "$BOT_USER" -- install -d -m 2770 "$p/$sub"
  done
done

for name in daemon.env .env; do
  file=$RUNTIME/config/$name
  if [ -e "$file" ] || [ -L "$file" ]; then
    check_env_file "$file" "$(id -u "$BOT_USER")"
  elif [ "$name" = daemon.env ]; then
    # Noclobber avoids replacing a file created concurrently by the bot.
    runuser -u "$BOT_USER" -- bash -c 'umask 077; set -C; : > "$1"' bash "$file"
    check_env_file "$file" "$(id -u "$BOT_USER")"
  else
    echo "warning: $file missing; populate it before starting" >&2
  fi
done

check_root_path "$WRAPPER_DIR"
install -d -o root -g root -m 755 "$WRAPPER_DIR"
refuse_symlinks "$WRAPPER_DIR/run-daemon.sh"
# Register cleanup before either allocation, including failure of the second.
wrapper= stage=
trap '[ -z "$wrapper" ] || rm -f -- "$wrapper"; [ -z "$stage" ] || rm -rf -- "$stage"' EXIT
wrapper=$(mktemp "$WRAPPER_DIR/.run-daemon.XXXXXX")
stage=$(mktemp -d)
# Atomic replacement avoids truncating an existing hard-linked destination.
install -o root -g root -m 755 "$HERE/run-daemon.sh" "$wrapper"
mv -fT -- "$wrapper" "$WRAPPER_DIR/run-daemon.sh"

for unit in "${UNITS[@]}"; do
  daemon=$unit
  [ "$unit" != kleinbot-signal-cli ] || daemon=signal-cli
  render_unit "$HERE/$unit.service" > "$stage/$unit.service"
  validate_unit "$stage/$unit.service" "$daemon"
done
# All three rendered files are verified together, before replacing any unit.
# The wrapper already exists so verify can check ExecStart on a first install.
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$stage/"*.service
else
  echo "warning: systemd-analyze unavailable; textual unit validation only" >&2
fi
for unit in "${UNITS[@]}"; do
  check_root_path /etc/systemd/system
  refuse_symlinks "/etc/systemd/system/$unit.service"
  install -o root -g root -m 644 "$stage/$unit.service" "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable "${UNITS[@]/%/.service}"
if [ "$START" -eq 1 ]; then systemctl start "${UNITS[@]/%/.service}"; fi

cat <<EOF
Installed and enabled: ${UNITS[*]}
Runtime: $RUNTIME; checkout: $CHECKOUT
Flags: $FLAGS_SIGNAL and $FLAGS_WHATSAPP (group ${FLAGS_GROUP:-$BOT_GROUP})
Started on this invocation: $START. Enabled services also start at the next boot.
Next steps (see scripts/linux/README.md):
  1. Clone the checkout at $CHECKOUT as $BOT_USER; run npm ci there.
  2. Install Java 25+ (openjdk-25-jre-headless); as $BOT_USER, run scripts/signal-setup.sh.
  3. As $BOT_USER, install Claude Code so that claude is in ~/.local/bin, and put a
     token from 'claude setup-token' in daemon.env as CLAUDE_CODE_OAUTH_TOKEN.
  4. Populate $RUNTIME/config/.env and daemon.env, bot-owned and mode 600.
  5. Stop old daemons before copying data/, prompts/ and the Signal identity.
     Set SIGNAL_CLI_CONFIG_DIR in config/.env for a non-default identity directory.
  6. Re-run this staged installer with the same variables and --start when ready.
     Stop all three units before re-running the installer or copying data.
Logs: journalctl -u kleinbot-signal -u kleinbot-whatsapp -u kleinbot-signal-cli
EOF
