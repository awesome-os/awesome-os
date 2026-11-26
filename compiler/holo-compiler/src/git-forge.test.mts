/**
 * @file intersections/holo-compiler/git-forge.test.mts
 * @description Hermetic unit tests for `git-forge://` URI parsing, 7-Tuple HookEffectBit
 * admissibility, zero-`package.json` CasV11Store ingestion, and hardlink tree hydration.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CasV11Store } from './cas-v11-store.mts';
import {
  B8G_ABI_MAGIC_V3,
  DEFAULT_SAFE_HOOK_MASK,
  HookEffectBit,
  evaluateHookAdmissibility,
  hydrateGitForgeTree,
  loadHoloForgeManifest,
  parseGitForgeUri,
  resolveGitForgeToCasV11,
} from './git-forge.mts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseGitForgeUri', () => {
  it('parses minimal repository:// URI without subpath or query', () => {
    const parsed = parseGitForgeUri('repository://github.com/awesome-os/b8g-core@v1.4.0');
    assert.equal(parsed.protocol, 'repository://');
    assert.equal(parsed.raw, 'repository://github.com/awesome-os/b8g-core@v1.4.0');
    assert.equal(parsed.host, 'github.com');
    assert.equal(parsed.org, 'awesome-os');
    assert.equal(parsed.repo, 'b8g-core');
    assert.equal(parsed.ref, 'v1.4.0');
    assert.equal(parsed.subpath, null);
    assert.equal(parsed.hook, null);
    assert.equal(parsed.target, null);
  });

  it('normalizes legacy git-forge:// alias to canonical repository://', () => {
    const parsed = parseGitForgeUri('git-forge://github.com/awesome-os/b8g-core@v1.4.0#src/lib');
    assert.equal(parsed.protocol, 'repository://');
    assert.equal(parsed.raw, 'repository://github.com/awesome-os/b8g-core@v1.4.0#src/lib');
    assert.equal(parsed.subpath, 'src/lib');
  });

  it('parses repository:// URI with #subpath and ?hook=...&target=...', () => {
    const parsed = parseGitForgeUri(
      'repository://codeberg.org/awesome-os/sectium@deadbeef#src/kernel?hook=compile&target=x86_64-linux-musl',
    );
    assert.equal(parsed.protocol, 'repository://');
    assert.equal(parsed.host, 'codeberg.org');
    assert.equal(parsed.org, 'awesome-os');
    assert.equal(parsed.repo, 'sectium');
    assert.equal(parsed.ref, 'deadbeef');
    assert.equal(parsed.subpath, 'src/kernel');
    assert.equal(parsed.hook, 'compile');
    assert.equal(parsed.target, 'x86_64-linux-musl');
  });

  it('parses URI with RFC 3986 ?query#subpath ordering as well', () => {
    const parsed = parseGitForgeUri(
      'repository://github.com/awesome-os/holo@main?hook=build&target=wasm32-wasi#crates/abi',
    );
    assert.equal(parsed.protocol, 'repository://');
    assert.equal(parsed.subpath, 'crates/abi');
    assert.equal(parsed.hook, 'build');
    assert.equal(parsed.target, 'wasm32-wasi');
  });

  it('rejects invalid schemes and missing @ref', () => {
    assert.throws(() => parseGitForgeUri('https://github.com/awesome-os/core@main'), /scheme/i);
    assert.throws(() => parseGitForgeUri('repository://github.com/awesome-os/core'), /@<ref>/);
    assert.throws(() => parseGitForgeUri('repository://github.com/awesome-os/core@'), /@<ref>/);
  });

  it('rejects path traversal (..) in #subpath', () => {
    assert.throws(
      () => parseGitForgeUri('repository://github.com/awesome-os/core@main#../etc/passwd'),
      /traversal/i,
    );
    assert.throws(
      () => parseGitForgeUri('repository://github.com/awesome-os/core@main#src/../../secret'),
      /traversal/i,
    );
    assert.throws(
      () => parseGitForgeUri('repository://github.com/awesome-os/core@main#%2e%2e/escape'),
      /traversal/i,
    );
  });

  it('rejects 127.0.0.1 and localhost loopback hosts (B8G016)', () => {
    assert.throws(
      () => parseGitForgeUri('repository://127.0.0.1/awesome-os/core@main'),
      /B8G016/,
    );
    assert.throws(
      () => parseGitForgeUri('repository://127.0.0.1:8080/awesome-os/core@main'),
      /B8G016/,
    );
    assert.throws(
      () => parseGitForgeUri('repository://localhost/awesome-os/core@main'),
      /B8G016/,
    );
    assert.throws(
      () => parseGitForgeUri('repository://[::1]:9000/awesome-os/core@main'),
      /B8G016/,
    );
  });
});

describe('evaluateHookAdmissibility (7-Tuple EffectBit gate)', () => {
  it('admits FS_READ | CAS_WRITE | WASI_EXEC under default safe mask', () => {
    const res = evaluateHookAdmissibility(
      {
        name: 'compile-wasi',
        entry: 'hooks/compile.wasm',
        effects: HookEffectBit.FS_READ | HookEffectBit.CAS_WRITE | HookEffectBit.WASI_EXEC,
      },
      DEFAULT_SAFE_HOOK_MASK,
    );
    assert.equal(res.allowed, true);
    assert.equal(res.deniedBits, 0);
  });

  it('unconditionally rejects NET_REMOTE even if caller passes NET_REMOTE in grantedMask', () => {
    const res = evaluateHookAdmissibility(
      {
        name: 'exfiltrate',
        effects: HookEffectBit.FS_READ | HookEffectBit.NET_REMOTE,
      },
      DEFAULT_SAFE_HOOK_MASK | HookEffectBit.NET_REMOTE,
    );
    assert.equal(res.allowed, false);
    assert.equal((res.deniedBits & HookEffectBit.NET_REMOTE) !== 0, true);
    assert.match(res.reason, /NET_REMOTE/);
  });

  it('rejects capability bits outside grantedMask', () => {
    const res = evaluateHookAdmissibility(
      {
        name: 'needs-wasi',
        effects: HookEffectBit.FS_READ | HookEffectBit.WASI_EXEC,
      },
      HookEffectBit.FS_READ,
    );
    assert.equal(res.allowed, false);
    assert.equal(res.deniedBits, HookEffectBit.WASI_EXEC);
  });
});

describe('resolveGitForgeToCasV11 + hydrateGitForgeTree round-trip', () => {
  it('ingests a zero-package.json repo into CasV11Store, emits dual provenance, and hydrates via hardlinks', () => {
    const workRoot = makeTempDir('holo-git-forge-');
    const repoDir = path.join(workRoot, 'repo');
    const casRoot = path.join(workRoot, 'cas', 'v11');
    const destDir = path.join(workRoot, 'hydrated');

    // Create a zero-package.json repo with holo-forge.json and nested source files
    fs.mkdirSync(path.join(repoDir, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const manifestJson = {
      name: 'sectium-zero-pkg',
      version: '0.1.0',
      abiMagic: B8G_ABI_MAGIC_V3,
      entry: 'src/core/main.c',
      hooks: {
        build: {
          entry: 'hooks/build.wasm',
          effects: HookEffectBit.FS_READ | HookEffectBit.CAS_WRITE | HookEffectBit.WASI_EXEC,
        },
        phoneHome: {
          entry: 'hooks/bad.wasm',
          effects: HookEffectBit.FS_READ | HookEffectBit.NET_REMOTE,
        },
      },
    };
    fs.writeFileSync(
      path.join(repoDir, 'holo-forge.json'),
      JSON.stringify(manifestJson, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'core', 'main.c'),
      'int b8g_main(void) { return 0; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      '# Zero package.json repository\n',
      'utf8',
    );

    // Confirm zero package.json exists
    assert.equal(fs.existsSync(path.join(repoDir, 'package.json')), false);

    const loadedManifest = loadHoloForgeManifest(repoDir);
    assert.ok(loadedManifest);
    assert.equal(loadedManifest.name, 'sectium-zero-pkg');

    const casStore = new CasV11Store(casRoot);
    try {
      const compiledBytes = Buffer.from('B8G_ABI_V3_COMPILED_BINARY_PAYLOAD', 'utf8');
      const lockNode = resolveGitForgeToCasV11(
        'repository://github.com/awesome-os/sectium-zero-pkg@v0.1.0?target=x86_64-linux-musl',
        repoDir,
        casStore,
        { artifactBytes: compiledBytes },
      );

      // Verify dual Source -> Binary lockfile node
      assert.equal(lockNode.protocol, 'repository://');
      assert.equal(lockNode.abiMagic, B8G_ABI_MAGIC_V3);
      assert.equal(lockNode.source.host, 'github.com');
      assert.equal(lockNode.source.org, 'awesome-os');
      assert.equal(lockNode.source.repo, 'sectium-zero-pkg');
      assert.equal(lockNode.source.ref, 'v0.1.0');
      assert.equal(lockNode.source.subpath, null);
      assert.equal(lockNode.source.fileCount, 3); // README.md, holo-forge.json, src/core/main.c (.git ignored)
      assert.match(lockNode.source.treeSha512, /^[0-9a-f]{128}$/);

      assert.ok(lockNode.artifact);
      assert.equal(lockNode.artifact.size, compiledBytes.byteLength);
      assert.equal(lockNode.artifact.target, 'x86_64-linux-musl');
      assert.equal(fs.existsSync(lockNode.artifact.blobPath), true);

      // Verify hook evaluations (build allowed, phoneHome denied)
      const buildHook = lockNode.hooksEvaluated.find((h) => h.name === 'build');
      const badHook = lockNode.hooksEvaluated.find((h) => h.name === 'phoneHome');
      assert.ok(buildHook);
      assert.equal(buildHook.allowed, true);
      assert.ok(badHook);
      assert.equal(badHook.allowed, false);

      // Hydrate entire tree from CasV11Store via hardlinks
      const hydrated = hydrateGitForgeTree(lockNode.source.treeSha512, casStore, destDir);
      assert.equal(hydrated.fileCount, 3);
      assert.equal(hydrated.hardlinkedCount, 3);
      assert.equal(hydrated.copiedCount, 0);
      assert.deepEqual(hydrated.files, [
        'README.md',
        'holo-forge.json',
        'src/core/main.c',
      ]);

      // Verify byte-for-byte content fidelity
      assert.equal(
        fs.readFileSync(path.join(destDir, 'src', 'core', 'main.c'), 'utf8'),
        'int b8g_main(void) { return 0; }\n',
      );
      assert.equal(
        fs.readFileSync(path.join(destDir, 'README.md'), 'utf8'),
        '# Zero package.json repository\n',
      );
    } finally {
      casStore.close();
    }
  });
});
