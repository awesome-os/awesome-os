import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

interface ToolchainEntry {
  id: string;
  repositoryUri: string;
  projectUri: string;
  casHardlinkMode: string;
  cacheProg?: string;
  role: string;
}

interface SelfhostMatrix {
  schema: string;
  abiMagic: string;
  casLayout: string;
  bootstrapProvider: string;
  nativeCore: ToolchainEntry[];
  projectedToolchains: ToolchainEntry[];
}

const here = dirname(fileURLToPath(import.meta.url));
const matrixPath = resolve(here, 'selfhost-matrix.json');
const rawMatrix = readFileSync(matrixPath, 'utf8');
const matrix = JSON.parse(rawMatrix) as SelfhostMatrix;

const REPO_URI_RE =
  /^repository:\/\/github\.com\/awesome-os\/[a-z0-9._-]+@[a-z0-9._/-]+(?:#[a-z0-9._/-]+)?$/;
const PROJECT_URI_RE =
  /^project:\/\/[a-z0-9-]+\/[a-z0-9._-]+\?from=repository:\/\/github\.com\/awesome-os\/[a-z0-9._-]+@[a-z0-9._/-]+&mode=(?:ephemeral|persistent)$/;

describe('holo-compiler selfhost-matrix.json', () => {
  it('validates top-level schema, ABI magic, CAS layout, and bootstrapProvider', () => {
    assert.equal(matrix.schema, 'awesome-os-selfhost-toolchain-matrix-v1');
    assert.equal(matrix.abiMagic, '0x33564742');
    assert.equal(matrix.casLayout, 'v11');
    assert.equal(
      matrix.bootstrapProvider,
      'repository://github.com/awesome-os/holo-pm@main',
    );
    assert.match(matrix.bootstrapProvider, REPO_URI_RE);
  });

  it('declares all required nativeCore components', () => {
    const expectedNativeCore = [
      'libholo_codegen',
      'stealify-ssa',
      'sub-tu-splicer',
      'holo-project',
      'git-remote-repository',
      'holo-jq',
    ];
    const actualIds = matrix.nativeCore.map((entry) => entry.id);
    assert.deepEqual(actualIds, expectedNativeCore);
  });

  it('declares all required projectedToolchains with expected upstreams', () => {
    const expectedProjected: Record<string, string> = {
      'llvm-zig': 'repository://github.com/awesome-os/ghost-cpp@main',
      'cargo-rust': 'repository://github.com/awesome-os/cargo@main',
      'go-lang': 'repository://github.com/awesome-os/go-lang@main',
      dart: 'repository://github.com/awesome-os/dart@main',
      'node-v8': 'repository://github.com/awesome-os/node@main',
      'uv-py': 'repository://github.com/awesome-os/uv@main',
      coreutils: 'repository://github.com/awesome-os/coreutils@main',
      'wasi-host': 'repository://github.com/awesome-os/wasi-host@main',
    };

    const actualIds = matrix.projectedToolchains.map((entry) => entry.id);
    assert.deepEqual(actualIds, Object.keys(expectedProjected));

    for (const entry of matrix.projectedToolchains) {
      assert.equal(entry.repositoryUri, expectedProjected[entry.id]);
    }

    const goEntry = matrix.projectedToolchains.find((e) => e.id === 'go-lang');
    assert.ok(goEntry, 'go-lang entry must exist');
    assert.equal(goEntry.cacheProg, 'b8g-gocacheprog');
  });

  it('validates all repository://, project:// URIs and v11 CAS hardlink mode', () => {
    const allEntries = [...matrix.nativeCore, ...matrix.projectedToolchains];
    assert.equal(allEntries.length, 14);

    for (const entry of allEntries) {
      assert.match(
        entry.repositoryUri,
        REPO_URI_RE,
        `Invalid repositoryUri for ${entry.id}: ${entry.repositoryUri}`,
      );
      assert.match(
        entry.projectUri,
        PROJECT_URI_RE,
        `Invalid projectUri for ${entry.id}: ${entry.projectUri}`,
      );
      assert.equal(
        entry.casHardlinkMode,
        'v11',
        `Expected v11 casHardlinkMode for ${entry.id}`,
      );
      assert.ok(!entry.repositoryUri.includes('..'), 'No path traversal allowed');
      assert.ok(!entry.projectUri.includes('..'), 'No path traversal allowed');
      assert.ok(
        !entry.repositoryUri.includes('127.0.0.1') &&
          !entry.repositoryUri.includes('localhost'),
        'No loopback URLs allowed',
      );
    }
  });

  it('contains zero holo-sdk or legacy cas-v1 references', () => {
    assert.ok(
      !/holo-sdk/i.test(rawMatrix),
      'selfhost-matrix.json must not reference holo-sdk',
    );
    assert.ok(
      !/cas-v1/i.test(rawMatrix),
      'selfhost-matrix.json must not reference legacy cas-v1',
    );
  });
});
