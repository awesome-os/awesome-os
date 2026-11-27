#!/usr/bin/env node
/**
 * @file os/bootstrap/holo-distro-bootstrap.mts
 * @description Canonical, generic, reusable 6-Stage Holo v11 Distro Bootstrap Orchestrator.
 *
 * Usage:
 *   node os/bootstrap/holo-distro-bootstrap.mts [--manifest os/bootstrap/awesomeos-v1.0.manifest.json]
 *     [--stage all|1..6|<stage-id>] [--offline] [--write-local-cas]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signManifestEd25519, verifyManifestEd25519 } from '../../security/verified-boot.mts';
import {
  type BootstrapStageId,
  type DistroBootstrapManifest,
  type OmahaArtifactEntry,
  renderDualSlotLimineConf,
  renderOmahaChannelManifest,
  renderOsRelease,
  renderSystemDefinitionJson,
  renderUnifiedNetbootIpxe,
  STAGE_DEFINITIONS,
  validateDistroManifest,
} from './distro-spec.mts';

export interface BootstrapRunOptions {
  readonly manifestPath?: string;
  readonly stageFilter?: string;
  readonly offline?: boolean;
  readonly writeLocalCas?: boolean;
  readonly quiet?: boolean;
  readonly monorepoRoot?: string;
}

export interface StageExecutionReport {
  readonly number: number;
  readonly id: BootstrapStageId;
  readonly title: string;
  readonly status: 'done' | 'skipped';
  readonly durationMs: number;
  readonly artifactsWritten: readonly string[];
  readonly notes: readonly string[];
}

export interface BootstrapReceiptPayload {
  readonly schema: 'holo.distro-bootstrap-receipt.v1';
  readonly distroId: string;
  readonly distroName: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly offlineMode: boolean;
  readonly completedAt: string;
  readonly stages: readonly StageExecutionReport[];
}

function writeTextEnsureDir(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function copyEnsureDir(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function runNodeScript(scriptPath: string, args: readonly string[] = [], cwd?: string, quiet = false): void {
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: cwd ?? dirname(scriptPath),
    stdio: quiet ? 'ignore' : 'inherit',
    env: process.env,
  });
}

function matchesStageFilter(stageNumber: number, stageId: BootstrapStageId, filter: string): boolean {
  if (!filter || filter === 'all') return true;
  const tokens = filter.split(',').map((t) => t.trim().toLowerCase());
  return tokens.includes(String(stageNumber)) || tokens.includes(stageId);
}

export function runDistroBootstrap(options: BootstrapRunOptions = {}): {
  manifest: DistroBootstrapManifest;
  reports: readonly StageExecutionReport[];
  receiptPath: string;
} {
  const bootstrapDir = dirname(fileURLToPath(import.meta.url));
  const monorepoRoot = resolve(options.monorepoRoot ?? join(bootstrapDir, '..', '..'));
  const mirrorRoot = resolve(monorepoRoot, '..');
  const workspaceRoot = resolve(mirrorRoot, '..', '..');

  const manifestPath = resolve(
    options.manifestPath ?? join(bootstrapDir, 'awesomeos-v1.0.manifest.json'),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DistroBootstrapManifest;
  validateDistroManifest(manifest);

  const stageFilter = options.stageFilter ?? 'all';
  const offline = Boolean(options.offline);
  const writeLocalCas = Boolean(options.writeLocalCas);
  const quiet = Boolean(options.quiet);
  const log = (...args: unknown[]): void => {
    if (!quiet) console.log(...args);
  };

  const t2Dir = join(mirrorRoot, 't2linux-baseline');
  const holoV11Dir = join(mirrorRoot, 'holo-v11');
  const desktopDir = join(mirrorRoot, 'desktop');
  const bootloaderMirrorDir = join(mirrorRoot, 'bootloader');
  const installerDir = join(mirrorRoot, 'installer');
  const hostManagerDir = join(mirrorRoot, 'host-manager');

  const reports: StageExecutionReport[] = [];

  for (const def of STAGE_DEFINITIONS) {
    if (!matchesStageFilter(def.number, def.id, stageFilter)) {
      reports.push({
        number: def.number,
        id: def.id,
        title: def.title,
        status: 'skipped',
        durationMs: 0,
        artifactsWritten: [],
        notes: ['Skipped by --stage filter'],
      });
      continue;
    }

    const t0 = Date.now();
    const written: string[] = [];
    const notes: string[] = [];
    log(`\n[BOOTSTRAP STAGE ${def.number}/6] ${def.title} (${def.id})`);

    if (def.id === 'bump-upstreams') {
      if (!offline && existsSync(join(t2Dir, 'scripts', 'track-live-upstreams.mts'))) {
        runNodeScript(join(t2Dir, 'scripts', 'track-live-upstreams.mts'), [], t2Dir, quiet);
        runNodeScript(join(t2Dir, 'scripts', 'bump-all-max-pins.mts'), [], t2Dir, quiet);
        runNodeScript(join(t2Dir, 'scripts', 'generate-max-version-lock.mts'), [], t2Dir, quiet);
        written.push('t2linux-baseline/catalog/live-upstream-tracker.json');
        written.push('t2linux-baseline/catalog/v11-package-universe.json');
        written.push('t2linux-baseline/catalog/max-version-lock.json');
      } else {
        notes.push(offline ? 'Offline mode: retained locked upstream catalog' : 'Sibling t2linux-baseline mirror not present');
      }

      if (!offline && existsSync(join(holoV11Dir, 'scripts', 'sync-ecosystem-reports.mts'))) {
        runNodeScript(join(holoV11Dir, 'scripts', 'sync-ecosystem-reports.mts'), ['--local'], holoV11Dir, quiet);
        runNodeScript(join(holoV11Dir, 'scripts', 'collect-oversight-telemetry.mts'), [], holoV11Dir, quiet);
        written.push('holo-v11/reports/ECOSYSTEM-SCOREBOARD.md');
        written.push('holo-v11/reports/oversight-telemetry.json');
      }

      if (existsSync(join(holoV11Dir, 'dashboard', 'oversight.html'))) {
        copyEnsureDir(
          join(holoV11Dir, 'dashboard', 'oversight.html'),
          join(monorepoRoot, 'registry', 'dashboard', 'oversight.html'),
        );
        written.push('registry/dashboard/oversight.html');
      }
      if (existsSync(join(holoV11Dir, 'reports', 'ECOSYSTEM-SCOREBOARD.md'))) {
        copyEnsureDir(
          join(holoV11Dir, 'reports', 'ECOSYSTEM-SCOREBOARD.md'),
          join(monorepoRoot, 'registry', 'reports', 'ECOSYSTEM-SCOREBOARD.md'),
        );
        written.push('registry/reports/ECOSYSTEM-SCOREBOARD.md');
      }
    } else if (def.id === 'stamp-boot-substrate') {
      const splashGen = join(monorepoRoot, 'os', 'bootloader', 'assets', 'generate-splash.mts');
      runNodeScript(splashGen, [], monorepoRoot, quiet);
      written.push('os/bootloader/assets/splash/awesome-os-1920x1080.bmp');

      const limineConf = renderDualSlotLimineConf(manifest);
      const ipxeConf = renderUnifiedNetbootIpxe(manifest);

      writeTextEnsureDir(join(monorepoRoot, 'os', 'bootloader', 'limine', 'limine.conf'), limineConf);
      writeTextEnsureDir(join(monorepoRoot, 'os', 'bootloader', 'ipxe', 'boot.ipxe'), ipxeConf);
      written.push('os/bootloader/limine/limine.conf', 'os/bootloader/ipxe/boot.ipxe');

      if (existsSync(bootloaderMirrorDir)) {
        writeTextEnsureDir(join(bootloaderMirrorDir, 'limine', 'limine.conf'), limineConf);
        writeTextEnsureDir(join(bootloaderMirrorDir, 'ipxe', 'boot.ipxe'), ipxeConf);
        written.push('bootloader/limine/limine.conf', 'bootloader/ipxe/boot.ipxe');
      }

      if (existsSync(desktopDir)) {
        writeTextEnsureDir(join(desktopDir, 'boot', 'config', 'limine.conf'), limineConf);
        writeTextEnsureDir(join(desktopDir, 'boot', 'netboot', 'boot.ipxe'), ipxeConf);
        const splash1080 = join(monorepoRoot, 'os', 'bootloader', 'assets', 'splash', 'awesome-os-1920x1080.bmp');
        if (existsSync(splash1080)) {
          copyEnsureDir(splash1080, join(desktopDir, 'boot', 'splash', 'awesome-os-1920x1080.bmp'));
        }
        written.push('desktop/boot/config/limine.conf', 'desktop/boot/netboot/boot.ipxe', 'desktop/boot/splash/awesome-os-1920x1080.bmp');
      }
    } else if (def.id === 'assemble-v11-rootfs') {
      const sysJson = renderSystemDefinitionJson(manifest);
      writeTextEnsureDir(join(monorepoRoot, 'os', 'rootfs', 'etc', 'awesome-os', 'system.json'), sysJson);
      written.push('os/rootfs/etc/awesome-os/system.json');

      for (const arch of manifest.architectures) {
        const osRel = renderOsRelease(manifest, arch);
        writeTextEnsureDir(join(monorepoRoot, 'os', 'rootfs', 'etc', `os-release.${arch}`), osRel);
        written.push(`os/rootfs/etc/os-release.${arch}`);
      }
      writeTextEnsureDir(
        join(monorepoRoot, 'os', 'rootfs', 'etc', 'os-release'),
        renderOsRelease(manifest, 'x86_64'),
      );
      written.push('os/rootfs/etc/os-release');

      if (existsSync(desktopDir)) {
        writeTextEnsureDir(join(desktopDir, 'boot', 'config', 'system.json'), sysJson);
        writeTextEnsureDir(join(desktopDir, 'boot', 'config', 'os-release.x86_64'), renderOsRelease(manifest, 'x86_64'));
        writeTextEnsureDir(join(desktopDir, 'boot', 'config', 'os-release.aarch64'), renderOsRelease(manifest, 'aarch64'));
        written.push('desktop/boot/config/system.json', 'desktop/boot/config/os-release.x86_64', 'desktop/boot/config/os-release.aarch64');
      }
    } else if (def.id === 'build-and-gate-images') {
      const zigWin = join(workspaceRoot, 'bin', 'zig.cmd');
      const zigKernelDir = join(monorepoRoot, 'os', 'holo-microkernel-zig');
      if (process.platform === 'win32' && existsSync(zigWin) && existsSync(join(zigKernelDir, 'kernel.zig'))) {
        const elfOut = join(zigKernelDir, 'zig-out', 'bin', 'holo-microkernel-riscv64.elf');
        mkdirSync(dirname(elfOut), { recursive: true });
        execFileSync(
          'cmd.exe',
          [
            '/c',
            zigWin,
            'build-exe',
            'kernel.zig',
            '-target',
            'riscv64-freestanding-none',
            '-mcmodel=medium',
            '-O',
            'ReleaseSmall',
            '-fno-strip',
            '--script',
            'linker.ld',
            `-femit-bin=${elfOut}`,
          ],
          { cwd: zigKernelDir, stdio: 'inherit' },
        );
        written.push('os/holo-microkernel-zig/zig-out/bin/holo-microkernel-riscv64.elf');
      } else {
        notes.push('Zig binary built in CI or pre-built artifact retained');
      }

      runNodeScript(
        '--test',
        [
          join(monorepoRoot, 'os', 'bootloader', 'bootloader.test.mts'),
          join(monorepoRoot, 'os', 'kernel', 'holo-kbuild.test.mts'),
          join(monorepoRoot, 'security', 'verified-boot.test.mts'),
        ],
        monorepoRoot,
        quiet,
      );
      notes.push('Verified bootloader, holo-kbuild 7.3.6, and Ed25519 verified-boot gates');
    } else if (def.id === 'warm-planetary-cas') {
      if (!offline && existsSync(join(holoV11Dir, 'scripts', 'warm-global-cas.mts'))) {
        const warmArgs = writeLocalCas ? ['--write-local-cas'] : [];
        runNodeScript(join(holoV11Dir, 'scripts', 'warm-global-cas.mts'), warmArgs, holoV11Dir, quiet);
        written.push('holo-v11/index/cas-v11-global-manifest.json', 'holo-v11/index/holo-compiler-lockfile.json');
      } else {
        notes.push(offline ? 'Offline mode: verifying existing CAS manifest' : 'holo-v11 mirror not present');
      }

      const globalManifestPath = join(holoV11Dir, 'index', 'cas-v11-global-manifest.json');
      if (existsSync(globalManifestPath)) {
        const rawManifest = readFileSync(globalManifestPath, 'utf8');
        if (rawManifest.includes('b8g-ghost')) {
          throw new Error('Planetary CAS manifest still contains archived b8g-ghost entries!');
        }
        const parsedManifest = JSON.parse(rawManifest) as Parameters<typeof verifyManifestEd25519>[0];
        if (parsedManifest.signature) {
          const check = verifyManifestEd25519(parsedManifest);
          if (!check.valid) {
            throw new Error(`cas-v11-global-manifest.json failed Ed25519 verification: ${check.reason}`);
          }
          notes.push(`Verified Ed25519 signature on cas-v11-global-manifest.json (key=${parsedManifest.signature.keyId})`);
        }
        copyEnsureDir(
          globalManifestPath,
          join(monorepoRoot, 'registry', 'index', 'cas-v11-global-manifest.json'),
        );
        copyEnsureDir(
          join(holoV11Dir, 'index', 'holo-compiler-lockfile.json'),
          join(monorepoRoot, 'registry', 'index', 'holo-compiler-lockfile.json'),
        );
        written.push('registry/index/cas-v11-global-manifest.json', 'registry/index/holo-compiler-lockfile.json');
      }

      // Stage hot-path direct-HTTP CDN shards (v11/files/<aa>/<sha512>)
      const hotCandidates: ReadonlyArray<{ readonly label: string; readonly path: string; readonly exec: boolean }> = [
        {
          label: 'sectium_cp.wasm',
          path: join(workspaceRoot, 'sections', 'sectium-cloud-control-plane', 'dist', 'sectium_cp.wasm'),
          exec: true,
        },
        {
          label: 'holo-microkernel-riscv64.elf',
          path: join(monorepoRoot, 'os', 'holo-microkernel-zig', 'zig-out', 'bin', 'holo-microkernel-riscv64.elf'),
          exec: true,
        },
        {
          label: 'awesomeos-shell.html',
          path: join(monorepoRoot, 'os', 'shell', 'awesomeos-shell.html'),
          exec: false,
        },
        {
          label: 'awesome-os-1920x1080.bmp',
          path: join(monorepoRoot, 'os', 'bootloader', 'assets', 'splash', 'awesome-os-1920x1080.bmp'),
          exec: false,
        },
      ];

      const shardIndex: Array<{ label: string; sha512: string; bytes: number; cdnRelPath: string; url: string }> = [];
      for (const item of hotCandidates) {
        if (!existsSync(item.path)) continue;
        const buf = readFileSync(item.path);
        const sha512 = createHash('sha512').update(buf).digest('hex');
        const blobName = item.exec ? `${sha512}-exec` : sha512;
        const rel = `v11/files/${sha512.slice(0, 2)}/${blobName}`;
        if (existsSync(holoV11Dir)) {
          copyEnsureDir(item.path, join(holoV11Dir, 'cdn-shards', rel));
        }
        shardIndex.push({
          label: item.label,
          sha512,
          bytes: buf.byteLength,
          cdnRelPath: rel,
          url: `${manifest.channels.casCdnFilesBaseUrl}/${sha512.slice(0, 2)}/${blobName}`,
        });
      }
      writeTextEnsureDir(
        join(monorepoRoot, 'registry', 'index', 'hot-cdn-shards.json'),
        `${JSON.stringify({ schema: 'awesome-os.hot-cdn-shards.v1', generatedAt: new Date().toISOString(), shards: shardIndex }, null, 2)}\n`,
      );
      written.push('registry/index/hot-cdn-shards.json');
    } else if (def.id === 'rollout-channels') {
      if (existsSync(join(installerDir, 'scripts', 'build-web-bundle.mts'))) {
        runNodeScript(join(installerDir, 'scripts', 'build-web-bundle.mts'), [], installerDir, quiet);
        copyEnsureDir(
          join(installerDir, 'web', 'v11-bundle.json'),
          join(monorepoRoot, 'installer', 'web', 'v11-bundle.json'),
        );
        written.push('installer/web/v11-bundle.json');
      }

      const releaseBase = `https://github.com/${manifest.githubOrg}/${manifest.desktopImageRepo}/releases/download/${manifest.releaseTag}`;
      const monoReleaseBase = `https://github.com/${manifest.githubOrg}/${manifest.canonicalRepo}/releases/download/${manifest.releaseTag}`;
      const omahaArtifacts: readonly OmahaArtifactEntry[] = [
        {
          arch: 'x86_64',
          format: 'iso',
          filename: `awesomeos-${manifest.releaseTag}-x86_64.iso`,
          downloadUrl: `${releaseBase}/awesomeos-${manifest.releaseTag}-x86_64.iso`,
        },
        {
          arch: 'x86_64',
          format: 'qcow2',
          filename: `awesomeos-${manifest.releaseTag}-x86_64.qcow2`,
          downloadUrl: `${releaseBase}/awesomeos-${manifest.releaseTag}-x86_64.qcow2`,
        },
        {
          arch: 'aarch64',
          format: 'iso',
          filename: `awesomeos-${manifest.releaseTag}-aarch64.iso`,
          downloadUrl: `${releaseBase}/awesomeos-${manifest.releaseTag}-aarch64.iso`,
        },
        {
          arch: 'aarch64',
          format: 'qcow2',
          filename: `awesomeos-${manifest.releaseTag}-aarch64.qcow2`,
          downloadUrl: `${releaseBase}/awesomeos-${manifest.releaseTag}-aarch64.qcow2`,
        },
        {
          arch: 'riscv64',
          format: 'elf',
          filename: 'holo-microkernel-riscv64.elf',
          downloadUrl: `${monoReleaseBase}/holo-microkernel-riscv64.elf`,
        },
        {
          arch: 'wasm32-wasi',
          format: 'html',
          filename: 'awesomeos-shell.html',
          downloadUrl: 'https://awesome-os.com/shell/',
        },
      ];

      const stableOmaha = renderOmahaChannelManifest(manifest, omahaArtifacts, 'stable');
      const stableJson = `${JSON.stringify(stableOmaha, null, 2)}\n`;
      writeTextEnsureDir(join(monorepoRoot, 'fleet', 'channels', 'stable.json'), stableJson);
      written.push('fleet/channels/stable.json');
      if (existsSync(hostManagerDir)) {
        writeTextEnsureDir(join(hostManagerDir, 'channels', 'stable.json'), stableJson);
        written.push('host-manager/channels/stable.json');
      }

      if (!offline && existsSync(join(holoV11Dir, 'scripts', 'collect-oversight-telemetry.mts'))) {
        runNodeScript(join(holoV11Dir, 'scripts', 'collect-oversight-telemetry.mts'), [], holoV11Dir, quiet);
        copyEnsureDir(
          join(holoV11Dir, 'reports', 'oversight-telemetry.json'),
          join(monorepoRoot, 'registry', 'reports', 'oversight-telemetry.json'),
        );
        written.push('registry/reports/oversight-telemetry.json');
      }
    }

    reports.push({
      number: def.number,
      id: def.id,
      title: def.title,
      status: 'done',
      durationMs: Date.now() - t0,
      artifactsWritten: written,
      notes,
    });
  }

  const signedReceipt = signManifestEd25519<BootstrapReceiptPayload>({
    schema: 'holo.distro-bootstrap-receipt.v1',
    distroId: manifest.id,
    distroName: manifest.name,
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    abiMagic: manifest.abiMagic,
    casLayout: manifest.casLayout,
    offlineMode: offline,
    completedAt: new Date().toISOString(),
    stages: reports,
  });

  const receiptPath = join(monorepoRoot, 'os', 'bootstrap', 'last-bootstrap-receipt.json');
  writeTextEnsureDir(receiptPath, `${JSON.stringify(signedReceipt, null, 2)}\n`);

  log('\n====================================================================');
  log(`  Holo Distro Bootstrap Complete: ${manifest.name} ${manifest.version} (${manifest.releaseTag})`);
  log(`  Receipt: ${receiptPath} (key=${signedReceipt.signature.keyId})`);
  for (const r of reports) {
    log(`  [Stage ${r.number}] ${r.status.toUpperCase().padEnd(7)} ${r.id.padEnd(24)} (${r.durationMs} ms)`);
  }
  log('====================================================================');

  return { manifest, reports, receiptPath };
}

function parseCliArgs(argv: readonly string[]): BootstrapRunOptions {
  let manifestPath: string | undefined;
  let stageFilter = 'all';
  let offline = false;
  let writeLocalCas = false;
  let monorepoRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--manifest' && argv[i + 1]) {
      manifestPath = argv[++i];
    } else if (a.startsWith('--manifest=')) {
      manifestPath = a.slice('--manifest='.length);
    } else if (a === '--stage' && argv[i + 1]) {
      stageFilter = argv[++i]!;
    } else if (a.startsWith('--stage=')) {
      stageFilter = a.slice('--stage='.length);
    } else if (a === '--monorepo-root' && argv[i + 1]) {
      monorepoRoot = argv[++i];
    } else if (a.startsWith('--monorepo-root=')) {
      monorepoRoot = a.slice('--monorepo-root='.length);
    } else if (a === '--offline') {
      offline = true;
    } else if (a === '--write-local-cas') {
      writeLocalCas = true;
    }
  }
  return { manifestPath, stageFilter, offline, writeLocalCas, ...(monorepoRoot ? { monorepoRoot } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDistroBootstrap(parseCliArgs(process.argv.slice(2)));
}
