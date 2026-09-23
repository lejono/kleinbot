#!/usr/bin/env bash
set -euo pipefail

# Install signal-cli native Linux build to ~/.local/lib/signal-cli/
# This avoids the Java dependency entirely.

# Keep VERSION at or above the release that last used an existing Signal data directory.
# An older signal-cli on newer data fails to decrypt every incoming message
# ("getServerGuid(...) must not be null") and loses it. SHA256 is of the release tarball,
# checked against its GPG signature (AsamK, key FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570);
# update both together.
VERSION="0.14.6"
SHA256="c78639c2d3c14cd004872a99ecf129bd7d7c26ee7d9844d50c2b0afdafefea68"
INSTALL_DIR="$HOME/.local/lib/signal-cli"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/signal"

echo "=== Signal CLI Setup for Kleinbot ==="
echo

# Download native Linux build (x86_64 only, built with GraalVM — no Java needed)
URL="https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
TMPFILE=$(mktemp /tmp/signal-cli-XXXXXX.tar.gz)

echo "Downloading signal-cli v${VERSION} (native Linux)..."
curl -fSL "$URL" -o "$TMPFILE"
echo "${SHA256}  ${TMPFILE}" | sha256sum -c - || { rm -f "$TMPFILE"; echo "Checksum mismatch; not installing." >&2; exit 1; }

# Install
echo "Installing to ${BIN_DIR}/signal-cli..."
mkdir -p "$BIN_DIR"
tar xzf "$TMPFILE" -C "$BIN_DIR"
chmod +x "${BIN_DIR}/signal-cli"
rm "$TMPFILE"

# Create data directories
echo "Creating data directories..."
mkdir -p "$DATA_DIR/auth" "$DATA_DIR/notes"
mkdir -p "$(cd "$(dirname "$0")/.." && pwd)/data/signal"

echo
echo "=== Installation complete ==="
echo
echo "signal-cli installed to: ${BIN_DIR}/signal-cli"
echo
echo "Next steps:"
echo
echo "  1. Register your Signal number:"
echo "     signal-cli -a +44XXXXXXXXXX register"
echo
echo "  2. Verify with the SMS code:"
echo "     signal-cli -a +44XXXXXXXXXX verify CODE"
echo
echo "  3. Install the systemd service:"
echo "     cp scripts/signal-cli.service ~/.config/systemd/user/"
echo "     Edit the service file: set your phone number"
echo "     systemctl --user daemon-reload"
echo "     systemctl --user enable --now signal-cli"
echo
echo "  4. Add to .env:"
echo "     SIGNAL_ACCOUNT=+44XXXXXXXXXX"
echo "     SIGNAL_ADMIN_NUMBER=+44YYYYYYYYYY"
echo
echo "  5. Start Kleinbot:"
echo "     npm run start:signal"
