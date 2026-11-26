import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyManifestEd25519 } from '../../security/verified-boot.mts';
import { runHoloUpgrade, UPGRADE_PHASES } from './holo-upgrade.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('os/bootstrap/holo-upgrade — One-Command Ecosystem Upgrader', () => {
  it('defines all 4 canonical upgrade phases and executes cleanly in offline mode with Ed25519 receipt', () => {
    assert.equal(UPGRADE_PHASES.length, 4);
    const { receipt, receiptPath } = runHoloUpgrade({ offline: true, json: false });
    assert.equal(receipt.schema, 'awesome-os.holo-upgrade-receipt.v1');
    assert.equal(receipt.abiMagic, '0x33564742');
    assert.equal(receipt.casLayout, 'v11');
    assert.equal(receipt.zeroLegacyGhostVerified, true);
    assert.equal(receipt.dedupSummary.dupV8Bytes, 0);
    assert.ok(receipt.monoreposDetected.includes('awesome-os'));
    assert.ok(existsSync(receiptPath));

    const sigCheck = verifyManifestEd25519(receipt);
    assert.equal(sigCheck.valid, true);
  });

  it('supports --offline --json CLI invocation cleanly', () => {
    const out = execFileSync(process.execPath, [join(HERE, 'holo-upgrade.mts'), '--offline', '--json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out) as { schema: string; zeroLegacyGhostVerified: boolean };
    assert.equal(parsed.schema, 'awesome-os.holo-upgrade-receipt.v1');
    assert.equal(parsed.zeroLegacyGhostVerified, true);
  });
});
