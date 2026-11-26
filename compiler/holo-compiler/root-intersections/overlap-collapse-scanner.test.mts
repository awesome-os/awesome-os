import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateCollapsePlan,
  parseCargoLock,
  parseGoMod,
  parsePackageJson,
  parsePubspecYaml,
  parseRequirementsTxt,
} from './overlap-collapse-scanner.mts';

describe('overlap-collapse-scanner (fine-grained nested dependency collapse)', () => {
  it('parses Rust, Go, npm, Python, and Dart manifests and detects cross-repo overlaps + version skew', () => {
    const occ = [
      ...parseCargoLock('[[package]]\nname = "tokio"\nversion = "1.40.0"\n', 'pnpm', 'Cargo.lock'),
      ...parseCargoLock('[[package]]\nname = "tokio"\nversion = "1.44.0"\n', 'uv', 'Cargo.lock'),
      ...parseGoMod('require (\n\tgoogle.golang.org/grpc v1.68.0\n)\n', 'gitaly', 'go.mod'),
      ...parseGoMod('require google.golang.org/grpc v1.70.0\n', 'gitlab-runner', 'go.mod'),
      ...parsePackageJson('{"dependencies":{"typescript":"6.0.3"}}', 'code-oss', 'package.json'),
      ...parsePackageJson('{"devDependencies":{"typescript":"5.9.0"}}', 'theia', 'package.json'),
      ...parseRequirementsTxt('numpy==2.1.0\n', 'holo-py', 'requirements.txt'),
      ...parsePubspecYaml('dependencies:\n  path: ^1.9.0\n', 'dart', 'pkg/foo/pubspec.yaml'),
    ];

    const plan = aggregateCollapsePlan(7, 8, occ, 50);
    assert.equal(plan.overlappingDependencies, 3);
    assert.equal(plan.versionSkewedDependencies, 3);
    assert.equal(plan.byEcosystem.rust.overlappingDeps, 1);
    assert.equal(plan.byEcosystem.go.overlappingDeps, 1);
    assert.equal(plan.byEcosystem.npm.overlappingDeps, 1);
  });
});
