import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyManifestEd25519 } from '../../security/verified-boot.mts';
import { runHoloUpgrade, UPGRADE_PHASES } from './holo-upgrade.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

function stageIsolatedMonorepo(): { tmpWorkspace: string; tmpMonorepo: string } {
  const tmpWorkspace = mkdtempSync(join(tmpdir(), 'holo-upgrade-test-'));
  const tmpMonorepo = join(tmpWorkspace, 'awesome-os');
  mkdirSync(join(tmpMonorepo, 'os', 'bootstrap'), { recursive: true });
  mkdirSync(join(tmpMonorepo, 'os', 'bootloader', 'assets'), { recursive: true });
  copyFileSync(
    join(HERE, 'awesomeos-v1.0.manifest.json'),
    join(tmpMonorepo, 'os', 'bootstrap', 'awesomeos-v1.0.manifest.json'),
  );
  copyFileSync(
    join(REPO_ROOT, 'os', 'bootloader', 'assets', 'generate-splash.mts'),
    join(tmpMonorepo, 'os', 'bootloader', 'assets', 'generate-splash.mts'),
  );
  const casManifest = join(REPO_ROOT, 'registry', 'index', 'cas-v11-global-manifest.json');
  if (existsSync(casManifest)) {
    mkdirSync(join(tmpMonorepo, 'registry', 'index'), { recursive: true });
    copyFileSync(casManifest, join(tmpMonorepo, 'registry', 'index', 'cas-v11-global-manifest.json'));
  }
  return { tmpWorkspace, tmpMonorepo };
}

describe('os/bootstrap/holo-upgrade — One-Command Ecosystem Upgrader', () => {
  it('defines all 4 canonical upgrade phases and executes cleanly in offline mode with Ed25519 receipt', () => {
    const { tmpWorkspace, tmpMonorepo } = stageIsolatedMonorepo();
    try {
      assert.equal(UPGRADE_PHASES.length, 4);
      const { receipt, receiptPath } = runHoloUpgrade({
        offline: true,
        json: true,
        monorepoRoot: tmpMonorepo,
      });
      assert.equal(receipt.schema, 'awesome-os.holo-upgrade-receipt.v1');
      assert.equal(receipt.abiMagic, '0x33564742');
      assert.equal(receipt.casLayout, 'v11');
      assert.equal(receipt.zeroLegacyGhostVerified, true);
      assert.equal(receipt.dedupSummary.dupV8Bytes, 0);
      assert.ok(receipt.monoreposDetected.includes('awesome-os'));
      assert.ok(existsSync(receiptPath));
      assert.ok(receiptPath.startsWith(tmpMonorepo));

      const sigCheck = verifyManifestEd25519(receipt);
      assert.equal(sigCheck.valid, true);
    } finally {
      rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it('supports --offline --json CLI invocation cleanly', () => {
    const { tmpWorkspace, tmpMonorepo } = stageIsolatedMonorepo();
    try {
      const out = execFileSync(
        process.execPath,
        [join(HERE, 'holo-upgrade.mts'), '--offline', '--json', '--monorepo-root', tmpMonorepo],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(out) as { schema: string; zeroLegacyGhostVerified: boolean };
      assert.equal(parsed.schema, 'awesome-os.holo-upgrade-receipt.v1');
      assert.equal(parsed.zeroLegacyGhostVerified, true);
    } finally {
      rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });
});
