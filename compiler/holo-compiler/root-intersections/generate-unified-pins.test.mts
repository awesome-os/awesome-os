import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateGoWorkAndPins,
  generateNpmOverridesJson,
  generateRustPinsToml,
  pickHighestCleanSemver,
} from './generate-unified-pins.mts';
import { aggregateCollapsePlan } from './overlap-collapse-scanner.mts';

describe('generate-unified-pins (Wave-1 Rust/Go/npm collapse manifests)', () => {
  it('picks highest clean semver and generates valid Rust, Go, and npm collapse manifests', () => {
    assert.equal(pickHighestCleanSemver(['1.0.9', '1.12.0', '1.2.3']), '1.12.0');
    assert.equal(pickHighestCleanSemver(['^5.8.0', '~6.0.3']), '6.0.3');

    const plan = aggregateCollapsePlan(4, 4, [
      { ecosystem: 'rust', name: 'syn', version: '2.0.80', repo: 'cargo', manifestRelPath: 'Cargo.lock', bytes: 0 },
      { ecosystem: 'rust', name: 'syn', version: '2.0.100', repo: 'pnpm', manifestRelPath: 'Cargo.lock', bytes: 0 },
      { ecosystem: 'go', name: 'google.golang.org/grpc', version: 'v1.68.0', repo: 'gitaly', manifestRelPath: 'go.mod', bytes: 0 },
      { ecosystem: 'go', name: 'google.golang.org/grpc', version: 'v1.72.0', repo: 'gitlab-runner', manifestRelPath: 'go.mod', bytes: 0 },
      { ecosystem: 'npm', name: 'typescript', version: '5.5.0', repo: 'pouchdb', manifestRelPath: 'package.json', bytes: 0 },
      { ecosystem: 'npm', name: 'typescript', version: '6.0.3', repo: 'code-oss', manifestRelPath: 'package.json', bytes: 0 },
      { ecosystem: 'npm', name: 'eslint', version: '8.57.0', repo: 'pouchdb', manifestRelPath: 'package.json', bytes: 0 },
      { ecosystem: 'npm', name: 'eslint', version: '9.10.0', repo: 'rollup', manifestRelPath: 'package.json', bytes: 0 },
    ]);

    const rustToml = generateRustPinsToml(plan);
    assert.ok(rustToml.includes('syn = "2.0.100"'));

    const { goWork, goPinsMod } = generateGoWorkAndPins(plan);
    assert.ok(goWork.includes('../../gitaly'));
    assert.ok(goPinsMod.includes('google.golang.org/grpc v1.72.0'));

    const npmJson = generateNpmOverridesJson(plan) as {
      pnpm: { overrides: Record<string, string> };
      debloatPurgeCandidates: Array<{ name: string }>;
    };
    assert.equal(npmJson.pnpm.overrides.typescript, '6.0.3');
    assert.ok(npmJson.debloatPurgeCandidates.some((c) => c.name === 'eslint'));
  });
});
