import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderSplashBmp24, renderSplashSvg, SPLASH_SPECS } from './assets/generate-splash.mts';

describe('awesome-os/bootloader (Limine, systemd-boot, iPXE, UEFI GOP Splash)', () => {
  it('generates valid uncompressed 24-bit BI_RGB bottom-up BMPs for Limine & UEFI GOP', () => {
    for (const spec of SPLASH_SPECS) {
      const bmp = renderSplashBmp24(spec.width, spec.height);
      const view = new DataView(bmp.buffer);
      assert.equal(bmp[0], 0x42, 'BM magic B');
      assert.equal(bmp[1], 0x4d, 'BM magic M');
      assert.equal(view.getUint32(2, true), bmp.byteLength);
      assert.equal(view.getInt32(18, true), spec.width);
      assert.equal(view.getInt32(22, true), spec.height);
      assert.equal(view.getUint16(28, true), 24, '24-bit BGR');
      assert.equal(view.getUint32(30, true), 0, 'BI_RGB uncompressed');
    }
    const svg = renderSplashSvg();
    assert.ok(svg.includes('HOLO-LINUX 7.3.6'));
  });

  it('ships Limine v11/v12 dual-slot config with BMP wallpaper and Holo-Linux 7.3.6 cmdline', () => {
    const cfg = fs.readFileSync(path.join(import.meta.dirname, 'limine/limine.conf'), 'utf8');
    assert.ok(cfg.includes('wallpaper: boot():/boot/splash/awesome-os-1920x1080.bmp'));
    assert.ok(cfg.includes('b8g.abi=v3 scx_holo=1'));
    assert.ok(cfg.includes('/boot/slot-a/vmlinuz'));
    assert.ok(cfg.includes('/boot/slot-b/vmlinuz'));
    assert.ok(cfg.includes('vt.global_cursor_default=0'));
  });

  it('ships systemd-boot dual-slot entries and iPXE stateless netboot', () => {
    const loader = fs.readFileSync(path.join(import.meta.dirname, 'systemd-boot/loader.conf'), 'utf8');
    const slotA = fs.readFileSync(path.join(import.meta.dirname, 'systemd-boot/entries/awesome-os-slot-a.conf'), 'utf8');
    const ipxe = fs.readFileSync(path.join(import.meta.dirname, 'ipxe/boot.ipxe'), 'utf8');
    assert.ok(loader.includes('default awesome-os-slot-a.conf'));
    assert.ok(slotA.includes('b8g.abi=v3 scx_holo=1'));
    assert.ok(ipxe.includes('vmlinuz-7.3.6-x86_64'));
  });
});
