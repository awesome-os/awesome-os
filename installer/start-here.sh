#!/usr/bin/env sh
# AwesomeOS — Zero-Node Idempotent Desktop & v11 CAS Launcher (Linux / macOS)
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SHELL_TARGET="$SCRIPT_DIR/shell/awesomeos-shell.html"
[ -f "$SHELL_TARGET" ] || SHELL_TARGET="https://awesome-os.com/shell/"

if command -v sectium-browser >/dev/null 2>&1; then
  exec sectium-browser "--app=$SHELL_TARGET"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$SHELL_TARGET" >/dev/null 2>&1 &
  exit 0
elif command -v open >/dev/null 2>&1; then
  open "$SHELL_TARGET"
  exit 0
fi

echo "Bootstrapping AwesomeOS v11 CAS via https://awesome-os.com/install.sh ..."
curl -fsSL https://awesome-os.com/install.sh | sh
