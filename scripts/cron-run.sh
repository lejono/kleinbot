#!/bin/bash
# Run Kleinbot as a foreground process (for systemd or manual use)
set -e
cd "$(dirname "$0")/.."
exec npx tsx src/index.ts
