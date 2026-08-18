#!/bin/bash
# One-time migration: move data files into per-transport subdirectories.
# Run with the bot stopped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"

echo "Migrating data to per-transport layout..."
echo "Data dir: $DATA_DIR"

# Create new directories
mkdir -p "$DATA_DIR/whatsapp"
mkdir -p "$DATA_DIR/slack/notes"

# Move WhatsApp-specific files
if [ -d "$DATA_DIR/auth" ]; then
  mv "$DATA_DIR/auth" "$DATA_DIR/whatsapp/auth"
  echo "  Moved auth/ -> whatsapp/auth/"
fi

if [ -f "$DATA_DIR/state.json" ]; then
  mv "$DATA_DIR/state.json" "$DATA_DIR/whatsapp/state.json"
  echo "  Moved state.json -> whatsapp/state.json"
fi

if [ -f "$DATA_DIR/pending.json" ]; then
  mv "$DATA_DIR/pending.json" "$DATA_DIR/whatsapp/pending.json"
  echo "  Moved pending.json -> whatsapp/pending.json"
fi

if [ -d "$DATA_DIR/notes" ]; then
  mv "$DATA_DIR/notes" "$DATA_DIR/whatsapp/notes"
  echo "  Moved notes/ -> whatsapp/notes/"
fi

# Shared files stay in place:
#   moltbook-state.json
#   moltbook-journal.md
#   activity.log (created by daemon)

echo "Done. Shared files (moltbook-state.json, moltbook-journal.md) remain in data/."
