import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSystemUri, parseSystemUri } from './system-uri.mts';

test('parses local and remote system:// URIs across all canonical scopes', () => {
  const mon = parseSystemUri('system://local/monitor/desktop-omarchy?kvm=2&from=repository://github.com/awesome-os/desktop-omarchy@main');
  assert.equal(mon.locality, 'local');
  assert.equal(mon.scope, 'monitor');
  assert.equal(mon.id, 'desktop-omarchy');
  assert.equal(mon.params.kvm, '2');
  assert.equal(mon.abiMagic, '0x33564742');

  const rem = parseSystemUri('system://remote/oci-container/mail.dspeed.eu/gitlab-runner');
  assert.equal(rem.locality, 'remote');
  assert.equal(rem.scope, 'oci-container');
  assert.equal(rem.id, 'mail.dspeed.eu/gitlab-runner');

  assert.equal(
    formatSystemUri('local', 'keyboard', 'holo-kvm-switch', { channel: '2' }),
    'system://local/keyboard/holo-kvm-switch?channel=2',
  );
});

test('rejects invalid locality or unknown scope', () => {
  assert.throws(() => parseSystemUri('system://cloud/monitor/x'), /locality/);
  assert.throws(() => parseSystemUri('system://local/unknown-scope/x'), /scope/);
});
