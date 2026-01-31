#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Installing dependencies..."
npm install

echo "Creating data directories..."
mkdir -p data/auth

echo ""
echo "Setup complete. Next steps:"
echo "1. Edit .env and set GROUP_JID (you'll get this from logs on first run)"
echo "2. Run 'npx tsx src/index.ts' to pair via QR code"
echo "3. Once paired, set up the cron job with: crontab -e"
echo "   */5 * * * * $(pwd)/scripts/cron-run.sh >> $(pwd)/data/cron.log 2>&1"
