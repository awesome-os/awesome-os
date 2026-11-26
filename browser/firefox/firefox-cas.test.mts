import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  B8G_ABI_MAGIC_V3,
  DEFAULT_FIREFOX_FLAGS,
  FIREFOX_CLI_VERSION,
  HOLO_CAS_BASE_URL,
  applyKeepLast5Pin,
  buildLaunchPlan,
  fetchHoloIndex,
  getFirefoxAssetKey,
  getFirefoxExecutableRelPath,
  loadFirefoxProfile,
  loadMozconfig,
  parseCliArgs,
  resolveV11BlobPath,
  tryResolveFirefoxEntry,
  verifySharedV11Deps,
  type HoloCasEntry,
  type HoloIndex,
} from './index.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_PATH = resolve(HERE, 'cli.mts');
const LAUNCHER_C_PATH = resolve(HERE, 'firefox_launcher.c');

function findCCompiler(): { kind: 'zig-cmd' | 'native'; bin: string } {
  if (process.platform === 'win32') {
    const zigCmdCandidates = [
      resolve(REPO_ROOT, '..', '..', '..', 'bin', 'zig.cmd'),
      'E:\\awesome-os\\bin\\zig.cmd',
    ];
    for (const candidate of zigCmdCandidates) {
      if (existsSync(candidate)) {
        return { kind: 'zig-cmd', bin: candidate };
      }
    }
  }
  const candidates = process.platform === 'win32' ? ['zig', 'clang', 'gcc', 'cc'] : ['cc', 'gcc', 'clang', 'zig'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return { kind: 'native', bin: candidate };
    } catch {
      // Try next compiler
    }
  }
  throw new Error('No C11 compiler (zig.cmd / cc / gcc / clang) found for firefox_launcher.c test');
}

function compileC11Launcher(srcPath: string, outPath: string): void {
  const compiler = findCCompiler();
  const cflags = ['-std=c11', '-Wall', '-Wextra', '-Werror', srcPath, '-o', outPath];
  if (compiler.kind === 'zig-cmd') {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    execFileSync(comspec, ['/d', '/c', compiler.bin, 'cc', ...cflags], { stdio: 'pipe' });
    return;
  }
  const args = compiler.bin === 'zig' ? ['cc', ...cflags] : cflags;
  execFileSync(compiler.bin, args, { stdio: 'pipe' });
}

test('firefox-v11-profile.json enforces 24/24 shared v11 libs, zero telemetry policies, and Gecko/Stylo/WebRender/Fission/RLBox flags', () => {
  const profile = loadFirefoxProfile();
  assert.equal(profile.schema, 'awesome-os.firefox-v11-profile.v1');
  assert.equal(profile.abiMagic, B8G_ABI_MAGIC_V3);
  assert.equal(profile.casLayout, 'v11');
  assert.equal(profile.runtime.totalLibs, 24);
  assert.equal(profile.runtime.coveredInV11, 24);
  assert.equal(profile.runtime.coveragePercent, 100);
  assert.equal(profile.sharedLibraries.length, 24);

  const expected24 = [
    'zlib', 'zstd', 'sqlite', 'vulkan-loader', 'libjpeg-turbo', 'libpng',
    'brotli', 'icu4c', 'libwebp', 'ffmpeg', 'harfbuzz', 'libffi',
    'dav1d', 'freetype', 'expat', 'fontconfig', 'aom', 'libopus',
    'libvpx', 'cairo', 'libevent', 'nspr', 'nss', 'pixman',
  ];
  const actualIds = profile.sharedLibraries.map((lib) => lib.id);
  for (const id of expected24) {
    assert.ok(actualIds.includes(id), `Missing shared v11 library: ${id}`);
  }
  assert.ok(profile.sharedLibraries.every((lib) => lib.casTier === 'v11' && lib.status === 'v11-shared'));

  assert.equal(profile.policies.DisableTelemetry, true);
  assert.equal(profile.policies.DisableFirefoxStudies, true);
  assert.equal(profile.policies.DisablePocket, true);
  assert.equal(profile.policies.DisableAppUpdate, true);
  assert.equal(profile.policies.DisableSystemAddonUpdate, true);
  assert.equal(profile.policies.Preferences['datareporting.healthreport.uploadEnabled']?.Value, false);
  assert.equal(profile.policies.Preferences['toolkit.telemetry.enabled']?.Value, false);
  assert.equal(profile.policies.Preferences['extensions.pocket.enabled']?.Value, false);

  assert.equal(profile.engineFlags.gecko.wayland, true);
  assert.equal(profile.engineFlags.stylo.parallelCssEngine, true);
  assert.equal(profile.engineFlags.webrender.enabled, true);
  assert.equal(profile.engineFlags.fission.autostart, true);
  assert.equal(profile.engineFlags.rlbox.wasmSandboxing, true);
});

test('mozconfig.holo-v11 enables all shared v11 system libs, RLBox WASM sandboxing, and strips Mozilla telemetry/updater', () => {
  const mozconfig = loadMozconfig();
  const requiredFlags = [
    '--with-system-icu',
    '--with-system-zlib',
    '--with-system-nspr',
    '--with-system-nss',
    '--with-system-libvpx',
    '--with-system-webp',
    '--with-system-jpeg',
    '--with-system-png',
    '--with-system-harfbuzz',
    '--with-system-dav1d',
    '--with-system-aom',
    '--with-system-pixman',
    '--with-system-cairo',
    '--with-system-libevent',
    '--enable-rlbox-wasm-sandboxing',
    '--disable-crashreporter',
    '--disable-updater',
    'MOZ_TELEMETRY_REPORTING=',
  ];
  for (const flag of requiredFlags) {
    assert.ok(mozconfig.includes(flag), `mozconfig.holo-v11 missing required option: ${flag}`);
  }

  const verify = verifySharedV11Deps();
  assert.equal(verify.ok, true);
  assert.equal(verify.totalLibs, 24);
  assert.equal(verify.coveredInV11, 24);
  assert.deepEqual(verify.missingMozconfigFlags, []);
  assert.equal(verify.telemetryStripped, true);
  assert.equal(verify.rlboxWasmSandboxing, true);
  assert.equal(verify.policiesZeroTelemetry, true);
});

test('hydrator resolves platform keys, v11 CAS paths, and Keep-Last-5 pins deterministically', async () => {
  assert.equal(getFirefoxAssetKey('win32', 'x64'), 'firefox-win64.tar.zst');
  assert.equal(getFirefoxAssetKey('linux', 'x64'), 'firefox-linux-x64.tar.zst');
  assert.equal(getFirefoxAssetKey('linux', 'arm64'), 'firefox-linux-arm64.tar.zst');
  assert.equal(getFirefoxAssetKey('darwin', 'arm64'), 'firefox-macos-arm64.tar.zst');
  assert.equal(getFirefoxExecutableRelPath('win32'), 'firefox.exe');
  assert.equal(getFirefoxExecutableRelPath('linux'), 'firefox');

  const sha512 = 'a'.repeat(128);
  const blobPath = resolveV11BlobPath('/var/lib/b8g/cas', sha512);
  assert.ok(blobPath.endsWith(join('v11', 'files', 'aa', sha512)));

  const prevSha = 'b'.repeat(128);
  const entry: HoloCasEntry = {
    filename: 'firefox-linux-x64.tar.zst',
    sha512,
    bytes: 72_000_000,
    version: '138.0.1',
    history: [{ sha512: prevSha, bytes: 71_000_000, version: '138.0.0' }],
  };
  const pinned = applyKeepLast5Pin(entry, prevSha);
  assert.equal(pinned.sha512, prevSha);
  assert.equal(pinned.version, '138.0.0');

  const key = getFirefoxAssetKey();
  const mockIndex: HoloIndex = {
    schema: 'awesome-os-cas-v11-manifest-v1',
    totalAssets: 1,
    entries: [
      {
        filename: key,
        sha512,
        size: 72_000_000,
        version: '138.0.1',
        downloadUrl: `${HOLO_CAS_BASE_URL}/${key}`,
      },
    ],
  };
  const idx = await fetchHoloIndex(true, async () => new Response(JSON.stringify(mockIndex), { status: 200 }));
  const resolved = await tryResolveFirefoxEntry(key, idx);
  assert.ok(resolved);
  assert.equal(resolved.sha512, sha512);
});

test('CLI executes --version, --mozconfig, --verify-deps, and --dry-run cleanly', async () => {
  const parsed = parseCliArgs(['--dry-run', '--mozconfig', 'https://awesome-os.com', '--', '--version']);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.showMozconfig, true);
  assert.deepEqual(parsed.forwardArgs, ['https://awesome-os.com', '--', '--version']);

  const versionOut = execFileSync(process.execPath, [CLI_PATH, '--version'], { encoding: 'utf8' }).trim();
  assert.match(versionOut, new RegExp(`^@awesome-os/firefox ${FIREFOX_CLI_VERSION} `));
  assert.ok(versionOut.includes(B8G_ABI_MAGIC_V3));
  assert.ok(versionOut.includes(getFirefoxAssetKey()));

  const mozOut = execFileSync(process.execPath, [CLI_PATH, '--mozconfig'], { encoding: 'utf8' });
  assert.ok(mozOut.includes('--with-system-pixman'));
  assert.ok(mozOut.includes('--with-system-cairo'));
  assert.ok(mozOut.includes('--enable-rlbox-wasm-sandboxing'));

  const depsOut = execFileSync(process.execPath, [CLI_PATH, '--verify-deps'], { encoding: 'utf8' });
  const depsJson = JSON.parse(depsOut) as ReturnType<typeof verifySharedV11Deps>;
  assert.equal(depsJson.ok, true);
  assert.equal(depsJson.totalLibs, 24);
  assert.equal(depsJson.coveredInV11, 24);

  const tmpDir = mkdtempSync(join(tmpdir(), 'firefox-holo-cli-'));
  try {
    const idxPath = join(tmpDir, 'index.json');
    const key = getFirefoxAssetKey();
    const sha512 = 'c'.repeat(128);
    writeFileSync(
      idxPath,
      JSON.stringify({
        schema: 'awesome-os-cas-v11-manifest-v1',
        totalAssets: 1,
        entries: [
          {
            filename: key,
            sha512,
            size: 72_000_000,
            version: '138.0.1',
            downloadUrl: `${HOLO_CAS_BASE_URL}/${key}`,
          },
        ],
      }),
    );

    const dryRunOut = execFileSync(process.execPath, [CLI_PATH, '--dry-run', 'https://awesome-os.com'], {
      encoding: 'utf8',
      env: { ...process.env, B8G_CAS_DIR: tmpDir, B8G_CAS_INDEX_PATH: idxPath },
    });
    const plan = JSON.parse(dryRunOut) as Awaited<ReturnType<typeof buildLaunchPlan>>;
    assert.equal(plan.version, FIREFOX_CLI_VERSION);
    assert.equal(plan.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(plan.casLayout, 'v11');
    assert.equal(plan.sharedLibsCount, 24);
    assert.equal(plan.telemetryDisabled, true);
    assert.equal(plan.rlboxWasmSandboxing, true);
    assert.deepEqual(plan.defaultFlags, [...DEFAULT_FIREFOX_FLAGS]);
    assert.equal(plan.firefox.assetKey, key);
    assert.equal(plan.firefox.status, 'resolved');
    assert.equal(plan.firefox.digest, sha512);
    assert.deepEqual(plan.forwardArgs, ['https://awesome-os.com']);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C11 firefox_launcher.c compiles cleanly (-Werror) and emits B8G_ABI_MAGIC_V3 receipts', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'firefox-c11-launcher-'));
  try {
    const binName = process.platform === 'win32' ? 'firefox_launcher.exe' : 'firefox_launcher';
    const outBin = join(tmpDir, binName);
    compileC11Launcher(LAUNCHER_C_PATH, outBin);

    const selfTestOut = execFileSync(outBin, ['--self-test'], { encoding: 'utf8' }).trim();
    assert.match(selfTestOut, /^firefox_launcher: PASS /);
    assert.ok(selfTestOut.includes(B8G_ABI_MAGIC_V3));
    assert.ok(selfTestOut.includes('shared_libs=24/24'));

    const verOut = execFileSync(outBin, ['--version'], { encoding: 'utf8' }).trim();
    assert.ok(verOut.includes('@awesome-os/firefox-launcher'));
    assert.ok(verOut.includes(B8G_ABI_MAGIC_V3));

    const dryOut = execFileSync(outBin, ['--dry-run'], { encoding: 'utf8' });
    const receipt = JSON.parse(dryOut) as {
      abiMagic: string;
      casLayout: string;
      sharedLibs: number;
      telemetryDisabled: boolean;
      rlboxWasmSandboxing: boolean;
      dryRun: boolean;
    };
    assert.equal(receipt.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(receipt.casLayout, 'v11');
    assert.equal(receipt.sharedLibs, 24);
    assert.equal(receipt.telemetryDisabled, true);
    assert.equal(receipt.rlboxWasmSandboxing, true);
    assert.equal(receipt.dryRun, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
