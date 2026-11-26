import test from 'node:test';
import assert from 'node:assert/strict';
import { buildV11ScopeCatalog, classifyV11ScopeTags, V11_SCOPE_TAGS } from './v11-scope-tags.mts';

test('classifies canonical v11 scope tags across appliances, devices, monitors, keyboards, containers, apps, and folders', () => {
  const omarchy = classifyV11ScopeTags('desktop-omarchy', ['v11-tree.json']);
  assert.ok(omarchy.includes('monitor'));
  assert.ok(omarchy.includes('keyboard'));
  assert.ok(omarchy.includes('browser-app'));
  assert.ok(omarchy.includes('folder-structure'));
  assert.ok(omarchy.includes('local'));

  const sectium = classifyV11ScopeTags('sectium', ['v11-tree.json']);
  assert.ok(sectium.includes('device'));
  assert.ok(sectium.includes('monitor'));
  assert.ok(sectium.includes('keyboard'));

  const docker = classifyV11ScopeTags('dockerimages', []);
  assert.ok(docker.includes('oci-container'));
  assert.ok(docker.includes('remote'));

  const catalog = buildV11ScopeCatalog([
    { repo: 'desktop-omarchy', filename: 'v11-tree.json' },
    { repo: 'awesome-os-desktop', filename: 'v11-tree.json' },
    { repo: 'coreutils', filename: 'coreutils-linux-x64' },
  ]);
  assert.equal(catalog.taxonomy.length, V11_SCOPE_TAGS.length);
  assert.ok(catalog.byTag.appliance.includes('awesome-os-desktop'));
  assert.ok(catalog.byTag['terminal-app'].includes('coreutils'));
});
