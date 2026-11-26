import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { VirtualDomainManager } from './virtual-domain-manager.mts';

describe('virtual-domain-manager', () => {
  it('resolves domains, subdomains, and longest-prefix paths accurately', () => {
    const vdm = VirtualDomainManager.fromFile(join(import.meta.dirname, 'virtual-domains.json'));

    const install = vdm.resolveUrl('https://awesome-os.com/install/blobs/sectium_cp.wasm');
    assert.ok(install);
    assert.equal(install.matchedHost, 'awesome-os.com');
    assert.equal(install.matchedPrefix, '/install');
    assert.equal(install.relativePath, 'blobs/sectium_cp.wasm');
    assert.equal(install.activeSource, 'repository://github.com/awesome-os/installer@main/web');

    const ws = vdm.resolveUrl('https://ide.b8g.dev/ai-colibri/mcp.json');
    assert.ok(ws);
    assert.equal(ws.mount.kind, 'workspaces');
    assert.equal(ws.activeSource, 'workspaces://awesome-os/ai-colibri');
    assert.equal(ws.relativePath, 'mcp.json');

    const ai = vdm.resolveUrl('https://ai.b8g.app/v1/chat/completions');
    assert.ok(ai);
    assert.equal(ai.mount.kind, 'pipe');
    assert.equal(ai.activeSource, 'pipe://b8g-colibri');
  });

  it('supports A/B slot staging, atomic promote, O(1) rollback, nginx emission, and SW routes', () => {
    const vdm = new VirtualDomainManager();
    vdm.mount({ host: 'preview.awesome-os.com', pathPrefix: '/app/', sourceUri: 'cas://v11/sha512-aaa' });
    assert.equal(vdm.resolveUrl('https://preview.awesome-os.com/app/index.html')?.activeSource, 'cas://v11/sha512-aaa');

    // Stage Slot B without disrupting Slot A
    vdm.mount({ host: 'preview.awesome-os.com', pathPrefix: '/app', sourceUri: 'cas://v11/sha512-bbb' });
    assert.equal(vdm.resolveUrl('https://preview.awesome-os.com/app/index.html')?.activeSource, 'cas://v11/sha512-aaa');

    // Atomic promote to Slot B
    vdm.promote('preview.awesome-os.com', '/app');
    assert.equal(vdm.resolveUrl('https://preview.awesome-os.com/app/index.html')?.activeSource, 'cas://v11/sha512-bbb');

    // O(1) rollback back to Slot A
    vdm.rollback('preview.awesome-os.com', '/app');
    assert.equal(vdm.resolveUrl('https://preview.awesome-os.com/app/index.html')?.activeSource, 'cas://v11/sha512-aaa');

    const nginx = vdm.emitNginxConfig();
    assert.ok(nginx.includes('server_name preview.awesome-os.com;'));
    assert.ok(nginx.includes('location /app/'));
    assert.ok(nginx.includes('immutable'));

    const sw = vdm.emitServiceWorkerRoutes();
    assert.equal(sw.schema, 'awesome-os.opfs-sw-routes.v1');
    assert.equal(sw.routes.length, 1);

    assert.equal(vdm.unmount('preview.awesome-os.com', '/app'), true);
    assert.equal(vdm.resolveUrl('https://preview.awesome-os.com/app/'), null);
  });
});
