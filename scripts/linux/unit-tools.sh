#!/bin/bash
# Sourced only from the trusted staging directory; also used by the tests.

# These checks only inspect paths. Never repair bot-owned paths as root.
refuse_symlinks() {
  local p=$1
  while :; do
    [ ! -L "$p" ] || { echo "REFUSING symlink at $p" >&2; return 1; }
    [ "$p" = / ] && break
    p=$(dirname -- "$p")
  done
}

check_root_path() {
  local p=$1
  refuse_symlinks "$p" || return 1
  while :; do
    if [ -e "$p" ]; then
      [ -d "$p" ] && [ "$(stat -c %u -- "$p")" = 0 ] &&
        [ $(( 8#$(stat -c %a -- "$p") & 8#022 )) -eq 0 ] || {
        echo "REFUSING $p: expected a root-owned directory without group/other write access" >&2
        return 1
      }
    fi
    [ "$p" = / ] && break
    p=$(dirname -- "$p")
  done
}

check_stage() {
  local stage=$1 file p
  [ -d "$stage" ] && [ ! -L "$stage" ] &&
    [ $(( 8#$(stat -c %a -- "$stage") & 8#022 )) -eq 0 ] || {
    echo "REFUSING stage directory: symlink, missing, or writable by group/others: $stage" >&2
    return 1
  }
  # Check every file's mode before ownership, including in unprivileged tests.
  for file in install.sh run-daemon.sh unit-tools.sh kleinbot-signal-cli.service kleinbot-signal.service kleinbot-whatsapp.service; do
    p=$stage/$file
    [ -f "$p" ] && [ ! -L "$p" ] &&
      [ $(( 8#$(stat -c %a -- "$p") & 8#022 )) -eq 0 ] || {
      echo "REFUSING untrusted stage file: $p" >&2; return 1;
    }
  done
  check_root_path "$stage" || return 1
  for file in install.sh run-daemon.sh unit-tools.sh kleinbot-signal-cli.service kleinbot-signal.service kleinbot-whatsapp.service; do
    [ "$(stat -c %u -- "$stage/$file")" = 0 ] || {
      echo "REFUSING stage file not owned by root: $stage/$file" >&2; return 1;
    }
  done
}

check_env_file() {
  local file=$1 uid=$2
  refuse_symlinks "$file" || return 1
  [ -f "$file" ] && [ "$(stat -c %u -- "$file")" = "$uid" ] &&
    [ "$(stat -c %a -- "$file")" = 600 ] || {
    echo "REFUSING $file: expected a regular, bot-owned file with mode 600" >&2
    return 1
  }
}

check_flags_parent() {
  local parent uid=$2
  parent=$(dirname -- "$1")
  [ -d "$parent" ] && check_root_path "$parent" || {
    echo "REFUSING flags root $1: parent must be root-owned and not writable by bot UID $uid" >&2
    return 1
  }
  [ "$uid" != 0 ] || return 1
}

validate_settings() {
  local name value
  for name in BOT_USER BOT_GROUP FLAGS_GROUP; do
    value=${!name:-}
    [ "$name" = FLAGS_GROUP ] && [ -z "$value" ] && continue
    [[ "$value" =~ ^[a-z_][a-z0-9_-]*$ ]] && [ "$value" != root ] || {
      echo "invalid dedicated account/group setting: $name" >&2; return 1;
    }
  done
  # Restrict rather than interpolate shell/systemd metacharacters. This also
  # makes the awk substitution literal (no ampersands or backslashes).
  for name in BOT_HOME CHECKOUT RUNTIME WRAPPER_DIR FLAGS_SIGNAL FLAGS_WHATSAPP; do
    value=${!name}
    if [[ ! "$value" =~ ^/[A-Za-z0-9_./-]+$ ]] ||
       [[ "$value" = */ || "$value" = *//* || "$value/" = */./* || "$value/" = */../* ]]; then
      echo "$name must be an absolute path with plain components (letters, digits, _, -, .)" >&2
      return 1
    fi
  done
  [ "$(dirname -- "$BOT_HOME")" = /home ] || {
    echo "BOT_HOME must be directly under the root-owned /home directory" >&2; return 1;
  }
  [[ "$WRAPPER_DIR/" != "$BOT_HOME/"* ]] || {
    echo "WRAPPER_DIR must be outside BOT_HOME" >&2; return 1;
  }
  if [[ "$FLAGS_SIGNAL/" = "$FLAGS_WHATSAPP/"* || "$FLAGS_WHATSAPP/" = "$FLAGS_SIGNAL/"* ]]; then
    echo "transport flags directories must be separate, non-overlapping trees" >&2; return 1
  fi
  for value in "$FLAGS_SIGNAL" "$FLAGS_WHATSAPP"; do
    if [[ "$RUNTIME/" = "$value/"* || "$BOT_HOME/" = "$value/"* || "$CHECKOUT/" = "$value/"* ]]; then
      echo "a flags directory must not contain runtime, home or checkout" >&2; return 1
    fi
    for name in "$WRAPPER_DIR" /etc/systemd/system "${HERE:-/}"; do
      if [[ "$name/" = "$value/"* ]]; then
        echo "flags must not contain the wrapper, system units, or installer stage" >&2; return 1
      fi
    done
    for name in config data prompts run logs; do
      if [[ "$value/" = "$RUNTIME/$name/"* ]]; then
        echo "flags must be outside the private runtime subdirectories" >&2; return 1
      fi
    done
  done
}

render_unit() {
  awk -v user="$BOT_USER" -v group="$BOT_GROUP" -v runtime="$RUNTIME" \
    -v home="$BOT_HOME" -v wrapper="$WRAPPER_DIR" -v checkout="$CHECKOUT" -v signal="$FLAGS_SIGNAL" -v whatsapp="$FLAGS_WHATSAPP" '
    {
      gsub(/@BOT_HOME@/, home); gsub(/@WRAPPER_DIR@/, wrapper)
      gsub(/@BOT_USER@/, user); gsub(/@BOT_GROUP@/, group)
      gsub(/@RUNTIME@/, runtime); gsub(/@CHECKOUT@/, checkout)
      gsub(/@FLAGS_SIGNAL@/, signal); gsub(/@FLAGS_WHATSAPP@/, whatsapp)
      if ($0 ~ /@[A-Za-z_][A-Za-z0-9_]*@/) exit 1
      print
    }
  ' "$1"
}

validate_unit() {
  local file=$1 daemon=$2
  # Fail closed on additional directives, duplicate identity/exec fields, and
  # privileged exec prefixes. Required protections must also be present.
  awk -v user="$BOT_USER" -v group="$BOT_GROUP" \
    -v command="$WRAPPER_DIR/run-daemon.sh $daemon" -v checkout="$CHECKOUT" '
    /^[[:space:]]*($|#|;)/ { next }
    /^\[(Unit|Service|Install)\]$/ { section=$0; next }
    {
      if ($0 ~ /\\$/) exit 1
      key=$0; sub(/=.*/, "", key)
      value=substr($0, length(key)+2)
      if (section == "[Service]") {
        seen[key]++
        if (key == "User") { if (value != user || ++users != 1) exit 1 }
        else if (key == "Group") { if (value != group || ++groups != 1) exit 1 }
        else if (key == "ExecStart") { if (value != command || ++commands != 1) exit 1 }
        else if (key == "WorkingDirectory") { if (value != checkout || ++dirs != 1) exit 1 }
        else if (key == "Environment") {
          # Inspect every assignment, including multiple quoted assignments on
          # one line. Do not print the value when rejecting a possible secret.
          rest=value
          while (match(rest, /[A-Za-z_][A-Za-z0-9_]*=/)) {
            name=substr(rest, RSTART, RLENGTH-1)
            if (toupper(name) ~ /(_TOKEN$|_KEY$|PASSWORD)/) exit 1
            rest=substr(rest, RSTART+RLENGTH)
          }
        }
        else if (key ~ /^(StandardOutput|StandardError)$/) { if (value != "journal") exit 1 }
        else if (key ~ /^(NoNewPrivileges|PrivateTmp|ProtectKernelTunables|ProtectControlGroups|RestrictSUIDSGID)$/) { if (value != "yes") exit 1 }
        else if (key == "Type") { if (value != "simple") exit 1 }
        else if (key == "Restart") { if (value != "always") exit 1 }
        else if (key == "RestartSec") { if (value != "30") exit 1 }
        else if (key == "ProtectSystem") { if (value != "full") exit 1 }
        else if (key == "UMask") { if (value != "0007") exit 1 }
        else exit 1
      } else if (section == "[Unit]") {
        if (key !~ /^(Description|Wants|After|Requires|StartLimitIntervalSec)$/) exit 1
      } else if (section == "[Install]") {
        if (key != "WantedBy") exit 1
      } else exit 1
    }
    END {
      if (users != 1 || groups != 1 || commands != 1 || dirs != 1) exit 1
      if (seen["NoNewPrivileges"] != 1 || seen["PrivateTmp"] != 1 ||
          seen["ProtectSystem"] != 1 || seen["Restart"] != 1 || seen["UMask"] != 1) exit 1
    }
  ' "$file" || { echo "REFUSING $file: unsafe or unexpected unit content" >&2; return 1; }
}

# A setting as the wrapper reads it from the env files: daemon.env before .env, first
# occurrence wins, CR and one layer of matching quotes removed, an empty value counts as
# set. The units set neither key read here, so the files are the only source.
# Arguments: key, runtime. Prints the value, or fails when the key is absent.
env_file_setting() {
  local key=$1 runtime=$2 file line value
  for file in "$runtime/config/daemon.env" "$runtime/config/.env"; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      case "$line" in 'export '*) line=${line#export } ;; esac
      case "$line" in "$key="*) ;; *) continue ;; esac
      value=${line#*=}
      case "$value" in
        \"*\") value=${value#\"}; value=${value%\"} ;;
        \'*\') value=${value#\'}; value=${value%\'} ;;
      esac
      printf '%s\n' "$value"
      return 0
    done < "$file"
  done
  return 1
}

# Resolves a command as a unit would run it: an absolute path as is, a relative path
# against the working directory (the checkout), a bare name on the unit PATH.
# READY_SYSTEM_BIN_DIRS mirrors the system part of the unit PATH (overridable for tests).
# Arguments: command, bot home, checkout. Prints the executable, or fails.
resolve_unit_command() {
  local cmd=$1 home=$2 checkout=$3 dir candidate
  case "$cmd" in
    '') return 1 ;;
    /*) candidate=$cmd ;;
    */*) candidate=$checkout/$cmd ;;
    *)
      for dir in "$home/.local/bin" ${READY_SYSTEM_BIN_DIRS-/usr/local/bin /usr/bin /bin}; do
        if [ -x "$dir/$cmd" ] && [ ! -d "$dir/$cmd" ]; then printf '%s\n' "$dir/$cmd"; return 0; fi
      done
      return 1 ;;
  esac
  if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  return 1
}

# Preflight for --start. The units run the chat model command, signal-cli and tsx; if one
# is missing the daemons still start but every reply or connection fails at runtime.
# Arguments: bot home, checkout, runtime. Only reads and inspects paths; prints every
# problem, then fails once.
check_start_ready() {
  local home=$1 checkout=$2 runtime=$3 missing=0 claude signal_cli token config_dir
  # The bot runs process.env.CLAUDE_BIN || "claude": an empty value means claude.
  claude=$(env_file_setting CLAUDE_BIN "$runtime") || claude=""
  claude=${claude:-claude}
  if ! resolve_unit_command "$claude" "$home" "$checkout" >/dev/null; then
    echo "not ready: chat model command '$claude' (CLAUDE_BIN, default claude) is not an executable on the unit PATH; install Claude Code as the bot account" >&2
    missing=1
  fi
  # The wrapper keeps an empty SIGNAL_CLI_BIN and then cannot run it.
  signal_cli=$(env_file_setting SIGNAL_CLI_BIN "$runtime") || signal_cli=$home/.local/bin/signal-cli
  if ! resolve_unit_command "$signal_cli" "$home" "$checkout" >/dev/null; then
    echo "not ready: signal-cli '$signal_cli' (SIGNAL_CLI_BIN) is not an executable; run scripts/signal-setup.sh as the bot account" >&2
    missing=1
  fi
  if [ ! -x "$checkout/node_modules/.bin/tsx" ]; then
    echo "not ready: $checkout/node_modules/.bin/tsx missing; run npm ci (with dev dependencies) as the bot account" >&2
    missing=1
  fi
  token=$(env_file_setting CLAUDE_CODE_OAUTH_TOKEN "$runtime") || token=""
  [ -n "$token" ] || token=$(env_file_setting ANTHROPIC_API_KEY "$runtime") || token=""
  config_dir=$(env_file_setting CLAUDE_CONFIG_DIR "$runtime") || config_dir=""
  if [ -z "$token" ] && [ ! -e "${config_dir:-$home/.claude}/.credentials.json" ]; then
    echo "warning: no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the env files and no Claude login for the bot; replies fail until one exists" >&2
  fi
  return "$missing"
}
