import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyManifestEd25519 } from '../../security/verified-boot.mts';
import {
  type DistroBootstrapManifest,
  renderDualSlotLimineConf,
  renderOmahaChannelManifest,
  renderOsRelease,
  renderSystemDefinitionJson,
  renderUnifiedNetbootIpxe,
  STAGE_DEFINITIONS,
  validateDistroManifest,
} from './distro-spec.mts';
import { runDistroBootstrap } from './holo-distro-bootstrap.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'awesomeos-v1.0.manifest.json');

describe('os/bootstrap — Unified 6-Stage Holo v11 Distro Bootstrap Framework', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as DistroBootstrapManifest;

  it('defines 6 canonical reusable stages and validates DistroBootstrapManifest invariants', () => {
    assert.equal(STAGE_DEFINITIONS.length, 6);
    validateDistroManifest(manifest);

    assert.throws(
      () =>
        validateDistroManifest({
          ...manifest,
          channels: { ...manifest.channels, casGlobalManifestUrl: 'https://example.com/b8g-ghost/cas-v1' },
        }),
      /prohibited legacy b8g-ghost or cas-v1/i,
    );
  });

  it('synthesizes zero-drift /etc/os-release, dual-slot Limine, unified iPXE, and system.json', () => {
    const osRel = renderOsRelease(manifest, 'aarch64');
    assert.ok(osRel.includes('NAME="AwesomeOS"'));
    assert.ok(osRel.includes('VERSION_ID="1.0-v11"'));
    assert.ok(osRel.includes('ARCH=aarch64'));
    assert.ok(osRel.includes('HOLO_KERNEL="7.3.6"'));
    assert.ok(osRel.includes('B8G_ABI_MAGIC_V3=0x33564742'));

    const limine = renderDualSlotLimineConf(manifest);
    assert.ok(limine.includes('wallpaper: boot():/boot/splash/awesome-os-1920x1080.bmp'));
    assert.ok(limine.includes('/boot/slot-a/vmlinuz'));
    assert.ok(limine.includes('/boot/slot-b/vmlinuz'));
    assert.ok(limine.includes('b8g.abi=v3 scx_holo=1'));

    const ipxe = renderUnifiedNetbootIpxe(manifest);
    assert.ok(ipxe.includes('#!ipxe'));
    assert.ok(ipxe.includes('vmlinuz-7.3.6-x86_64'));
    assert.ok(ipxe.includes('awesome.netboot=1'));

    const sysJson = renderSystemDefinitionJson(manifest);
    assert.ok(!sysJson.includes('b8g-ghost'));
    assert.ok(!sysJson.includes('awesome-os/sectium@main'));
    assert.ok(sysJson.includes('awesome-os/sectium-browser@main'));
    assert.ok(sysJson.includes('awesome-os/ladybird@main'));
  });

  it('signs Omaha A/B channel manifests with Ed25519 and executes offline bootstrap cleanly', () => {
    const omaha = renderOmahaChannelManifest(manifest, [
      {
        arch: 'x86_64',
        format: 'iso',
        filename: 'awesomeos-v1.0.0-x86_64.iso',
        downloadUrl: 'https://github.com/awesome-os/desktop/releases/download/v1.0.0/awesomeos-v1.0.0-x86_64.iso',
      },
    ]);
    const verified = verifyManifestEd25519(omaha);
    assert.equal(verified.valid, true);
    assert.equal(omaha.targetSlotPolicy, 'stage-standby-flip-atomic');

    const tmpWorkspace = mkdtempSync(join(tmpdir(), 'holo-bootstrap-test-'));
    try {
      const tmpMonorepo = join(tmpWorkspace, 'awesome-os');
      const tmpManifestPath = join(tmpMonorepo, 'os', 'bootstrap', 'awesomeos-v1.0.manifest.json');
      const tmpSplashGenPath = join(tmpMonorepo, 'os', 'bootloader', 'assets', 'generate-splash.mts');
      mkdirSync(dirname(tmpManifestPath), { recursive: true });
      mkdirSync(dirname(tmpSplashGenPath), { recursive: true });
      copyFileSync(MANIFEST_PATH, tmpManifestPath);
      copyFileSync(join(HERE, '..', 'bootloader', 'assets', 'generate-splash.mts'), tmpSplashGenPath);

      const result = runDistroBootstrap({
        manifestPath: tmpManifestPath,
        stageFilter: '2,3,6',
        offline: true,
        quiet: true,
        monorepoRoot: tmpMonorepo,
      });
      assert.equal(result.reports.filter((r) => r.status === 'done').length, 3);
      assert.ok(existsSync(result.receiptPath));
      assert.ok(result.receiptPath.startsWith(tmpMonorepo));
    } finally {
      rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });
});
