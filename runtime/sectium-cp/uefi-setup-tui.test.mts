import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PROXMOX_UEFI_CONFIG,
  applyUefiSetupKey,
  formatB8gUefiSetupElement,
  renderUefiSetupScreen,
} from './uefi-setup-tui.mts';

describe('sectium-cloud-control-plane UEFI / Proxmox Lo-Res Setup TUI', () => {
  it('1. renders a strict <=80-column UEFI/Proxmox setup screen for serial & 640x480 consoles', () => {
    const screen = renderUefiSetupScreen(DEFAULT_PROXMOX_UEFI_CONFIG, { width: 78 });
    const lines = screen.split('\n');
    assert.ok(lines.length <= 25, `expected <=25 rows for 80x25 UEFI console, got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.length <= 78, `line exceeded 78 cols: ${line.length}`);
    }
    assert.match(screen, /PROXMOX SETUP/);
    assert.match(screen, /lores-640x480/);
  });

  it('2. cycles lo-res display modes, VFIO passthrough, release channel, and boots detached', () => {
    let cfg = DEFAULT_PROXMOX_UEFI_CONFIG;
    let res = applyUefiSetupKey(cfg, '2');
    assert.equal(res.config.displayMode, 'kitty-ink');
    cfg = res.config;

    res = applyUefiSetupKey(cfg, '3');
    assert.equal(res.config.vfioGpuPassthrough, true);
    cfg = res.config;

    res = applyUefiSetupKey(cfg, '5');
    assert.equal(res.config.releaseChannel, 'canary');
    cfg = res.config;

    res = applyUefiSetupKey(cfg, 'B');
    assert.equal(res.bootRequested, true);
  });

  it('3. emits valid HTML5 data-* <b8g-sectium-uefi-setup> element', () => {
    const el = formatB8gUefiSetupElement(DEFAULT_PROXMOX_UEFI_CONFIG);
    assert.match(el, /^<b8g-sectium-uefi-setup /);
    assert.match(el, /data-display-mode="lores-640x480"/);
    assert.match(el, /data-warm-ram="true"/);
  });
});
