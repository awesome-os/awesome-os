/**
 * @file intersections/holo-compiler/compile-exe.test.mts
 * @description End-to-end tests for Bun-style `compileToExecutable` (`ghost` & `standalone` modes).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  B8G_ABI_MAGIC_V3_HEX,
  B8G_EXE_FOOTER_BYTES,
  B8G_EXE_FOOTER_MAGIC,
  compileToExecutable,
  parseStandaloneFooter,
} from './compile-exe.mts';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-compile-exe-test-'));

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('holo-compiler compile-exe (ghost & standalone)', () => {
  const sampleScriptPath = path.join(TMP_ROOT, 'hello-app.mjs');
  const sampleScriptSource = [
    "import { basename } from 'node:path';",
    'const args = process.argv.slice(2);',
    'console.log(JSON.stringify({ greeting: "hello-from-holo-exe", args, file: basename(process.argv[1]) }));',
    '',
  ].join('\n');
  fs.writeFileSync(sampleScriptPath, sampleScriptSource, 'utf8');
  const samplePayloadBytes = Buffer.byteLength(sampleScriptSource, 'utf8');

  const casRoot = path.join(TMP_ROOT, 'cas-store');

  it('compiles a ghost executable (< 64 KB), verifies --holo-exe-info JSON, and executes CAS payload', () => {
    const outExe = path.join(TMP_ROOT, 'hello-ghost.exe');
    const result = compileToExecutable({
      entryPath: sampleScriptPath,
      outPath: outExe,
      appName: 'hello-ghost',
      mode: 'ghost',
      casStoreRoot: casRoot,
    });

    assert.equal(result.mode, 'ghost');
    assert.equal(result.outPath, outExe);
    assert.ok(fs.existsSync(outExe), 'ghost executable should exist on disk');
    assert.ok(fs.existsSync(result.casBlobPath), 'CAS v11 blob should exist on disk');
    assert.ok(
      result.casBlobPath.includes(`${path.sep}v11${path.sep}files${path.sep}`),
      `casBlobPath should reside under v11/files/XX/: ${result.casBlobPath}`,
    );
    assert.equal(result.payloadSha512.length, 128, 'SHA-512 hex digest should be 128 chars');
    assert.ok(
      result.binaryBytes > 0 && result.binaryBytes < 65536,
      `ghost binaryBytes (${result.binaryBytes}) must be < 65536 bytes`,
    );
    assert.ok(result.compileMs >= 0);

    // 1. Verify --holo-exe-info JSON output
    const infoRaw = execFileSync(outExe, ['--holo-exe-info'], { encoding: 'utf8' }).trim();
    const info = JSON.parse(infoRaw) as {
      mode: string;
      abiMagic: string;
      appName: string;
      sha512: string;
      casBlobPath: string;
    };

    assert.equal(info.mode, 'ghost');
    assert.equal(info.abiMagic, B8G_ABI_MAGIC_V3_HEX);
    assert.equal(info.appName, 'hello-ghost');
    assert.equal(info.sha512, result.payloadSha512);
    assert.equal(path.resolve(info.casBlobPath), path.resolve(result.casBlobPath));

    // 2. Execute normally and verify it runs the CAS-stored script with forwarded args
    const runRaw = execFileSync(outExe, ['--flag', '42'], { encoding: 'utf8' }).trim();
    const runOut = JSON.parse(runRaw) as { greeting: string; args: string[]; file: string };
    assert.equal(runOut.greeting, 'hello-from-holo-exe');
    assert.deepEqual(runOut.args, ['--flag', '42']);

    console.log(
      `[compile-exe.test] ghost: ${result.binaryBytes} bytes, compileMs=${result.compileMs} ms`,
    );
  });

  it('compiles a standalone executable with B8GEXE01 24-byte footer, verifies --holo-exe-info, and executes offline', () => {
    const outExe = path.join(TMP_ROOT, 'hello-standalone.exe');
    const result = compileToExecutable({
      entryPath: sampleScriptPath,
      outPath: outExe,
      appName: 'hello-standalone',
      mode: 'standalone',
      casStoreRoot: casRoot,
    });

    assert.equal(result.mode, 'standalone');
    assert.equal(result.outPath, outExe);
    assert.ok(fs.existsSync(outExe), 'standalone executable should exist on disk');
    assert.equal(result.payloadSha512.length, 128);

    // Verify raw 24-byte B8GEXE01 footer on disk
    const binary = fs.readFileSync(outExe);
    assert.equal(binary.byteLength, result.binaryBytes);
    const footer = parseStandaloneFooter(binary);
    assert.ok(footer !== null, 'B8GEXE01 footer must parse');
    assert.equal(footer.magic, B8G_EXE_FOOTER_MAGIC);
    assert.equal(footer.payloadLen, samplePayloadBytes);
    assert.equal(footer.sha256PrefixHex.length, 16);
    assert.ok(binary.byteLength > samplePayloadBytes + B8G_EXE_FOOTER_BYTES);

    // 1. Verify --holo-exe-info JSON output
    const infoRaw = execFileSync(outExe, ['--holo-exe-info'], { encoding: 'utf8' }).trim();
    const info = JSON.parse(infoRaw) as {
      mode: string;
      abiMagic: string;
      appName: string;
      sha512: string;
      embeddedBytes: number;
    };

    assert.equal(info.mode, 'standalone');
    assert.equal(info.abiMagic, B8G_ABI_MAGIC_V3_HEX);
    assert.equal(info.appName, 'hello-standalone');
    assert.equal(info.sha512, result.payloadSha512);
    assert.equal(info.embeddedBytes, samplePayloadBytes);

    // 2. Execute normally offline (even without referencing the CAS store)
    const runRaw = execFileSync(outExe, ['offline-arg'], { encoding: 'utf8' }).trim();
    const runOut = JSON.parse(runRaw) as { greeting: string; args: string[]; file: string };
    assert.equal(runOut.greeting, 'hello-from-holo-exe');
    assert.deepEqual(runOut.args, ['offline-arg']);

    console.log(
      `[compile-exe.test] standalone: ${result.binaryBytes} bytes (embedded=${samplePayloadBytes} B + 24 B footer), compileMs=${result.compileMs} ms`,
    );
  });

  it('defaults to ghost mode when mode is omitted and standalone runs even when CAS store is deleted', () => {
    const isolatedCas = path.join(TMP_ROOT, 'isolated-cas');
    const defaultGhostExe = path.join(TMP_ROOT, 'default-ghost.exe');
    const ghostRes = compileToExecutable({
      entryPath: sampleScriptPath,
      outPath: defaultGhostExe,
      appName: 'default-ghost',
      casStoreRoot: isolatedCas,
    });
    assert.equal(ghostRes.mode, 'ghost');
    assert.ok(ghostRes.binaryBytes < 65536);

    const offlineStandaloneExe = path.join(TMP_ROOT, 'offline-standalone.exe');
    const standaloneRes = compileToExecutable({
      entryPath: sampleScriptPath,
      outPath: offlineStandaloneExe,
      appName: 'offline-standalone',
      mode: 'standalone',
      casStoreRoot: isolatedCas,
    });
    assert.equal(standaloneRes.mode, 'standalone');

    // Delete the CAS store completely — standalone binary must still execute cleanly offline
    fs.rmSync(isolatedCas, { recursive: true, force: true });
    assert.equal(fs.existsSync(isolatedCas), false);

    const offlineRaw = execFileSync(offlineStandaloneExe, ['zero-cas'], {
      encoding: 'utf8',
    }).trim();
    const offlineOut = JSON.parse(offlineRaw) as { greeting: string; args: string[] };
    assert.equal(offlineOut.greeting, 'hello-from-holo-exe');
    assert.deepEqual(offlineOut.args, ['zero-cas']);
  });
});
