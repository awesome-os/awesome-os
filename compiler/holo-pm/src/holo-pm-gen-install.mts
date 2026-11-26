/**
 * @file src/holo-pm-gen-install.mts
 * @description Sovereign zero-dependency installer & C11 Splash Layout generator for `holo-pm`.
 *
 * Generates:
 *   1. `install.ps1`     — Strictly UTF-8 BOM-free, zero top-level `param(...)` PowerShell installer
 *                          (`irm ... | iex` safe) backed by `v11/files/<sha512[:2]>/<sha512>-exec`
 *                          CAS storage, SHA-512 verification, and 0-byte HardLink projection.
 *   2. `install.sh`      — POSIX `sh` installer backed by the same `v11/files/` CAS layout,
 *                          `sha512sum` / `shasum -a 512` verification, and `ln -f` hardlink projection.
 *   3. `splash_layout.h` — C11 header stamping `AWESOME_APP_ID`, `AWESOME_APP_VERSION`,
 *                          `B8G_ABI_MAGIC_V3` (`0x33564742`), and centered 460x220 DPI-aware
 *                          coordinates for native Ghost/Splash binaries.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only, zero external dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export interface GenInstallSpec {
  readonly id: string;
  readonly displayName: string;
  readonly repo: string;
  readonly version: string;
  readonly binaryName: string;
  readonly downloadBaseUrl?: string;
  readonly isGui?: boolean;
  readonly splashTitle?: string;
  readonly splashSubtitle?: string;
}

export interface InstallerBundleReceipt {
  readonly outDir: string;
  readonly files: readonly string[];
}

function normalizeVersionTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function resolveDownloadBaseUrl(spec: GenInstallSpec): string {
  if (spec.downloadBaseUrl && spec.downloadBaseUrl.trim().length > 0) {
    return spec.downloadBaseUrl.trim().replace(/\/+$/, '');
  }
  const tag = normalizeVersionTag(spec.version);
  return `https://github.com/${spec.repo}/releases/download/${tag}`;
}

function escapePsSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeShSingleQuoted(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function escapeCString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function ensureWinExeName(binaryName: string): string {
  return binaryName.toLowerCase().endsWith('.exe') ? binaryName : `${binaryName}.exe`;
}

/**
 * Generates a strictly UTF-8 BOM-free, zero top-level `param(...)` PowerShell installer
 * safe for `irm <url> | iex` execution.
 */
export function renderHoloInstallPs1(spec: GenInstallSpec): string {
  const baseUrl = resolveDownloadBaseUrl(spec);
  const winBin = ensureWinExeName(spec.binaryName);
  const id = escapePsSingleQuoted(spec.id);
  const displayName = escapePsSingleQuoted(spec.displayName);
  const repo = escapePsSingleQuoted(spec.repo);
  const version = escapePsSingleQuoted(spec.version);
  const binName = escapePsSingleQuoted(winBin);
  const urlBase = escapePsSingleQuoted(baseUrl);
  const isGuiFlag = spec.isGui ? '$true' : '$false';

  const lines = [
    `# Awesome-OS Sovereign Installer — ${spec.displayName} (${spec.id}) v${spec.version}`,
    `# ABI Magic: ${B8G_ABI_MAGIC_V3} | Repo: ${spec.repo}`,
    `# Safe for: irm <url> | iex (UTF-8 without BOM, zero top-level argument block)`,
    `$ErrorActionPreference = 'Stop'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    ``,
    `$HoloAppId = '${id}'`,
    `$HoloDisplayName = '${displayName}'`,
    `$HoloRepo = '${repo}'`,
    `$HoloVersion = '${version}'`,
    `$HoloBinaryName = '${binName}'`,
    `$HoloBaseUrl = '${urlBase}'`,
    `$HoloIsGui = ${isGuiFlag}`,
    `$HoloAbiMagic = '${B8G_ABI_MAGIC_V3}'`,
    ``,
    `$HoloCasDir = if ($env:HOLO_CAS_DIR) { $env:HOLO_CAS_DIR } elseif ($env:B8G_GHOST_CACHE_DIR) { $env:B8G_GHOST_CACHE_DIR } else { Join-Path $HOME '.b8g\\cas' }`,
    `$HoloInstallDir = if ($env:HOLO_INSTALL_DIR) { $env:HOLO_INSTALL_DIR } else { Join-Path $HOME '.b8g\\bin' }`,
    ``,
    `$ArchRaw = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()`,
    `$TargetArch = if ($ArchRaw -eq 'arm64') { 'aarch64-windows' } else { 'x86_64-windows' }`,
    `$AssetName = "$HoloAppId-$TargetArch.exe"`,
    `$DownloadUrl = "$HoloBaseUrl/$AssetName"`,
    `$SumsUrl = "$HoloBaseUrl/SHA512SUMS.txt"`,
    ``,
    `Write-Host "[$HoloDisplayName] Installing v$HoloVersion ($TargetArch) [ABI $HoloAbiMagic]..."`,
    `New-Item -ItemType Directory -Force -Path $HoloInstallDir | Out-Null`,
    ``,
    `$TmpFile = Join-Path ([System.IO.Path]::GetTempPath()) ("$HoloAppId-" + [System.Guid]::NewGuid().ToString('N') + ".tmp")`,
    `try {`,
    `  Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpFile -UseBasicParsing`,
    `  $ActualSha512 = (Get-FileHash -Path $TmpFile -Algorithm SHA512).Hash.ToLowerInvariant()`,
    ``,
    `  $ExpectedSha512 = $env:HOLO_EXPECTED_SHA512`,
    `  if (-not $ExpectedSha512) {`,
    `    try {`,
    `      $SumsContent = (Invoke-WebRequest -Uri $SumsUrl -UseBasicParsing).Content`,
    `      foreach ($Line in ($SumsContent -split "\`r?\`n")) {`,
    `        if ($Line -match '^([0-9a-fA-F]{128})\\s+\\*?(.+)$') {`,
    `          if ($Matches[2].Trim() -eq $AssetName -or $Matches[2].Trim() -eq $HoloBinaryName) {`,
    `            $ExpectedSha512 = $Matches[1].ToLowerInvariant()`,
    `            break`,
    `          }`,
    `        }`,
    `      }`,
    `    } catch {`,
    `      # Optional SHA512SUMS.txt unavailable; proceed with computed CAS digest.`,
    `    }`,
    `  }`,
    ``,
    `  if ($ExpectedSha512 -and ($ActualSha512 -ne $ExpectedSha512.ToLowerInvariant())) {`,
    `    throw "SHA-512 verification failed for $AssetName (expected $ExpectedSha512, got $ActualSha512)"`,
    `  }`,
    ``,
    `  $Prefix = $ActualSha512.Substring(0, 2)`,
    `  $CasBucketDir = Join-Path $HoloCasDir ("v11/files/$Prefix")`,
    `  New-Item -ItemType Directory -Force -Path $CasBucketDir | Out-Null`,
    `  $CasObjectPath = Join-Path $CasBucketDir "$ActualSha512-exec"`,
    ``,
    `  if (-not (Test-Path -LiteralPath $CasObjectPath)) {`,
    `    Move-Item -LiteralPath $TmpFile -Destination $CasObjectPath -Force`,
    `  } else {`,
    `    Remove-Item -LiteralPath $TmpFile -Force -ErrorAction SilentlyContinue`,
    `  }`,
    ``,
    `  $DestPath = Join-Path $HoloInstallDir $HoloBinaryName`,
    `  if (Test-Path -LiteralPath $DestPath) {`,
    `    Remove-Item -LiteralPath $DestPath -Force`,
    `  }`,
    ``,
    `  try {`,
    `    New-Item -ItemType HardLink -Path $DestPath -Target $CasObjectPath | Out-Null`,
    `  } catch {`,
    `    Copy-Item -LiteralPath $CasObjectPath -Destination $DestPath -Force`,
    `  }`,
    ``,
    `  Write-Host "[$HoloDisplayName] Projected -> $DestPath (CAS v11/files/$Prefix/$ActualSha512-exec, GUI=$HoloIsGui)"`,
    `} finally {`,
    `  if (Test-Path -LiteralPath $TmpFile) {`,
    `    Remove-Item -LiteralPath $TmpFile -Force -ErrorAction SilentlyContinue`,
    `  }`,
    `}`,
    ``,
  ];

  return stripLeadingBom(lines.join('\n'));
}

/**
 * Generates a POSIX `sh` installer backed by the same `v11/files/<sha512[:2]>/<sha512>-exec`
 * CAS layout, SHA-512 verification (`sha512sum` / `shasum -a 512`), and `ln -f` hardlink projection.
 */
export function renderHoloInstallSh(spec: GenInstallSpec): string {
  const baseUrl = resolveDownloadBaseUrl(spec);
  const id = escapeShSingleQuoted(spec.id);
  const displayName = escapeShSingleQuoted(spec.displayName);
  const repo = escapeShSingleQuoted(spec.repo);
  const version = escapeShSingleQuoted(spec.version);
  const binName = escapeShSingleQuoted(spec.binaryName);
  const urlBase = escapeShSingleQuoted(baseUrl);
  const isGuiFlag = spec.isGui ? '1' : '0';

  const lines = [
    `#!/bin/sh`,
    `# Awesome-OS Sovereign Installer — ${spec.displayName} (${spec.id}) v${spec.version}`,
    `# ABI Magic: ${B8G_ABI_MAGIC_V3} | Repo: ${spec.repo}`,
    `set -eu`,
    ``,
    `HOLO_APP_ID='${id}'`,
    `HOLO_DISPLAY_NAME='${displayName}'`,
    `HOLO_REPO='${repo}'`,
    `HOLO_VERSION='${version}'`,
    `HOLO_BINARY_NAME='${binName}'`,
    `HOLO_BASE_URL='${urlBase}'`,
    `HOLO_IS_GUI='${isGuiFlag}'`,
    `HOLO_ABI_MAGIC='${B8G_ABI_MAGIC_V3}'`,
    ``,
    `CAS_ROOT="\${HOLO_CAS_DIR:-\${B8G_GHOST_CACHE_DIR:-\$HOME/.b8g/cas}}"`,
    `INSTALL_DIR="\${HOLO_INSTALL_DIR:-\$HOME/.b8g/bin}"`,
    ``,
    `UNAME_S="$(uname -s | tr '[:upper:]' '[:lower:]')"`,
    `UNAME_M="$(uname -m)"`,
    `case "$UNAME_M" in`,
    `  x86_64|amd64) ARCH="x86_64" ;;`,
    `  aarch64|arm64) ARCH="aarch64" ;;`,
    `  *) echo "Unsupported architecture: $UNAME_M" >&2; exit 1 ;;`,
    `esac`,
    `case "$UNAME_S" in`,
    `  linux*) OS_TAG="linux" ;;`,
    `  darwin*) OS_TAG="darwin" ;;`,
    `  *) echo "Unsupported OS: $UNAME_S" >&2; exit 1 ;;`,
    `esac`,
    ``,
    `ASSET_NAME="\${HOLO_APP_ID}-\${ARCH}-\${OS_TAG}"`,
    `DOWNLOAD_URL="\${HOLO_BASE_URL}/\${ASSET_NAME}"`,
    `SUMS_URL="\${HOLO_BASE_URL}/SHA512SUMS.txt"`,
    ``,
    `compute_sha512() {`,
    `  if command -v sha512sum >/dev/null 2>&1; then`,
    `    sha512sum "$1" | awk '{print tolower($1)}'`,
    `  elif command -v shasum >/dev/null 2>&1; then`,
    `    shasum -a 512 "$1" | awk '{print tolower($1)}'`,
    `  else`,
    `    echo "Neither sha512sum nor shasum -a 512 is available" >&2`,
    `    exit 1`,
    `  fi`,
    `}`,
    ``,
    `fetch_url() {`,
    `  if command -v curl >/dev/null 2>&1; then`,
    `    curl -fsSL "$1" -o "$2"`,
    `  elif command -v wget >/dev/null 2>&1; then`,
    `    wget -qO "$2" "$1"`,
    `  else`,
    `    echo "Neither curl nor wget is available" >&2`,
    `    exit 1`,
    `  fi`,
    `}`,
    ``,
    `printf '[%s] Installing v%s (%s-%s) [ABI %s]...\\n' "$HOLO_DISPLAY_NAME" "$HOLO_VERSION" "$ARCH" "$OS_TAG" "$HOLO_ABI_MAGIC"`,
    `mkdir -p "$INSTALL_DIR"`,
    ``,
    `TMP_FILE="$(mktemp "\${TMPDIR:-/tmp}/\${HOLO_APP_ID}.XXXXXX")"`,
    `SUMS_FILE="$(mktemp "\${TMPDIR:-/tmp}/\${HOLO_APP_ID}.sums.XXXXXX")"`,
    `trap 'rm -f "$TMP_FILE" "$SUMS_FILE"' EXIT`,
    ``,
    `fetch_url "$DOWNLOAD_URL" "$TMP_FILE"`,
    `ACTUAL_SHA512="$(compute_sha512 "$TMP_FILE")"`,
    ``,
    `EXPECTED_SHA512="\${HOLO_EXPECTED_SHA512:-}"`,
    `if [ -z "$EXPECTED_SHA512" ]; then`,
    `  if fetch_url "$SUMS_URL" "$SUMS_FILE" 2>/dev/null; then`,
    `    EXPECTED_SHA512="$(awk -v a="$ASSET_NAME" -v b="$HOLO_BINARY_NAME" '$2 == a || $2 == ("*" a) || $2 == b || $2 == ("*" b) { print tolower($1); exit }' "$SUMS_FILE")"`,
    `  fi`,
    `fi`,
    ``,
    `if [ -n "$EXPECTED_SHA512" ] && [ "$ACTUAL_SHA512" != "$EXPECTED_SHA512" ]; then`,
    `  echo "SHA-512 verification failed for $ASSET_NAME (expected $EXPECTED_SHA512, got $ACTUAL_SHA512)" >&2`,
    `  exit 1`,
    `fi`,
    ``,
    `PREFIX="$(printf '%s' "$ACTUAL_SHA512" | cut -c1-2)"`,
    `CAS_BUCKET_DIR="\${CAS_ROOT}/v11/files/\${PREFIX}"`,
    `CAS_OBJECT_PATH="\${CAS_BUCKET_DIR}/\${ACTUAL_SHA512}-exec"`,
    `mkdir -p "$CAS_BUCKET_DIR"`,
    ``,
    `if [ ! -f "$CAS_OBJECT_PATH" ]; then`,
    `  mv -f "$TMP_FILE" "$CAS_OBJECT_PATH"`,
    `fi`,
    `chmod 0755 "$CAS_OBJECT_PATH"`,
    ``,
    `DEST_PATH="\${INSTALL_DIR}/\${HOLO_BINARY_NAME}"`,
    `if ! ln -f "$CAS_OBJECT_PATH" "$DEST_PATH" 2>/dev/null; then`,
    `  cp -f "$CAS_OBJECT_PATH" "$DEST_PATH"`,
    `  chmod 0755 "$DEST_PATH"`,
    `fi`,
    ``,
    `printf '[%s] Projected -> %s (CAS v11/files/%s/%s-exec, GUI=%s)\\n' "$HOLO_DISPLAY_NAME" "$DEST_PATH" "$PREFIX" "$ACTUAL_SHA512" "$HOLO_IS_GUI"`,
    ``,
  ];

  return stripLeadingBom(lines.join('\n'));
}

/**
 * Generates C11 `splash_layout.h` for stamping native Ghost/Splash binaries with
 * `AWESOME_APP_ID`, `AWESOME_APP_VERSION`, `B8G_ABI_MAGIC_V3`, and centered 460x220
 * DPI-aware coordinates.
 */
export function renderSplashHeader(spec: GenInstallSpec): string {
  const title = spec.splashTitle ?? spec.displayName;
  const subtitle = spec.splashSubtitle ?? `v${spec.version.replace(/^v/, '')}`;
  const isGuiInt = spec.isGui ? 1 : 0;

  const lines = [
    `/* Auto-generated by holo-pm-gen-install — DO NOT EDIT BY HAND */`,
    `#ifndef AWESOME_SPLASH_LAYOUT_H`,
    `#define AWESOME_SPLASH_LAYOUT_H`,
    ``,
    `#include <stdint.h>`,
    ``,
    `#define B8G_ABI_MAGIC_V3          ${B8G_ABI_MAGIC_V3}U`,
    `#define AWESOME_APP_ID            "${escapeCString(spec.id)}"`,
    `#define AWESOME_APP_DISPLAY_NAME  "${escapeCString(spec.displayName)}"`,
    `#define AWESOME_APP_REPO          "${escapeCString(spec.repo)}"`,
    `#define AWESOME_APP_VERSION       "${escapeCString(spec.version)}"`,
    `#define AWESOME_APP_BINARY_NAME   "${escapeCString(spec.binaryName)}"`,
    `#define AWESOME_APP_IS_GUI        ${isGuiInt}`,
    `#define AWESOME_SPLASH_TITLE      "${escapeCString(title)}"`,
    `#define AWESOME_SPLASH_SUBTITLE   "${escapeCString(subtitle)}"`,
    ``,
    `/* Canonical centered 460x220 logical splash geometry at 96 DPI */`,
    `#define AWESOME_SPLASH_BASE_WIDTH   460`,
    `#define AWESOME_SPLASH_BASE_HEIGHT  220`,
    `#define AWESOME_SPLASH_BASE_DPI     96`,
    ``,
    `typedef struct awesome_splash_rect {`,
    `  int32_t x;`,
    `  int32_t y;`,
    `  int32_t width;`,
    `  int32_t height;`,
    `  uint32_t dpi;`,
    `  uint32_t abi_magic;`,
    `} awesome_splash_rect_t;`,
    ``,
    `static inline awesome_splash_rect_t awesome_splash_compute_rect(`,
    `    int32_t monitor_x,`,
    `    int32_t monitor_y,`,
    `    int32_t monitor_width,`,
    `    int32_t monitor_height,`,
    `    uint32_t dpi) {`,
    `  uint32_t eff_dpi = (dpi == 0U) ? (uint32_t)AWESOME_SPLASH_BASE_DPI : dpi;`,
    `  int32_t scaled_w = (int32_t)(((int64_t)AWESOME_SPLASH_BASE_WIDTH * (int64_t)eff_dpi + 48) / (int64_t)AWESOME_SPLASH_BASE_DPI);`,
    `  int32_t scaled_h = (int32_t)(((int64_t)AWESOME_SPLASH_BASE_HEIGHT * (int64_t)eff_dpi + 48) / (int64_t)AWESOME_SPLASH_BASE_DPI);`,
    `  awesome_splash_rect_t rect;`,
    `  rect.width = scaled_w;`,
    `  rect.height = scaled_h;`,
    `  rect.x = monitor_x + ((monitor_width - scaled_w) / 2);`,
    `  rect.y = monitor_y + ((monitor_height - scaled_h) / 2);`,
    `  rect.dpi = eff_dpi;`,
    `  rect.abi_magic = B8G_ABI_MAGIC_V3;`,
    `  return rect;`,
    `}`,
    ``,
    `#endif /* AWESOME_SPLASH_LAYOUT_H */`,
    ``,
  ];

  return stripLeadingBom(lines.join('\n'));
}

/**
 * Writes `install.ps1` (explicit UTF-8 without BOM), `install.sh`, and `splash_layout.h`
 * into `outDir` and returns `{ outDir, files }`.
 */
export function generateInstallerBundle(
  spec: GenInstallSpec,
  outDir: string,
): InstallerBundleReceipt {
  const resolvedOutDir = path.resolve(outDir);
  fs.mkdirSync(resolvedOutDir, { recursive: true });

  const ps1Path = path.join(resolvedOutDir, 'install.ps1');
  const shPath = path.join(resolvedOutDir, 'install.sh');
  const headerPath = path.join(resolvedOutDir, 'splash_layout.h');

  const ps1Content = stripLeadingBom(renderHoloInstallPs1(spec));
  const shContent = stripLeadingBom(renderHoloInstallSh(spec));
  const headerContent = stripLeadingBom(renderSplashHeader(spec));

  fs.writeFileSync(ps1Path, Buffer.from(ps1Content, 'utf8'));
  fs.writeFileSync(shPath, Buffer.from(shContent, 'utf8'));
  fs.writeFileSync(headerPath, Buffer.from(headerContent, 'utf8'));

  return {
    outDir: resolvedOutDir,
    files: [ps1Path, shPath, headerPath],
  };
}

function parseCliArgs(argv: readonly string[]): { spec: GenInstallSpec; outDir: string } {
  const positional: string[] = [];
  let displayName: string | undefined;
  let binaryName: string | undefined;
  let downloadBaseUrl: string | undefined;
  let isGui = false;
  let splashTitle: string | undefined;
  let splashSubtitle: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--display-name' && i + 1 < argv.length) {
      displayName = argv[++i];
    } else if (arg === '--binary-name' && i + 1 < argv.length) {
      binaryName = argv[++i];
    } else if (arg === '--download-base-url' && i + 1 < argv.length) {
      downloadBaseUrl = argv[++i];
    } else if (arg === '--gui') {
      isGui = true;
    } else if (arg === '--splash-title' && i + 1 < argv.length) {
      splashTitle = argv[++i];
    } else if (arg === '--splash-subtitle' && i + 1 < argv.length) {
      splashSubtitle = argv[++i];
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 4) {
    throw new Error(
      'Usage: holo-pm-gen-install <id> <repo> <version> <outDir> [--display-name <name>] [--binary-name <bin>] [--download-base-url <url>] [--gui] [--splash-title <title>] [--splash-subtitle <subtitle>]',
    );
  }

  const [id, repo, version, outDir] = positional;
  const spec: GenInstallSpec = {
    id,
    displayName: displayName ?? id,
    repo,
    version,
    binaryName: binaryName ?? id,
    downloadBaseUrl,
    isGui,
    splashTitle,
    splashSubtitle,
  };

  return { spec, outDir };
}

function isDirectCliInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectCliInvocation()) {
  try {
    const { spec, outDir } = parseCliArgs(process.argv.slice(2));
    const receipt = generateInstallerBundle(spec, outDir);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
