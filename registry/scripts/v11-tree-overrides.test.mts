import test from 'node:test';
import assert from 'node:assert/strict';
import { buildV11OverrideReport } from './v11-tree-overrides.mts';

test('v11-tree.json takes precedence and shadows legacy tarballs', () => {
  const report = buildV11OverrideReport([
    { repo: 'obs', tag: 'v0.3.0', filename: 'v11-tree.json', sha512: 'aaa', size: 1200, downloadUrl: 'https://example/obs/v11-tree.json' },
    { repo: 'obs', tag: 'v0.3.0', filename: 'obs-win64.tar.zst', sha512: 'bbb', size: 90_000_000, downloadUrl: 'https://example/obs.tar.zst' },
    { repo: 'legacy-app', tag: 'v1.0.0', filename: 'legacy-app.tar.gz', sha512: 'ccc', size: 50_000_000, downloadUrl: 'https://example/legacy.tar.gz' },
  ]);
  assert.equal(report.adoptionCount, 1);
  assert.equal(report.adoptedRepos[0].repo, 'obs');
  assert.equal(report.adoptedRepos[0].shadowedLegacyAssets, 1);
  assert.deepEqual(report.pendingTarRepos, ['legacy-app']);
});
