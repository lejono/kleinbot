# Roam outbox channels

Set `ROAM_OUTBOX_DIR` on the chat daemon to enable the relay. The built-in
`briefing/` and `research/` folders use `ROAM_BRIEFING_CHAT_JID` and
`ROAM_RESEARCH_CHAT_JID`; unset recipients leave their folders untouched.

To add destinations, set `ROAM_OUTBOX_EXTRA_CHANNELS` in the host environment:

```dotenv
ROAM_OUTBOX_EXTRA_CHANNELS=updates=example-group-id
```

This enables `ROAM_OUTBOX_DIR/updates/`. The folder chooses the audience, and
recipient fields inside flags are ignored. Only the host environment chooses
each folder's recipient.

The value is a comma-separated list of `name=chatId` pairs, with up to eight
accepted entries. Names must match `^[a-z][a-z0-9-]{0,31}$`; `briefing`,
`research` and `archive` are reserved. IDs must contain 1–200 characters, with
no whitespace, commas or control characters. Each pair splits at its first
`=`, preserving `=`, `/` and `+` in base64 IDs. Spaces around commas are
trimmed and empty entries skipped. Invalid entries, duplicate names, an entry
repeating an earlier entry's chat id, and entries beyond the limit each produce one
warning with the one-based position and valid channel name (or `<invalid>`),
never the ID. The first valid entry for a name wins. Invalid entries do not
count toward the limit. An unset or empty variable preserves existing behavior.

The relay creates missing extra-channel folders with mode 0770 despite umask
and refuses symlinked folders and non-directories. Each channel uses the same
flag validation, markdown-only attachment checks, `archive/` folder,
duplicate-ID handling and 48-hour freshness window. Defaults are 20 flags per
sweep and 30 successful sends per rolling hour, independently per channel.
Existing built-in behavior and the built-in outbox writer are unchanged.

See [the complete relay contract](../CLAUDE.md#roam-mode) and commented examples
in [the main environment template](../.env.example),
[Linux](../scripts/linux/daemon.env.example) and
[macOS](../scripts/macos/daemon.env.example). Copy selected settings into the
chat daemon's private runtime environment file; no installer action is needed.
