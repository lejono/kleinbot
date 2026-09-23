#!/bin/bash
# Shared by the examples; Bash 3.2 compatible. Settings are data, never sourced.
die() { echo "roam-example: $*" >&2; exit 1; }
absolute_path() {
  [[ "$1" =~ ^(/[A-Za-z0-9_.-]+)+$ ]] || die 'use simple absolute paths'
  case "$1/" in */../*|*/./*) die 'dot path components are refused' ;; esac
}
refuse_symlink() {
  local p=$1
  absolute_path "$p"
  while [ "$p" != / ]; do
    [ ! -L "$p" ] || die "symlink refused: $p"
    p=${p%/*}; p=${p:-/}
  done
}
load_settings() {
  local line key value seen='|'
  refuse_symlink "$1"
  [ -f "$1" ] && [ -r "$1" ] || die 'settings must be a readable regular file'
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" = *=* ]] || die 'settings must use KEY=value'
    key=${line%%=*}; value=${line#*=}
    case "$key" in
      ROAM_HOST|ROAM_ACCOUNT|COMMS_ACCOUNT|ROAM_HOME|ROAM_RUNTIME|PIPE_DIR|COMMS_PIPE_DIR|PIPE_KEY|PIPE_KNOWN_HOSTS|PIPE_LOCK|RSYNC_BIN) ;;
      *) die 'unknown settings key' ;;
    esac
    case "$seen" in *"|$key|"*) die 'duplicate settings key' ;; esac
    seen="$seen$key|"
    [ -n "$value" ] || die "empty setting: $key"
    printf -v "$key" '%s' "$value"
  done < "$1"
  for key in ROAM_HOST ROAM_ACCOUNT COMMS_ACCOUNT ROAM_HOME ROAM_RUNTIME PIPE_DIR COMMS_PIPE_DIR PIPE_KEY PIPE_KNOWN_HOSTS PIPE_LOCK RSYNC_BIN; do
    case "$seen" in *"|$key|"*) ;; *) die "missing setting: $key" ;; esac
  done
  [[ "$ROAM_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die 'use a DNS hostname'
  for value in "$ROAM_ACCOUNT" "$COMMS_ACCOUNT"; do
    [[ "$value" =~ ^[a-z][a-z0-9_-]*$ ]] && [ "$value" != root ] || die 'use non-root service account names'
  done
  [ "$ROAM_ACCOUNT" != "$COMMS_ACCOUNT" ] || die 'use separate service accounts'
  for value in "$ROAM_HOME" "$ROAM_RUNTIME" "$PIPE_DIR" "$COMMS_PIPE_DIR" "$PIPE_KEY" "$PIPE_KNOWN_HOSTS" "$PIPE_LOCK" "$RSYNC_BIN"; do
    absolute_path "$value"
  done
}
# Called only as the service account. Preserve existing shared-directory modes.
missing_dir() {
  refuse_symlink "$1"
  if [ ! -e "$1" ]; then mkdir -p "$1"; fi
  [ -d "$1" ] || die "not a directory: $1"
}
