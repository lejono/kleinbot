#!/usr/bin/env bash
set -euo pipefail

# Install signal-cli native Linux build to ~/.local/lib/signal-cli/
# This avoids the Java dependency entirely.

VERSION="0.13.12"
INSTALL_DIR="$HOME/.local/lib/signal-cli"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/signal"

echo "=== Signal CLI Setup for Kleinbot ==="
echo

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
  ARCH_SUFFIX="x86_64"
elif [ "$ARCH" = "aarch64" ]; then
  ARCH_SUFFIX="aarch64"
else
  echo "Unsupported architecture: $ARCH"
  exit 1
fi

# Download native build
URL="https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-${ARCH_SUFFIX}.tar.gz"
TMPFILE=$(mktemp /tmp/signal-cli-XXXXXX.tar.gz)

echo "Downloading signal-cli v${VERSION} (native Linux, ${ARCH_SUFFIX})..."
curl -fSL "$URL" -o "$TMPFILE"

# Install
echo "Installing to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
tar xzf "$TMPFILE" -C "$INSTALL_DIR" --strip-components=1
rm "$TMPFILE"

# Symlink binary
ln -sf "${INSTALL_DIR}/bin/signal-cli" "${BIN_DIR}/signal-cli"

# Create data directories
echo "Creating data directories..."
mkdir -p "$DATA_DIR/auth" "$DATA_DIR/notes"
mkdir -p "$(cd "$(dirname "$0")/.." && pwd)/data/signal"

echo
echo "=== Installation complete ==="
echo
echo "signal-cli installed to: ${INSTALL_DIR}"
echo "Binary symlinked to: ${BIN_DIR}/signal-cli"
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
