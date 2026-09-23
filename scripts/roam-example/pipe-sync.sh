#!/bin/bash
# Linux: run as the comms account, never root.
set -euo pipefail
umask 077
[ "$(id -u)" != 0 ] || { echo 'run as COMMS_ACCOUNT, never root' >&2; exit 1; }
HERE=$(cd -- "$(dirname -- "$0")" && pwd -P)
. "$HERE/common.sh"
[ "$#" = 1 ] || die 'usage: pipe-sync.sh /absolute/settings.conf'
load_settings "$1"
[ "$(id -u)" != 0 ] && [ "$(id -un)" = "$COMMS_ACCOUNT" ] || die 'run as COMMS_ACCOUNT'
for p in "$COMMS_PIPE_DIR" "$PIPE_KEY" "$PIPE_KNOWN_HOSTS" "$PIPE_LOCK"; do refuse_symlink "$p"; done
for p in "$PIPE_KEY" "$PIPE_KNOWN_HOSTS" "$PIPE_LOCK"; do
  case "$p/" in "$COMMS_PIPE_DIR/"*) die 'credentials and lock must be outside the pipe' ;; esac
  [ ! -e "$p" ] || { [ -f "$p" ] && [ "$(stat -c %h "$p")" = 1 ]; } || die 'expected regular files without hard links'
done
[ "$PIPE_KEY" != "$PIPE_KNOWN_HOSTS" ] && [ "$PIPE_KEY" != "$PIPE_LOCK" ] &&
  [ "$PIPE_KNOWN_HOSTS" != "$PIPE_LOCK" ] || die 'key, known_hosts and lock must differ'
[ -r "$PIPE_KEY" ] && [ "$(stat -c %a "$PIPE_KEY")" = 600 ] &&
  [ "$(stat -c %u "$PIPE_KEY")" = "$(id -u)" ] || die 'SSH private key must be account-owned mode 600'
[ -s "$PIPE_KNOWN_HOSTS" ] && ssh-keygen -F "$ROAM_HOST" -f "$PIPE_KNOWN_HOSTS" >/dev/null ||
  die 'install a host key verified through a trusted channel first'
for p in "$COMMS_PIPE_DIR/inbox" "$COMMS_PIPE_DIR/outbox" "${PIPE_LOCK%/*}"; do missing_dir "$p"; done
# Refuse existing nested links too; never follow or copy links in the pipe.
[ -z "$(find "$COMMS_PIPE_DIR" -type l -print -quit)" ] || die 'symlink inside pipe tree'
exec 9>"$PIPE_LOCK"
flock -n 9 || exit 0
SSH_COMMAND="ssh -F /dev/null -i $PIPE_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PIPE_KNOWN_HOSTS -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o LogLevel=ERROR"
ERROR_FILE=$(mktemp "${PIPE_LOCK%/*}/.pipe-error.XXXXXX")
trap 'rm -f "$ERROR_FILE"' EXIT
run_rsync() {
  local status last
  if rsync -rt --no-links --no-perms --chmod=D700,F600 --timeout=20 \
    --remove-source-files --exclude='*.tmp' --exclude='archive/' \
    -e "$SSH_COMMAND" "$@" 2>"$ERROR_FILE"; then return 0; else status=$?; fi
  # A concurrent consumer may remove a listed file; leave retries to the timer.
  [ "$status" != 24 ] || return 0
  last=$(grep -v '^[[:space:]]*$' "$ERROR_FILE" | tail -n 1 | tr -d '\000-\037\177' | cut -c1-300 || true)
  echo "roam-example: rsync failed (exit $status): $last" >&2
  exit "$status"
}
REMOTE=$ROAM_ACCOUNT@$ROAM_HOST
# Relative remote paths are inside the rrsync restriction root.
# rsync publishes by temporary file and rename: never add --inplace or --delete.
run_rsync --include='*.json' --exclude='*' "$COMMS_PIPE_DIR/inbox/" "$REMOTE:inbox/"
# Transfer all markdown before any JSON flags; keep archives local to the relay.
run_rsync --include='*/' --include='*.md' --exclude='*' "$REMOTE:outbox/" "$COMMS_PIPE_DIR/outbox/"
run_rsync --include='*/' --include='*.json' --exclude='*' "$REMOTE:outbox/" "$COMMS_PIPE_DIR/outbox/"
