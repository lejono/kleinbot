# Contributing — filing bugs and feature requests

Two channels, picked by weight:

- **Small, self-contained items** → `TODO.md` (Feature Requests / Bugs sections).
  One bullet each: what's wrong or wanted, where the code is (file:line), and a
  pointer to any fuller writeup. Strike through when done.
- **Anything needing evidence or a design argument** → a dated file in
  `docs/bugs/` named `YYYY-MM-DD-short-slug.md`, with a `Status:` line near the
  top (`Status: open` / `Status: fixed YYYY-MM-DD (commit ...)` /
  `Status: wontfix — reason`). The open queue is
  `grep -l "^Status: open" docs/bugs/*.md`. Sections that make a report useful:
  what happened (with the log lines that show it), expected behaviour, where the
  code is, what "fixed" looks like, and what surfaced it.

Write for someone with no context. Absolute dates, never "yesterday". Distinguish
what you verified from what you suspect.

**This repo is public.** No real phone numbers, JIDs, group IDs, chat names, or
personal file paths in any report — describe the shape of the data, not the data.
The same goes for prose: a report must describe the software, never its operator
or users (no real incidents' personal texture, quoted messages, schedules, or
usage patterns — see the Privacy section of `CLAUDE.md`). If a report needs that
evidence to make sense, it belongs in the operator's private notes, with only a
sanitized version here. Items that span the wider team system belong in the
private team repo's backlog, not here.
