#!/bin/bash
# Fragment only: no code/tool installation, secrets, or service startup.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
fail() { echo "roam-example: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(id -u)" = 0 ] || fail 'run the staged copy as root on macOS'
[ "$#" = 0 ] || fail 'edit staged settings.conf; no arguments accepted'
# Bootstrap trust before sourcing anything. Invoke with an absolute path.
root_owned() {
  local p=$1 mode
  [[ "$p" =~ ^(/[A-Za-z0-9_.-]+)+$ ]] || fail 'use simple absolute staged paths'
  case "$p/" in */../*|*/./*) fail 'dot components refused' ;; esac
  while :; do
    [ ! -L "$p" ] && [ -e "$p" ] && [ "$(stat -f %u "$p")" = 0 ] || fail 'stage and ancestors must be root-owned, without symlinks'
    mode=$(stat -f %Lp "$p")
    [ "$((8#$mode & 022))" = 0 ] || fail 'stage must not be group/other writable'
    [ "$p" = / ] && break
    p=${p%/*}; p=${p:-/}
  done
}
root_owned "$0"
HERE=${0%/*}
for f in common.sh settings.conf pipe.pub rrsync.source; do
  root_owned "$HERE/$f"
  [ -f "$HERE/$f" ] || fail 'stage inputs must be regular files'
done
. "$HERE/common.sh"
load_settings "$HERE/settings.conf"
[ "$ROAM_HOME" = "/Users/$ROAM_ACCOUNT" ] || die 'ROAM_HOME must be directly under /Users and match the account'
for p in "$ROAM_RUNTIME" "$PIPE_DIR"; do
  case "$p" in "$ROAM_HOME/"*) ;; *) die 'runtime and pipe must be below ROAM_HOME' ;; esac
  refuse_symlink "$p"
done
case "$PIPE_DIR/" in "$ROAM_RUNTIME/"*) die 'pipe must be outside runtime' ;; esac
case "$ROAM_RUNTIME/" in "$PIPE_DIR/"*) die 'runtime must be outside pipe' ;; esac
root_owned /Users
record=/Users/$ROAM_ACCOUNT
if id "$ROAM_ACCOUNT" >/dev/null 2>&1; then
  [ "$(dscl . -read "$record" NFSHomeDirectory)" = "NFSHomeDirectory: $ROAM_HOME" ] || die 'existing home differs'
  [ "$(id -u "$ROAM_ACCOUNT")" -ge 600 ] && [ "$(id -g "$ROAM_ACCOUNT")" = 20 ] || die 'existing account must be a dedicated staff account with UID at least 600'
  case " $(id -Gn "$ROAM_ACCOUNT") " in *' admin '*) die 'account must not be admin' ;; esac
else
  [ ! -e "$ROAM_HOME" ] || die 'refusing to adopt an existing home'
  next_uid=600
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$next_uid"; do next_uid=$((next_uid + 1)); done
  dscl . -create "$record"
  dscl . -create "$record" UniqueID "$next_uid"
  dscl . -create "$record" PrimaryGroupID 20
  dscl . -create "$record" NFSHomeDirectory "$ROAM_HOME"
  dscl . -create "$record" UserShell /bin/bash
  dscl . -create "$record" Password '*'
  dscl . -create "$record" IsHidden 1
fi
refuse_symlink "$ROAM_HOME"
if [ ! -e "$ROAM_HOME" ]; then
  mkdir "$ROAM_HOME"
  chown "$ROAM_ACCOUNT":staff "$ROAM_HOME"
fi
[ -d "$ROAM_HOME" ] && [ "$(stat -f '%Su %Lp' "$ROAM_HOME")" = "$ROAM_ACCOUNT 700" ] || die 'home must be account-owned mode 700'
# Keep the current Remote Login allowlist; require explicit admin provisioning.
# Creating that group here could unexpectedly deny SSH access to other accounts.
if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
  dseditgroup -o edit -a "$ROAM_ACCOUNT" -t user com.apple.access_ssh
fi
version=$(sudo -u "$ROAM_ACCOUNT" -H "$RSYNC_BIN" --version)
case "$version" in 'rsync  version 3.'*) ;; *) die 'RSYNC_BIN must be Homebrew rsync 3.x' ;; esac
[ "$(grep -c '^RSYNC = ' "$HERE/rrsync.source")" = 1 ] || die 'unexpected rrsync source layout'
grep -qx "RSYNC = '/usr/bin/rsync'" "$HERE/rrsync.source" || die 'review changed rrsync source before adapting this patch'
refuse_symlink "$HERE/rrsync"
[ ! -e "$HERE/rrsync" ] || { root_owned "$HERE/rrsync"; [ -f "$HERE/rrsync" ]; }
patched=$(mktemp "$HERE/.rrsync.XXXXXX")
key_line=$(mktemp "$HERE/.authorized-key.XXXXXX")
trap 'rm -f "$patched" "$key_line"' EXIT
sed "s|^RSYNC = '/usr/bin/rsync'\$|RSYNC = '$RSYNC_BIN'|" "$HERE/rrsync.source" > "$patched"
grep -qxF "RSYNC = '$RSYNC_BIN'" "$patched" || die 'rrsync rewrite failed'
chown root:wheel "$patched"
chmod 755 "$patched"
mv -f "$patched" "$HERE/rrsync"
root_owned "$HERE/rrsync"
help=$(sudo -u "$ROAM_ACCOUNT" -H "$HERE/rrsync" -help 2>&1 || true)
case "$help" in *-munge*) ;; *) die 'rrsync must support -munge; check its interpreter too' ;; esac
[ "$(awk 'NF {n++} END {print n+0}' "$HERE/pipe.pub")" = 1 ] || die 'supply exactly one public key'
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( |$)' "$HERE/pipe.pub" || die 'supply a plain Ed25519 public key without options'
ssh-keygen -l -f "$HERE/pipe.pub" >/dev/null
# Drop comments; install only the restricted transfer key, no admin login key.
printf 'restrict,command="%s -munge %s" %s\n' "$HERE/rrsync" "$PIPE_DIR" "$(awk 'NF {print $1, $2}' "$HERE/pipe.pub")" > "$key_line"
# All writes below the bot-owned home run without root privileges.
sudo -u "$ROAM_ACCOUNT" -H /bin/bash -c '
  set -euo pipefail
  umask 077
  . "$1/common.sh"
  for p in "$2" "$2/config" "$2/data" "$2/prompts" "$2/logs" "$2/run" "$2/tmp" "$2/research-wiki" "$3/inbox" "$3/outbox/briefing" "$3/outbox/research" "$4/.ssh"; do missing_dir "$p"; done
  auth=$4/.ssh/authorized_keys
  refuse_symlink "$auth"
  if [ -e "$auth" ]; then
    [ -f "$auth" ] && [ "$(stat -f "%Su %Lp %l" "$auth")" = "$(id -un) 600 1" ] || die "unsafe existing authorized_keys"
    cmp -s "$auth" - || die "existing authorized_keys differs; review it manually"
  else
    (set -C; cat > "$auth")
  fi
' bash "$HERE" "$ROAM_RUNTIME" "$PIPE_DIR" "$ROAM_HOME" < "$key_line"
echo 'Account, directories and restricted transfer key prepared; no service started.'
