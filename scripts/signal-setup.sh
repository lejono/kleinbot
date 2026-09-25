#!/usr/bin/env bash
set -euo pipefail

# Install the signal-cli JVM build to ~/.local/opt/signal-cli-<version>/ and link it as
# ~/.local/bin/signal-cli (the default the units run). Needs a Java runtime, version 25+
# for 0.14.x; on Ubuntu 24.04: sudo apt install openjdk-25-jre-headless.
# The native (GraalVM) build needs no Java but can crash-loop with StackOverflowError when a
# client connects (AsamK/signal-cli#2113, not fixed as of 0.14.8), so it is not used.

# Keep VERSION at or above the release that last used an existing Signal data directory.
# An older signal-cli on newer data fails to decrypt every incoming message
# ("getServerGuid(...) must not be null") and loses it. SHA256 is of the release tarball,
# checked against its GPG signature (AsamK, key FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570);
# update both together.
VERSION="0.14.6"
SHA256="e90f4faea709b3c0a55909646a2b94289b9779ba9c8fd5c6eaa847d3f67312eb"
JAVA_MIN=25
OPT_DIR="$HOME/.local/opt"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/signal"

echo "=== Signal CLI Setup for Kleinbot ==="
echo

java_major=$( (java -version 2>&1 || true) | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)
if [ -z "$java_major" ] || [ "$java_major" -lt "$JAVA_MIN" ]; then
  echo "signal-cli ${VERSION} needs Java ${JAVA_MIN} or newer on PATH (found: ${java_major:-none})." >&2
  echo "On Ubuntu 24.04: sudo apt install openjdk-${JAVA_MIN}-jre-headless" >&2
  exit 1
fi

URL="https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz"
TMPDIR_SC=$(mktemp -d)
trap 'rm -rf "$TMPDIR_SC"' EXIT

echo "Downloading signal-cli v${VERSION} (JVM build)..."
curl -fSL "$URL" -o "$TMPDIR_SC/signal-cli.tar.gz"
echo "${SHA256}  ${TMPDIR_SC}/signal-cli.tar.gz" | sha256sum -c - || { echo "Checksum mismatch; not installing." >&2; exit 1; }

# Install: unpack beside any previous version, then point the link at it.
echo "Installing to ${OPT_DIR}/signal-cli-${VERSION}, linked from ${BIN_DIR}/signal-cli..."
mkdir -p "$OPT_DIR" "$BIN_DIR"
tar xzf "$TMPDIR_SC/signal-cli.tar.gz" -C "$TMPDIR_SC"
rm -rf "${OPT_DIR}/signal-cli-${VERSION}"
mv "$TMPDIR_SC/signal-cli-${VERSION}" "${OPT_DIR}/signal-cli-${VERSION}"
ln -sfn "${OPT_DIR}/signal-cli-${VERSION}/bin/signal-cli" "${BIN_DIR}/signal-cli"
"${BIN_DIR}/signal-cli" --version

# Create data directories
echo "Creating data directories..."
mkdir -p "$DATA_DIR/auth" "$DATA_DIR/notes"
mkdir -p "$(cd "$(dirname "$0")/.." && pwd)/data/signal"

echo
echo "=== Installation complete ==="
echo
echo "signal-cli installed to: ${OPT_DIR}/signal-cli-${VERSION} (run as ${BIN_DIR}/signal-cli)"
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
