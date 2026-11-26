import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  PIN_FILES,
  loadUnifiedOverrides,
  resolveUnifiedOverride,
} from './holo-overrides.mts';

describe('awesome-os/holo-pm central pins/holo-overrides.mts', () => {
  it('links all 3 ecosystem pin files + v11 lockfile and resolves canonical overrides cleanly', () => {
    for (const p of Object.values(PIN_FILES)) {
      assert.equal(fs.existsSync(p), true, `Missing linked pin file: ${p}`);
    }

    const snap = loadUnifiedOverrides();
    assert.equal(snap.abiMagic, '0x33564742');
    assert.equal(snap.casLayout, 'v11');
    assert.ok(Object.keys(snap.rust).length >= 50);
    assert.ok(Object.keys(snap.go).length >= 50);
    assert.ok(Object.keys(snap.npm).length >= 17);
    assert.ok(snap.v11LockfileEntries > 500);

    assert.equal(resolveUnifiedOverride('npm', 'typescript'), '6.0.3');
    assert.ok(resolveUnifiedOverride('rust', 'syn'));
    assert.ok(resolveUnifiedOverride('go', 'google.golang.org/grpc'));
  });
});
