import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evalHoloJqFilter, evalHoloJsExpr, formatHoloJqOutput } from './holo-jq.mts';

describe('holo-jq (Shared-V8 native jq replacement)', () => {
  const sample = {
    org: 'awesome-os',
    items: [
      { name: 'holo-compiler', active: true, score: 10 },
      { name: 'legacy-bloat', active: false, score: 1 },
      { name: 'holo-sdk', active: true, score: 9 },
    ],
  };

  it('evaluates jq pipelines (nested paths, array iteration, select, length, keys, type)', () => {
    assert.deepEqual(evalHoloJqFilter(sample, '.org'), ['awesome-os']);
    assert.deepEqual(evalHoloJqFilter(sample, '.items[] | select(.active == true) | .name'), [
      'holo-compiler',
      'holo-sdk',
    ]);
    assert.deepEqual(evalHoloJqFilter(sample, '.items[] | select(.score >= 10) | .name'), [
      'holo-compiler',
    ]);
    assert.deepEqual(evalHoloJqFilter(sample, '.items | length'), [3]);
    assert.deepEqual(evalHoloJqFilter(sample, 'keys'), [['items', 'org']]);
    assert.deepEqual(evalHoloJqFilter(sample, '.items[0].name'), ['holo-compiler']);
  });

  it('evaluates direct V8 JS expressions and formats raw/compact output', () => {
    const names = evalHoloJsExpr(sample, 'x.items.filter(i => i.active).map(i => i.name)');
    assert.deepEqual(names, ['holo-compiler', 'holo-sdk']);
    assert.equal(formatHoloJqOutput(['holo-compiler', 'holo-sdk'], { raw: true }), 'holo-compiler\nholo-sdk');
    assert.equal(formatHoloJqOutput([{ a: 1 }], { compact: true }), '{"a":1}');
  });
});
