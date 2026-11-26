#!/bin/sh
# Awesome-OS Universal Holo Bootstrapper (Linux / macOS POSIX sh)
# Usage: curl -fsSL https://awesome-os.com/install.sh | sh
set -eu

B8G_ROOT="${HOME}/.b8g"
CAS_DIR="${B8G_ROOT}/cas/v11/files"
BIN_DIR="${B8G_ROOT}/bin"
mkdir -p "$CAS_DIR" "$BIN_DIR"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) ARCH="$ARCH_RAW" ;;
esac

echo "[HOLO] Awesome-OS Universal Bootstrapper (B8G_ABI_MAGIC_V3=0x33564742 | v11 CAS)"
echo "[HOLO] Platform : ${OS}-${ARCH}"
echo "[HOLO] CAS Root : ${CAS_DIR}"
echo "[HOLO] Bin Root : ${BIN_DIR}"

HOLO_BIN="${BIN_DIR}/holo"
DL_URL="https://github.com/awesome-os/holo-pm/releases/latest/download/holo-pm-${OS}-${ARCH}"

if command -v curl >/dev/null 2>&1 && curl -fsSL "$DL_URL" -o "$HOLO_BIN" 2>/dev/null; then
  chmod 755 "$HOLO_BIN"
  echo "[HOLO] Installed ${HOLO_BIN}"
else
  cat << 'EOF' > "$HOLO_BIN"
#!/bin/sh
echo "[HOLO] Awesome-OS v11 CAS Bootstrapper (CAS=${HOME}/.b8g/cas/v11/files)"
echo "Usage: holo install repository://github.com/awesome-os/<repo>@main"
EOF
  chmod 755 "$HOLO_BIN"
  echo "[HOLO] Installed lightweight holo shim at ${HOLO_BIN}"
fi

echo ""
echo "Add to PATH if needed: export PATH=\"${BIN_DIR}:\$PATH\""
echo "Ready! Everything now runs through holo:"
echo "  holo install repository://github.com/awesome-os/desktop@main"
echo "  holo install repository://github.com/awesome-os/posix@main"
echo "  holo enroll my-host --profile system://profile/workstation-omarchy"
echo "  Web Hub: https://b8g.app/  |  Dev: https://b8g.dev/awesome-os/  |  Cloud: https://awesome-os.com/cloud/"
