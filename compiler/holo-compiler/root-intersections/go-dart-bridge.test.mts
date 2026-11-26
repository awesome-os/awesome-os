/**
 * @file intersections/holo-compiler/go-dart-bridge.test.mts
 * @description Unit tests for `go-dart-bridge.mts` covering:
 *   1. Go 5-target plan generation (`GOOS`/`GOARCH` mapping, `CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, `v11/files/00..ff/<sha512>`)
 *   2. Dart `aot-exe`, `wasm-gc`, and `jit-snapshot` plan generation
 *   3. Live `CasV11Store` ingestion + SHA-512 round-trip + deduplication + `holo-compiler-lockfile.json` compatibility
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CasV11Store, sha512Hex } from './cas-v11-store.mts';
import {
  B8G_ABI_MAGIC_V3,
  DART_TOOLCHAIN_REPO,
  GO_FIVE_TARGETS,
  GO_TOOLCHAIN_REPO,
  buildDartToolchainPlan,
  buildGoToolchainPlan,
  ingestToolchainArtifactToCasV11,
} from './go-dart-bridge.mts';
import { generateHoloLockfile, verifyHoloLockfile } from './lockfile.mts';

const V11_BLOB_PATH_RE = /^v11\/files\/[0-9a-f]{2}\/[0-9a-f]{128}(?:-exec)?$/;

test('buildGoToolchainPlan generates deterministic 5-target GOOS/GOARCH plan with CGO_ENABLED=0 and -trimpath', () => {
  const plan = buildGoToolchainPlan({
    pkg: './cmd/sectium-edge',
    outputName: 'sectium-edge',
    sourceDigest: 'abc123deterministic',
  });

  assert.equal(plan.repo, GO_TOOLCHAIN_REPO);
  assert.equal(plan.repo, 'awesome-os/go-lang');
  assert.equal(plan.toolchain, 'go');
  assert.equal(plan.abiMagic, B8G_ABI_MAGIC_V3);
  assert.equal(plan.abiMagic, 0x33564742);
  assert.equal(plan.cgoEnabled, false);
  assert.equal(plan.deterministic, true);
  assert.deepEqual(plan.targets, GO_FIVE_TARGETS);
  assert.equal(plan.steps.length, 5);

  const expectedMatrix = [
    { target: 'win64', goos: 'windows', goarch: 'amd64', ext: '.exe', executable: true },
    { target: 'linux-x64', goos: 'linux', goarch: 'amd64', ext: '', executable: true },
    { target: 'linux-arm64', goos: 'linux', goarch: 'arm64', ext: '', executable: true },
    { target: 'macos-arm64', goos: 'darwin', goarch: 'arm64', ext: '', executable: true },
    { target: 'wasm32-wasi', goos: 'wasip1', goarch: 'wasm', ext: '.wasm', executable: false },
  ] as const;

  for (const expected of expectedMatrix) {
    const step = plan.byTarget[expected.target];
    assert.ok(step, `missing step for target ${expected.target}`);
    assert.equal(step.env.CGO_ENABLED, '0');
    assert.equal(step.env.GOOS, expected.goos);
    assert.equal(step.env.GOARCH, expected.goarch);
    assert.equal(step.executable, expected.executable);
    assert.equal(step.outputFilename, `sectium-edge-${expected.target}${expected.ext}`);
    assert.ok(step.args.includes('-trimpath'), 'missing -trimpath flag');
    assert.ok(step.args.includes('-buildvcs=false'), 'missing -buildvcs=false flag');
    assert.equal(step.args[0], 'build');
    assert.equal(step.args[step.args.length - 1], './cmd/sectium-edge');
    assert.match(step.casOutputPath, V11_BLOB_PATH_RE);
    assert.equal(step.casOutputPath.endsWith('-exec'), expected.executable);
    assert.equal(step.abiMagic, B8G_ABI_MAGIC_V3);
  }

  // Determinism check: identical inputs produce identical SHA-512 CAS output paths
  const planRepeat = buildGoToolchainPlan({
    pkg: './cmd/sectium-edge',
    outputName: 'sectium-edge',
    sourceDigest: 'abc123deterministic',
  });
  assert.deepEqual(
    plan.steps.map((s) => s.casOutputPath),
    planRepeat.steps.map((s) => s.casOutputPath),
  );
});

test('buildDartToolchainPlan generates aot-exe, wasm-gc, and jit-snapshot plans with v11 CAS paths', () => {
  const plan = buildDartToolchainPlan({
    entrypoint: 'bin/holo_cli.dart',
    outputName: 'holo-cli',
    defines: { B8G_MODE: 'prod', A_FLAG: '1' },
    wasmOptLevel: '-O3',
  });

  assert.equal(plan.repo, DART_TOOLCHAIN_REPO);
  assert.equal(plan.toolchain, 'dart');
  assert.equal(plan.abiMagic, B8G_ABI_MAGIC_V3);
  assert.deepEqual(plan.targets, ['aot-exe', 'wasm-gc', 'jit-snapshot']);
  assert.equal(plan.steps.length, 3);

  const aot = plan.byTarget['aot-exe'];
  assert.ok(aot);
  assert.equal(aot.subcommand, 'exe');
  assert.equal(aot.executable, true);
  assert.equal(aot.artifactKind, 'bin');
  assert.deepEqual(aot.args.slice(0, 4), ['compile', 'exe', '-DA_FLAG=1', '-DB8G_MODE=prod']);
  assert.match(aot.casOutputPath, V11_BLOB_PATH_RE);
  assert.ok(aot.casOutputPath.endsWith('-exec'));

  const wasm = plan.byTarget['wasm-gc'];
  assert.ok(wasm);
  assert.equal(wasm.subcommand, 'wasm');
  assert.equal(wasm.executable, false);
  assert.equal(wasm.artifactKind, 'wasm');
  assert.ok(wasm.args.includes('-O3'));
  assert.ok(wasm.outputFilename.endsWith('.wasm'));
  assert.match(wasm.casOutputPath, V11_BLOB_PATH_RE);
  assert.ok(!wasm.casOutputPath.endsWith('-exec'));

  const jit = plan.byTarget['jit-snapshot'];
  assert.ok(jit);
  assert.equal(jit.subcommand, 'jit-snapshot');
  assert.equal(jit.executable, false);
  assert.equal(jit.artifactKind, 'object');
  assert.ok(jit.outputFilename.endsWith('.jit'));
  assert.match(jit.casOutputPath, V11_BLOB_PATH_RE);
});

test('ingestToolchainArtifactToCasV11 stores, verifies SHA-512 round-trip, deduplicates, and integrates with holo-compiler-lockfile.json', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-go-dart-cas-'));
  const store = new CasV11Store(path.join(tmpRoot, 'v11'));

  try {
    const goPayload = Buffer.from('ELF\x7f-go-linux-x64-deterministic-payload-v3');
    const dartWasmPayload = Buffer.from('\x00asm\x01\x00\x00\x00-dart-wasm-gc-payload');

    const firstNode = ingestToolchainArtifactToCasV11(store, goPayload, {
      id: 'sectium-go-edge',
      repo: GO_TOOLCHAIN_REPO,
      kind: 'bin',
      target: 'linux-x64',
      version: '1.24.0',
      executable: true,
    });

    assert.equal(firstNode.id, 'sectium-go-edge');
    assert.equal(firstNode.repo, GO_TOOLCHAIN_REPO);
    assert.equal(firstNode.kind, 'bin');
    assert.equal(firstNode.target, 'linux-x64');
    assert.equal(firstNode.sha512, sha512Hex(goPayload));
    assert.equal(firstNode.size, goPayload.byteLength);
    assert.equal(firstNode.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(firstNode.deduplicated, false);
    assert.match(firstNode.blobPath, V11_BLOB_PATH_RE);
    assert.equal(firstNode.blobPath, `v11/files/${firstNode.sha512.slice(0, 2)}/${firstNode.sha512}-exec`);

    // SHA-512 round-trip directly from CasV11Store
    const roundTripped = store.getBlob(firstNode.sha512, true);
    assert.ok(roundTripped !== null);
    assert.equal(sha512Hex(roundTripped), firstNode.sha512);
    assert.deepEqual(Buffer.from(roundTripped), goPayload);

    // Re-ingesting identical bytes must deduplicate
    const dupNode = ingestToolchainArtifactToCasV11(store, goPayload, {
      id: 'sectium-go-edge',
      repo: GO_TOOLCHAIN_REPO,
      kind: 'bin',
      target: 'linux-x64',
      version: '1.24.0',
      executable: true,
    });
    assert.equal(dupNode.deduplicated, true);
    assert.equal(dupNode.sha512, firstNode.sha512);
    assert.equal(dupNode.blobPath, firstNode.blobPath);

    // Ingest Dart WasmGC artifact
    const dartNode = ingestToolchainArtifactToCasV11(store, dartWasmPayload, {
      id: 'sectium-dart-ui',
      repo: DART_TOOLCHAIN_REPO,
      kind: 'wasm',
      target: 'wasm-gc',
      version: '3.7.0',
      executable: false,
    });
    assert.equal(dartNode.deduplicated, false);
    assert.equal(dartNode.sha512, sha512Hex(dartWasmPayload));
    assert.equal(dartNode.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(dartNode.blobPath, `v11/files/${dartNode.sha512.slice(0, 2)}/${dartNode.sha512}`);

    // Verify compatibility with holo-compiler-lockfile.json generator & verifier
    const lockfile = generateHoloLockfile({
      repo: 'awesome-os/holo-toolchain-bridge',
      targets: ['linux-x64', 'wasm-gc'],
      dependencies: [firstNode, dartNode],
    });
    const verification = verifyHoloLockfile(lockfile, store);
    assert.equal(verification.ok, true);
    assert.equal(verification.presentInCas, 2);
    assert.equal(verification.missingInCas, 0);
  } finally {
    store.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
