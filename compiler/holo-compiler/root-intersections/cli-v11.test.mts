/**
 * @file intersections/holo-compiler/cli-v11.test.mts
 * @description End-to-end verification suite for `intersections/holo-compiler/cli.mts`
 * direct `v11/files/XX/<sha512>` CAS emission (`emit-v11` & `compile --cas-v11`).
 *
 * Strictly `erasableSyntaxOnly: true`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { V11EmitReport } from './cli.mts';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(THIS_DIR, 'cli.mts');

const tempDirs: string[] = [];

function makeTempCasDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `holo-v11-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function invokeCliJson(
  args: readonly string[],
  extraEnv?: Readonly<Record<string, string | undefined>>,
): V11EmitReport {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
  const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
    env,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as V11EmitReport;
}

function sha512Hex(data: Uint8Array): string {
  return createHash('sha512').update(data).digest('hex');
}

function assertValidV11DiskBlobs(report: V11EmitReport, expectedCasRoot: string): void {
  assert.equal(resolve(report.casRoot), resolve(expectedCasRoot));
  assert.equal(resolve(report.v11Root), resolve(expectedCasRoot, 'v11'));
  assert.equal(report.consumerDebugBytes, 0);
  assert.equal(report.admissible, report.persona !== 'consumer');
  assert.equal(report.effects.ok, true);
  assert.equal(report.effects.diagnosticCount, 0);
  assert.ok(report.casKeys.length > 0, 'casKeys must be non-empty');
  assert.ok(report.subTu.length > 0, 'subTu summary must be non-empty');

  const tmpDir = join(report.v11Root, 'tmp');
  assert.equal(existsSync(tmpDir), true, 'v11/tmp directory must exist');
  assert.deepEqual(readdirSync(tmpDir), [], 'v11/tmp must have zero leftover temporary files');

  for (const blob of report.v11Blobs) {
    assert.match(blob.sha512, /^[0-9a-f]{128}$/, `sha512 must be 128 hex chars for ${blob.unitId}`);
    const expectedPath = join(report.v11Root, 'files', blob.sha512.slice(0, 2), blob.sha512);
    assert.equal(resolve(blob.blobPath), resolve(expectedPath));
    assert.equal(existsSync(blob.blobPath), true, `blob must exist on disk: ${blob.blobPath}`);

    const diskBytes = readFileSync(blob.blobPath);
    assert.equal(diskBytes.byteLength, blob.bytes, `byte count mismatch for ${blob.unitId}`);
    assert.equal(
      sha512Hex(diskBytes),
      blob.sha512,
      `on-disk SHA-512 digest mismatch for ${blob.unitId} (${blob.kind})`,
    );
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('holo-compiler CLI direct v11 CAS emitter', () => {
  it('emit-v11 in consumer mode writes only stripped production blobs and deduplicates on second run', () => {
    const casRoot = makeTempCasDir('consumer');

    const first = invokeCliJson([
      'emit-v11',
      '--persona',
      'consumer',
      '--cas-root',
      casRoot,
    ]);

    assert.equal(first.mode, 'v11');
    assert.equal(first.persona, 'consumer');
    assert.equal(first.devopsTeed, false);
    assert.equal(first.consumerDebugBytes, 0);
    assert.equal(first.v11Blobs.length, 2);
    assert.ok(
      first.v11Blobs.every((b) => b.kind === 'production'),
      'consumer mode must emit zero debug-sidecar blobs',
    );
    assert.ok(
      first.v11Blobs.every((b) => b.deduplicated === false),
      'first emit into empty CAS must report deduplicated: false',
    );
    assertValidV11DiskBlobs(first, casRoot);

    const second = invokeCliJson([
      'emit-v11',
      '--persona',
      'consumer',
      '--cas-root',
      casRoot,
    ]);

    assert.equal(second.consumerDebugBytes, 0);
    assert.deepEqual(second.casKeys, first.casKeys);
    assert.equal(second.v11Blobs.length, first.v11Blobs.length);
    assert.ok(
      second.v11Blobs.every((b) => b.deduplicated === true),
      'second emit into same CAS must report deduplicated: true for all blobs',
    );
    for (let i = 0; i < first.v11Blobs.length; i += 1) {
      assert.equal(second.v11Blobs[i]!.sha512, first.v11Blobs[i]!.sha512);
      assert.equal(second.v11Blobs[i]!.blobPath, first.v11Blobs[i]!.blobPath);
    }
    assertValidV11DiskBlobs(second, casRoot);
  });

  it('emit-v11 in devops mode writes both production artifacts and .debug.b8p sidecars and deduplicates on repeat', () => {
    const casRoot = makeTempCasDir('devops');

    const first = invokeCliJson([
      'emit-v11',
      '--persona',
      'devops',
      '--cas-root',
      casRoot,
    ]);

    assert.equal(first.mode, 'v11');
    assert.equal(first.persona, 'devops');
    assert.equal(first.devopsTeed, true);
    assert.equal(first.consumerDebugBytes, 0);

    const prodBlobs = first.v11Blobs.filter((b) => b.kind === 'production');
    const sidecarBlobs = first.v11Blobs.filter((b) => b.kind === 'debug-sidecar');
    assert.equal(prodBlobs.length, 2);
    assert.equal(sidecarBlobs.length, 2);
    assert.ok(
      first.v11Blobs.every((b) => b.deduplicated === false),
      'first devops emit must report deduplicated: false',
    );
    assertValidV11DiskBlobs(first, casRoot);

    for (const sc of sidecarBlobs) {
      const parsed = JSON.parse(readFileSync(sc.blobPath, 'utf8')) as {
        format: string;
        unitId: string;
        buildId: string;
        sidecarFilename: string;
        symbols: Record<string, { symbol: string; file: string; line: number }>;
      };
      assert.equal(parsed.format, 'b8g.debug.sidecar.v1');
      assert.equal(parsed.unitId, sc.unitId);
      assert.ok(parsed.sidecarFilename.endsWith('.debug.b8p'));
      assert.ok(Object.keys(parsed.symbols).length > 0);
    }

    const second = invokeCliJson([
      'emit-v11',
      '--persona',
      'devops',
      '--cas-root',
      casRoot,
    ]);

    assert.equal(second.consumerDebugBytes, 0);
    assert.equal(second.v11Blobs.length, 4);
    assert.ok(
      second.v11Blobs.every((b) => b.deduplicated === true),
      'second devops emit must report deduplicated: true for all production + sidecar blobs',
    );
    assertValidV11DiskBlobs(second, casRoot);
  });

  it('compile --cas-v11 honors B8G_CAS_DIR and deduplicates production blobs across consumer -> devops', () => {
    const ghostCacheDir = makeTempCasDir('ghost-env');

    const consumerRun = invokeCliJson(
      ['compile', '--cas-v11', '--persona=consumer'],
      { B8G_CAS_DIR: ghostCacheDir },
    );
    assert.equal(consumerRun.v11Blobs.length, 2);
    assert.ok(consumerRun.v11Blobs.every((b) => b.kind === 'production' && !b.deduplicated));
    assertValidV11DiskBlobs(consumerRun, ghostCacheDir);

    const devopsRun = invokeCliJson(
      ['compile', '--cas-v11', '--persona=devops'],
      { B8G_CAS_DIR: ghostCacheDir },
    );
    assert.equal(devopsRun.v11Blobs.length, 4);
    assert.equal(devopsRun.consumerDebugBytes, 0);

    const prodBlobs = devopsRun.v11Blobs.filter((b) => b.kind === 'production');
    const sidecarBlobs = devopsRun.v11Blobs.filter((b) => b.kind === 'debug-sidecar');
    assert.ok(
      prodBlobs.every((b) => b.deduplicated === true),
      'production blobs already emitted by consumer run must deduplicate in devops run',
    );
    assert.ok(
      sidecarBlobs.every((b) => b.deduplicated === false),
      'newly emitted devops debug sidecars must report deduplicated: false',
    );
    assertValidV11DiskBlobs(devopsRun, ghostCacheDir);
  });

  it('normalizes --cas-root ending with /v11 without nesting v11/v11', () => {
    const casRoot = makeTempCasDir('v11-suffix');
    const v11Path = join(casRoot, 'v11');

    const report = invokeCliJson([
      'emit-v11',
      '--persona',
      'consumer',
      `--cas-root=${v11Path}`,
    ]);

    assert.equal(resolve(report.casRoot), resolve(casRoot));
    assert.equal(resolve(report.v11Root), resolve(v11Path));
    assertValidV11DiskBlobs(report, casRoot);
  });
});
