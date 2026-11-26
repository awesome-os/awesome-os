import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AWESOME_OS_CATALOG } from '../catalog/awesome-os-apps.mts';
import {
  renderInstallPs1,
  renderInstallSh,
  renderSplashLayoutHeader,
  stampCatalog,
} from '../src/index.mts';

describe('@awesome-os/installer', () => {
  it('stamps all catalog apps for GitHub Releases and supports instant web-host switching without rebuilds', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awesome-os-installer-'));
    try {
      const ghResult = stampCatalog(AWESOME_OS_CATALOG, join(tmp, 'gh'));
      assert.equal(ghResult.stamped.length, AWESOME_OS_CATALOG.length);
      assert.ok(existsSync(ghResult.catalogJsonPath));

      const webResult = stampCatalog(
        AWESOME_OS_CATALOG,
        join(tmp, 'web'),
        'https://awesome-os.com/downloads',
      );
      const sb = webResult.stamped.find((s) => s.id === 'sectium-browser');
      assert.ok(sb);
      assert.equal(
        sb.installPs1Command,
        'irm https://awesome-os.com/downloads/sectium-browser/install.ps1 | iex',
      );
      assert.equal(
        sb.installShCommand,
        'curl -fsSL https://awesome-os.com/downloads/sectium-browser/install.sh | sh',
      );

      const ps1 = readFileSync(join(sb.outDir, 'install.ps1'), 'utf8');
      assert.ok(ps1.includes('https://awesome-os.com/downloads/sectium-browser'));
      assert.ok(ps1.includes('SHA256SUMS.txt'));

      const sh = readFileSync(join(sb.outDir, 'install.sh'), 'utf8');
      assert.ok(sh.includes('sectium-browser-linux-x64'));
      assert.ok(sh.includes('sectium-browser-macos-arm64'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('computes exact centered pixel coordinates in splash_layout.h for every GUI app', () => {
    const sb = AWESOME_OS_CATALOG.find((d) => d.id === 'sectium-browser')!;
    const header = renderSplashLayoutHeader(sb);
    // (460 - 64) / 2 = 198
    assert.ok(header.includes('#define AWESOME_SPLASH_ICON_X 198'));
    assert.ok(header.includes('#define AWESOME_SPLASH_DPI_AWARE 1'));
    assert.ok(header.includes('#define AWESOME_APP_VERSION "0.7.2"'));
  });

  it('renders clean PowerShell and POSIX installers directly from a .mts definition', () => {
    const nodeDef = AWESOME_OS_CATALOG.find((d) => d.id === 'node')!;
    const ps1 = renderInstallPs1(nodeDef);
    const sh = renderInstallSh(nodeDef);
    assert.ok(ps1.includes('node.exe'));
    assert.ok(sh.includes('node-linux-arm64'));
  });

  it('wires install.ps1 and install.sh to the universal pnpm v11 CAS layout with SHA-512 sharding and hardlink projection', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'awesome-os-installer-v11-'));
    try {
      const result = stampCatalog(AWESOME_OS_CATALOG, tmp);
      const pnpmEntry = result.stamped.find((s) => s.id === 'pnpm')!;
      assert.ok(pnpmEntry);

      const ps1 = readFileSync(join(pnpmEntry.outDir, 'install.ps1'), 'utf8');
      assert.ok(ps1.includes('B8G_CAS_DIR'));
      assert.ok(ps1.includes('.b8g\\cas'));
      assert.ok(ps1.includes('v11/files'));
      assert.ok(ps1.includes('v11/tmp'));
      assert.ok(ps1.includes('v11/links'));
      assert.ok(ps1.includes('Get-FileHash -Algorithm SHA512'));
      assert.ok(ps1.includes('$sha512.Substring(0, 2)'));
      assert.ok(ps1.includes('$sha512-exec'));
      assert.ok(ps1.includes('Test-Path -LiteralPath $casBlobPath'));
      assert.ok(ps1.includes('New-Item -ItemType HardLink'));
      assert.ok(ps1.includes('Copy-Item -LiteralPath $casBlobPath -Destination $exePath'));

      const sh = readFileSync(join(pnpmEntry.outDir, 'install.sh'), 'utf8');
      assert.ok(sh.includes('B8G_CAS_DIR:-$HOME/.b8g/cas'));
      assert.ok(sh.includes('v11/files'));
      assert.ok(sh.includes('v11/tmp'));
      assert.ok(sh.includes('v11/links'));
      assert.ok(sh.includes('sha512sum'));
      assert.ok(sh.includes('shasum -a 512'));
      assert.ok(sh.includes('cut -c1-2'));
      assert.ok(sh.includes('${SHA512}-exec'));
      assert.ok(sh.includes('if [ -e "$CAS_BLOB" ]'));
      assert.ok(sh.includes('ln -f "$CAS_BLOB" "$TARGET"'));
      assert.ok(sh.includes('cp -f "$CAS_BLOB" "$TARGET"'));

      const manifest = JSON.parse(
        readFileSync(join(pnpmEntry.outDir, 'release-manifest.json'), 'utf8'),
      );
      assert.equal(manifest.casLayout, 'v11');

      const webCatalog = JSON.parse(readFileSync(result.catalogJsonPath, 'utf8'));
      assert.equal(webCatalog.casLayout, 'v11');
      assert.ok(webCatalog.apps.every((a: { casLayout?: string }) => a.casLayout === 'v11'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ships a self-contained OPFS + showDirectoryPicker web installer for awesome-os.com/install', () => {
    const htmlPath = join(import.meta.dirname, '..', 'web', 'opfs-installer.html');
    assert.ok(existsSync(htmlPath));
    const html = readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('showDirectoryPicker'));
    assert.ok(html.includes('navigator.storage.getDirectory'));
    assert.ok(html.includes("crypto.subtle.digest('SHA-512'"));
    assert.ok(html.includes('cas/v11/files/'));
    assert.ok(html.includes('workstation-omarchy'));
    assert.ok(html.includes('https://awesome-os.com/install/'));
  });
});
