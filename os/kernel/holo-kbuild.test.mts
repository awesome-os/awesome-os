import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildKernelPlan,
  buildQemuDebugCommand,
  diffKernelAbi,
} from './holo-kbuild.mts';

describe('Awesome-OS Linux 7.3.6 holo-kbuild Kernel Dev Kit', () => {
  it('ships awesome-os-7.3.config with io_uring, SimpleDRM, Hyper-V keyboard, BTF, Zstd, and zero legacy ISA/floppy', () => {
    const cfg = readFileSync(join(import.meta.dirname, 'awesome-os-7.3.config'), 'utf8');
    assert.ok(cfg.includes('CONFIG_IO_URING=y'));
    assert.ok(cfg.includes('CONFIG_SCHED_CLASS_EXT=y'));
    assert.ok(cfg.includes('CONFIG_DRM_SIMPLEDRM=y'));
    assert.ok(cfg.includes('CONFIG_HYPERV_KEYBOARD=y'));
    assert.ok(cfg.includes('CONFIG_DEBUG_INFO_BTF=y'));
    assert.ok(cfg.includes('CONFIG_KERNEL_ZSTD=y'));
    assert.ok(cfg.includes('# CONFIG_BLK_DEV_FD is not set'));
    assert.ok(cfg.includes('# CONFIG_ISA is not set'));
  });

  it('produces deterministic SHA-512 vermagic & v11 CAS kernel build plans', () => {
    const p1 = buildKernelPlan({ arch: 'x86_64', profile: 'desktop' });
    const p2 = buildKernelPlan({ arch: 'x86_64', profile: 'desktop' });
    assert.equal(p1.kconfigSha512, p2.kconfigSha512);
    assert.equal(p1.kconfigSha512.length, 128);
    assert.ok(p1.vermagicTag.startsWith('7.3.6-awesome-v11-desktop-'));
    assert.equal(p1.reproducibleEnv.LLVM, '1');
  });

  it('detects Module.symvers ABI breaks before they break out-of-tree .ko drivers', () => {
    const oldSym = [
      '0x11223344\tdrm_dev_register\tvmlinux\tEXPORT_SYMBOL',
      '0x55667788\tio_uring_register\tvmlinux\tEXPORT_SYMBOL_GPL',
    ].join('\n');
    const sameSym = oldSym + '\n0x99aabbcc\tnew_helper\tvmlinux\tEXPORT_SYMBOL';
    const brokenSym = [
      '0xdeadbeef\tdrm_dev_register\tvmlinux\tEXPORT_SYMBOL',
    ].join('\n');

    const ok = diffKernelAbi(oldSym, sameSym);
    assert.equal(ok.compatible, true);
    assert.equal(ok.addedSymbols.length, 1);

    const bad = diffKernelAbi(oldSym, brokenSym);
    assert.equal(bad.compatible, false);
    assert.equal(bad.changedSymbols[0].symbol, 'drm_dev_register');
    assert.deepEqual(bad.removedSymbols, ['io_uring_register']);
  });

  it('generates dual-console QEMU + GDB stub command for fast kernel edit-debug loops', () => {
    const cmd = buildQemuDebugCommand({ kernelImage: 'bzImage', initramfs: 'init.zst' });
    assert.equal(cmd[0], 'qemu-system-x86_64');
    assert.ok(cmd.includes('-s'));
    assert.ok(cmd.join(' ').includes('console=ttyS0,115200 console=tty0'));
  });

  it('ships Holo-Linux b8g_abi.ko (/dev/b8g-arena) and scx_holo sched_ext BPF personality', () => {
    const uapi = readFileSync(join(import.meta.dirname, 'include/uapi/linux/b8g_abi.h'), 'utf8');
    const mod = readFileSync(join(import.meta.dirname, 'b8g_abi/b8g_abi.c'), 'utf8');
    const scx = readFileSync(join(import.meta.dirname, 'scx_holo/scx_holo.bpf.c'), 'utf8');

    assert.ok(uapi.includes('0x33564742U'));
    assert.ok(uapi.includes('_Static_assert(sizeof(struct b8g_arena_hdr) == 64'));
    assert.ok(uapi.includes('_Static_assert(sizeof(struct b8g_ring_entry) == 64'));
    assert.ok(mod.includes('"b8g-arena"'));
    assert.ok(mod.includes('MODULE_LICENSE("Dual BSD/GPL")'));
    assert.ok(scx.includes('SCX_OPS_DEFINE(holo_ops'));
    assert.ok(scx.includes('B8G_CLASS_SECTIUM_FRAME'));
  });
});
