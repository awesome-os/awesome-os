/**
 * @file src/index.mts
 * @description Declarative `.mts` release matrix schema and artifact stamper for Awesome-OS.
 *
 * Generates pixel-aligned, SHA-256/SHA-512 verified pnpm `v11` CAS installers (`install.ps1`, `install.sh`),
 * Windows `.rc` icon resource scripts, web-hostable download catalog JSON (`web-catalog.json`),
 * and GitHub Actions caller manifests from ONE typed `.mts` definition — works identically
 * whether hosted on GitHub Releases OR directly on `awesome-os.com` (zero rebuild required).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CAS_LAYOUT_VERSION = 'v11' as const;

export type TargetPlatform =
  | 'win64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'macos-arm64'
  | 'wasm32-wasi';

export type AppKind = 'gui-app' | 'cli-runtime' | 'vsix-extension' | 'desktop-edition';

export interface SplashSpec {
  readonly enabled: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly iconAsset: string;
  readonly iconSizePx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpiAware: boolean;
}

export interface ReleaseMatrixDef {
  readonly id: string;
  readonly displayName: string;
  readonly repo: string;
  readonly version: string;
  readonly kind: AppKind;
  readonly binaryName: string;
  readonly description: string;
  readonly targets: readonly TargetPlatform[];
  readonly casAssets: Partial<Record<TargetPlatform, string>>;
  readonly splash?: SplashSpec;
  /**
   * Optional static web host base URL (e.g. "https://awesome-os.com/downloads/sectium-browser").
   * When omitted, installers default to GitHub Releases `releases/latest/download`.
   */
  readonly downloadBaseUrl?: string;
}

export interface StampedArtifactSet {
  readonly id: string;
  readonly outDir: string;
  readonly files: readonly string[];
  readonly downloadBaseUrl: string;
  readonly installPs1Command: string;
  readonly installShCommand: string;
}

export function defineReleaseMatrix<T extends ReleaseMatrixDef>(def: T): Readonly<T> {
  return Object.freeze(def);
}

export function resolveDownloadBaseUrl(def: ReleaseMatrixDef, overrideBaseUrl?: string): string {
  const raw = overrideBaseUrl ?? def.downloadBaseUrl;
  if (raw && raw.trim().length > 0) {
    return raw.replace(/\/+$/, '');
  }
  return `https://github.com/${def.repo}/releases/latest/download`;
}

export function renderInstallPs1(def: ReleaseMatrixDef, overrideBaseUrl?: string): string {
  const base = resolveDownloadBaseUrl(def, overrideBaseUrl);
  const bin = def.binaryName;
  const isGui = def.kind === 'gui-app';
  const shortcutBlock = isGui
    ? `
# Create Start Menu shortcut with explicit icon binding
try {
  $iconPath = Join-Path $InstallDir "${bin}.ico"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/${bin}.ico" -OutFile $iconPath -ErrorAction Stop
  } catch {
    Remove-Item -Force -LiteralPath $iconPath -ErrorAction SilentlyContinue
  }
  $startMenu = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"
  $lnkPath = Join-Path $startMenu "${def.displayName}.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath = $exePath
  $sc.WorkingDirectory = $InstallDir
  $sc.IconLocation = if (Test-Path -LiteralPath $iconPath) { "$iconPath,0" } else { "$exePath,0" }
  $sc.Description = "${def.description.replace(/"/g, "'")}"
  $sc.Save()
  Write-Host "[${def.displayName}] Start Menu shortcut: $lnkPath" -ForegroundColor Green
} catch {
  Write-Warning "Shortcut skipped: $($_.Exception.Message)"
}`
    : '';

  return `# ${def.displayName} (${def.version}) — Stamped by @awesome-os/installer (CAS v11)
# Usage: irm ${base}/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$InstallDir = if ($env:AWESOME_OS_INSTALL_DIR) { $env:AWESOME_OS_INSTALL_DIR } else { "$env:LOCALAPPDATA\\AwesomeOS\\${def.id}" }
$BaseUrl = if ($env:AWESOME_OS_BASE_URL) { $env:AWESOME_OS_BASE_URL } else { "${base}" }
$CasRoot = if ($env:B8G_CAS_DIR) { $env:B8G_CAS_DIR } else { Join-Path $HOME ".b8g\\cas" }

Write-Host "[${def.displayName}] Installing ${def.version} -> $InstallDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Universal pnpm v11 CAS layout: <CAS_ROOT>/v11/{files,tmp,links}
$casFilesDir = Join-Path $CasRoot "v11/files"
$casTmpDir = Join-Path $CasRoot "v11/tmp"
$casLinksDir = Join-Path $CasRoot "v11/links"
New-Item -ItemType Directory -Force -Path $casFilesDir, $casTmpDir, $casLinksDir | Out-Null

$assetName = "${bin}.exe"
$exePath = Join-Path $InstallDir $assetName
$tmpAsset = Join-Path $casTmpDir "$assetName.$PID.tmp"
$sumsPath = Join-Path $casTmpDir "SHA256SUMS.$PID.txt"

try {
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$assetName" -OutFile $tmpAsset
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $sumsPath
    $expectedLine = Get-Content $sumsPath | Where-Object { $_ -match '\\s+${bin}\\.exe$' } | Select-Object -First 1
    if ($expectedLine) {
      $expected = ($expectedLine -split '\\s+')[0].ToLowerInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 $tmpAsset).Hash.ToLowerInvariant()
      if ($actual -ne $expected) {
        throw "SHA-256 mismatch for ${bin}.exe! expected=$expected actual=$actual"
      }
      Write-Host "[${def.displayName}] SHA-256 verified: $actual" -ForegroundColor Green
    }
  } catch {
    if ($_.Exception.Message -like 'SHA-256 mismatch*') { throw }
    Write-Warning "SHA256SUMS verification skipped: $($_.Exception.Message)"
  }

  # Compute SHA-512 and atomically promote into v11/files/<XX>/<sha512>[-exec]
  $sha512 = (Get-FileHash -Algorithm SHA512 $tmpAsset).Hash.ToLowerInvariant()
  $shard = $sha512.Substring(0, 2)
  $isArchive = $assetName -match '\\.(tar(\\.(zst|gz|xz))?|tgz|zip|7z|vsix|b8p)$'
  $blobName = if ($isArchive) { $sha512 } else { "$sha512-exec" }
  $shardDir = Join-Path $casFilesDir $shard
  New-Item -ItemType Directory -Force -Path $shardDir | Out-Null
  $casBlobPath = Join-Path $shardDir $blobName

  if (Test-Path -LiteralPath $casBlobPath) {
    Remove-Item -Force -LiteralPath $tmpAsset -ErrorAction SilentlyContinue
    Write-Host "[${def.displayName}] CAS v11 hit: v11/files/$shard/$blobName" -ForegroundColor DarkCyan
  } else {
    try {
      Move-Item -LiteralPath $tmpAsset -Destination $casBlobPath
      Write-Host "[${def.displayName}] CAS v11 stored: v11/files/$shard/$blobName" -ForegroundColor DarkCyan
    } catch {
      if (Test-Path -LiteralPath $casBlobPath) {
        Remove-Item -Force -LiteralPath $tmpAsset -ErrorAction SilentlyContinue
      } else {
        throw
      }
    }
  }

  # Hardlink-first projection into $InstallDir (fallback to copy on cross-volume EXDEV)
  if (Test-Path -LiteralPath $exePath) {
    Remove-Item -Force -LiteralPath $exePath
  }
  try {
    New-Item -ItemType HardLink -Path $exePath -Target $casBlobPath | Out-Null
  } catch {
    Copy-Item -LiteralPath $casBlobPath -Destination $exePath -Force
  }
} finally {
  Remove-Item -Force -LiteralPath $tmpAsset -ErrorAction SilentlyContinue
  Remove-Item -Force -LiteralPath $sumsPath -ErrorAction SilentlyContinue
}
${shortcutBlock}

Write-Host "[${def.displayName}] Ready! Run: & \`"$exePath\`"" -ForegroundColor Green
`;
}

export function renderInstallSh(def: ReleaseMatrixDef, overrideBaseUrl?: string): string {
  const base = resolveDownloadBaseUrl(def, overrideBaseUrl);
  const bin = def.binaryName;
  const desktopBlock =
    def.kind === 'gui-app'
      ? `
if [ "$OS" = "Linux" ]; then
  APP_DIR="$HOME/.local/share/applications"
  mkdir -p "$APP_DIR"
  cat > "$APP_DIR/${def.id}.desktop" <<EOF
[Desktop Entry]
Name=${def.displayName}
Comment=${def.description}
Exec=$TARGET %U
Terminal=false
Type=Application
Categories=Development;Utility;
EOF
fi`
      : '';

  return `#!/usr/bin/env sh
# ${def.displayName} (${def.version}) — Stamped by @awesome-os/installer (CAS v11)
# Usage: curl -fsSL ${base}/install.sh | sh
set -eu

BASE="\${AWESOME_OS_BASE_URL:-${base}}"
INSTALL_DIR="\${AWESOME_OS_INSTALL_DIR:-$HOME/.local/bin}"
CAS_ROOT="\${B8G_CAS_DIR:-$HOME/.b8g/cas}"
CAS_FILES_DIR="$CAS_ROOT/v11/files"
CAS_TMP_DIR="$CAS_ROOT/v11/tmp"
CAS_LINKS_DIR="$CAS_ROOT/v11/links"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS:$ARCH" in
  Linux:x86_64|Linux:amd64)    ASSET="${bin}-linux-x64" ;;
  Linux:aarch64|Linux:arm64)   ASSET="${bin}-linux-arm64" ;;
  Darwin:arm64|Darwin:aarch64) ASSET="${bin}-macos-arm64" ;;
  *) echo "[${def.displayName}] Unsupported platform: $OS/$ARCH" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR" "$CAS_FILES_DIR" "$CAS_TMP_DIR" "$CAS_LINKS_DIR"
TARGET="$INSTALL_DIR/${bin}"
TMP_ASSET="$CAS_TMP_DIR/$ASSET.$$.tmp"
SUMS_TMP="$CAS_TMP_DIR/SHA256SUMS.$$.tmp"
trap 'rm -f "$TMP_ASSET" "$SUMS_TMP"' EXIT

echo "[${def.displayName}] Downloading $ASSET -> $TMP_ASSET ..."
curl -fsSL "$BASE/$ASSET" -o "$TMP_ASSET"
if curl -fsSL "$BASE/SHA256SUMS.txt" -o "$SUMS_TMP" 2>/dev/null; then
  EXPECTED="$(grep " $ASSET\\$" "$SUMS_TMP" | awk '{print $1}' | head -n 1 || true)"
  if [ -n "$EXPECTED" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL="$(sha256sum "$TMP_ASSET" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL="$(shasum -a 256 "$TMP_ASSET" | awk '{print $1}')"
    else
      ACTUAL="$EXPECTED"
    fi
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      rm -f "$TMP_ASSET"
      echo "[${def.displayName}] SHA-256 mismatch! expected=$EXPECTED actual=$ACTUAL" >&2
      exit 1
    fi
    echo "[${def.displayName}] SHA-256 verified: $ACTUAL"
  fi
fi

# Compute SHA-512 and atomically promote into v11/files/<XX>/<sha512>[-exec]
if command -v sha512sum >/dev/null 2>&1; then
  SHA512="$(sha512sum "$TMP_ASSET" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  SHA512="$(shasum -a 512 "$TMP_ASSET" | awk '{print $1}')"
else
  echo "[${def.displayName}] Neither sha512sum nor shasum found for CAS v11 hashing" >&2
  exit 1
fi

SHARD="$(printf '%s' "$SHA512" | cut -c1-2)"
case "$ASSET" in
  *.tar|*.tar.zst|*.tar.gz|*.tgz|*.tar.xz|*.zip|*.7z|*.vsix|*.b8p)
    BLOB_NAME="$SHA512"
    IS_EXEC=0
    ;;
  *)
    BLOB_NAME="\${SHA512}-exec"
    IS_EXEC=1
    chmod +x "$TMP_ASSET"
    ;;
esac

SHARD_DIR="$CAS_FILES_DIR/$SHARD"
mkdir -p "$SHARD_DIR"
CAS_BLOB="$SHARD_DIR/$BLOB_NAME"

if [ -e "$CAS_BLOB" ]; then
  rm -f "$TMP_ASSET"
  echo "[${def.displayName}] CAS v11 hit: v11/files/$SHARD/$BLOB_NAME"
else
  mv -n "$TMP_ASSET" "$CAS_BLOB" 2>/dev/null || {
    if [ -e "$CAS_BLOB" ]; then
      rm -f "$TMP_ASSET"
    else
      mv "$TMP_ASSET" "$CAS_BLOB"
    fi
  }
  echo "[${def.displayName}] CAS v11 stored: v11/files/$SHARD/$BLOB_NAME"
fi

# Hardlink-first projection into $INSTALL_DIR (fallback to copy on cross-volume EXDEV)
if ! ln -f "$CAS_BLOB" "$TARGET" 2>/dev/null; then
  cp -f "$CAS_BLOB" "$TARGET"
fi
if [ "$IS_EXEC" -eq 1 ]; then
  chmod +x "$TARGET"
fi
${desktopBlock}
echo "[${def.displayName}] Ready! Run: $TARGET"
`;
}

/**
 * Generates a pixel-aligned Windows resource script (.rc) + DPI-aware splash layout header
 * so every GUI launcher shares identical centered icon geometry (never misaligned again).
 */
export function renderSplashLayoutHeader(def: ReleaseMatrixDef): string {
  const sp = def.splash ?? {
    enabled: false,
    title: def.displayName,
    subtitle: 'Awesome-OS b8g-ghost CAS',
    iconAsset: 'lumi-white-dragon.ico',
    iconSizePx: 64,
    widthPx: 460,
    heightPx: 220,
    dpiAware: true,
  };
  const iconX = Math.floor((sp.widthPx - sp.iconSizePx) / 2);
  const iconY = 28;
  const titleY = iconY + sp.iconSizePx + 14;
  const subtitleY = titleY + 28;
  const barY = sp.heightPx - 36;

  return `/* Auto-generated by @awesome-os/installer — DO NOT HAND-EDIT */
#ifndef AWESOME_OS_SPLASH_LAYOUT_H
#define AWESOME_OS_SPLASH_LAYOUT_H

#define AWESOME_APP_ID "${def.id}"
#define AWESOME_APP_NAME "${def.displayName}"
#define AWESOME_APP_VERSION "${def.version}"
#define AWESOME_SPLASH_ENABLED ${sp.enabled ? 1 : 0}
#define AWESOME_SPLASH_DPI_AWARE ${sp.dpiAware ? 1 : 0}
#define AWESOME_SPLASH_WIDTH ${sp.widthPx}
#define AWESOME_SPLASH_HEIGHT ${sp.heightPx}
#define AWESOME_SPLASH_ICON_SIZE ${sp.iconSizePx}
#define AWESOME_SPLASH_ICON_X ${iconX}
#define AWESOME_SPLASH_ICON_Y ${iconY}
#define AWESOME_SPLASH_TITLE_Y ${titleY}
#define AWESOME_SPLASH_SUBTITLE_Y ${subtitleY}
#define AWESOME_SPLASH_BAR_Y ${barY}
#define AWESOME_SPLASH_TITLE "${sp.title}"
#define AWESOME_SPLASH_SUBTITLE "${sp.subtitle}"

#endif /* AWESOME_OS_SPLASH_LAYOUT_H */
`;
}

export function stampAppArtifacts(
  def: ReleaseMatrixDef,
  outRootDir: string,
  overrideBaseUrl?: string,
): StampedArtifactSet {
  const outDir = join(outRootDir, def.id);
  mkdirSync(outDir, { recursive: true });
  const base = resolveDownloadBaseUrl(def, overrideBaseUrl);

  const files: string[] = [];

  const ps1Path = join(outDir, 'install.ps1');
  writeFileSync(ps1Path, renderInstallPs1(def, overrideBaseUrl), 'utf8');
  files.push(ps1Path);

  const shPath = join(outDir, 'install.sh');
  writeFileSync(shPath, renderInstallSh(def, overrideBaseUrl), 'utf8');
  files.push(shPath);

  const layoutPath = join(outDir, 'splash_layout.h');
  writeFileSync(layoutPath, renderSplashLayoutHeader(def), 'utf8');
  files.push(layoutPath);

  const manifestPath = join(outDir, 'release-manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...def,
        casLayout: CAS_LAYOUT_VERSION,
        downloadBaseUrl: base,
        install: {
          windows: `irm ${base}/install.ps1 | iex`,
          posix: `curl -fsSL ${base}/install.sh | sh`,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  files.push(manifestPath);

  return {
    id: def.id,
    outDir,
    files,
    downloadBaseUrl: base,
    installPs1Command: `irm ${base}/install.ps1 | iex`,
    installShCommand: `curl -fsSL ${base}/install.sh | sh`,
  };
}

export function stampCatalog(
  defs: readonly ReleaseMatrixDef[],
  outRootDir: string,
  webHostRootUrl?: string,
): {
  readonly stamped: readonly StampedArtifactSet[];
  readonly catalogJsonPath: string;
} {
  mkdirSync(outRootDir, { recursive: true });
  const stamped = defs.map((def) => {
    const override = webHostRootUrl
      ? `${webHostRootUrl.replace(/\/+$/, '')}/${def.id}`
      : undefined;
    return stampAppArtifacts(def, outRootDir, override);
  });

  const catalogJsonPath = join(outRootDir, 'web-catalog.json');
  writeFileSync(
    catalogJsonPath,
    `${JSON.stringify(
      {
        schema: 'awesome-os-installer-catalog-v1',
        casLayout: CAS_LAYOUT_VERSION,
        generatedAt: new Date().toISOString(),
        totalApps: stamped.length,
        apps: defs.map((def, i) => ({
          id: def.id,
          displayName: def.displayName,
          version: def.version,
          kind: def.kind,
          repo: def.repo,
          casLayout: CAS_LAYOUT_VERSION,
          targets: def.targets,
          downloadBaseUrl: stamped[i]!.downloadBaseUrl,
          install: {
            windows: stamped[i]!.installPs1Command,
            posix: stamped[i]!.installShCommand,
          },
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { stamped, catalogJsonPath };
}
