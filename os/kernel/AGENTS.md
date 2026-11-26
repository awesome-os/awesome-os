# Linux Kernel Agent Instructions (`AGENTS.md`)

> **Target:** Linux `7.3.6+` (`torvalds/linux` & `awesome-os/t2linux-baseline`)
> **Style:** Zero fluff. No "AI slop" prose. Real reproducers, real bisects, real tests.
> **Toolchain:** `LLVM=1 LLVM_IAS=1` + `holo-kbuild` (`v11` CAS) + dual-console QEMU/GDB.

---

## 1. The Golden Rules (Do Not Violate)

1. **Never break userspace.** Syscall semantics, `/proc`, `/sys`, `io_uring`, and UAPI headers (`include/uapi/`) are sacred. If a patch changes observable userspace behavior, stop and reject it.
2. **No speculative abstractions.** Do not add wrappers, helper frameworks, or "future-proofing" hooks for a single caller. Write direct, readable C (or Rust where the subsystem already uses Rust).
3. **Explain *why*, not *what*, in commit messages.**
   - Subject: `<subsystem>: <imperative summary>` (≤ 72 chars, no trailing period).
   - Body: state the root cause, the failure mode, and why this fix is the minimal correct one.
   - Trailers: `Fixes: <12-char-sha> ("<subject>")`, `Cc: stable@vger.kernel.org` (when applicable), and `Signed-off-by:`.
4. **Never submit untested code.** Every patch must at minimum compile cleanly under `LLVM=1 W=1` and boot in the fast QEMU harness before proposing a commit.

---

## 2. Fast Inner Loop (`holo-kbuild` + QEMU + GDB)

Do not wait 15 minutes for a full distro `allmodconfig` rebuild on every edit. Use the lean deterministic Awesome-OS fragment ([`awesome-os-7.3.config`](awesome-os-7.3.config)) and [`holo-kbuild.mts`](holo-kbuild.mts):

```powershell
# 1. Print deterministic SHA-512 vermagic + v11 CAS build plan
node kernel/holo-kbuild.mts plan

# 2. Verify Module.symvers ABI stability before shipping out-of-tree .ko changes
node kernel/holo-kbuild.mts abi-check <baseline/Module.symvers> <new/Module.symvers>

# 3. Print & launch instant dual-console QEMU + GDB stub (-s -S on tcp::1234)
node kernel/holo-kbuild.mts qemu-cmd <path/to/bzImage> <path/to/initramfs.cpio.zst>
```

### Reproducible Build Invariants

Always pin these environment variables so `v11` CAS object hits stay 100% deterministic across machines:

- `LLVM=1` and `LLVM_IAS=1` (Clang + LLD + integrated assembler)
- `KBUILD_BUILD_TIMESTAMP="1970-01-01 00:00:00 UTC"`
- `KBUILD_BUILD_USER="holo-compiler"`
- `KBUILD_BUILD_HOST="awesome-os"`

---

## 3. Mandatory Pre-Commit Verification Checklist

Before presenting any kernel patch or commit:

| Check | Command / Gate | Pass Criteria |
| :--- | :--- | :--- |
| **Kconfig integrity** | `node --test kernel/holo-kbuild.test.mts` | `CONFIG_IO_URING=y`, `CONFIG_DRM_SIMPLEDRM=y`, `CONFIG_HYPERV_KEYBOARD=y`, `CONFIG_DEBUG_INFO_BTF=y`, `CONFIG_KERNEL_ZSTD=y`, zero legacy ISA/floppy/OSS/AGP. |
| **Strict compile** | `make LLVM=1 LLVM_IAS=1 W=1 <changed-obj>.o` | `0` new warnings, `0` sparse/smatch regressions. |
| **ABI stability** | `node kernel/holo-kbuild.mts abi-check ...` | `0` removed or mutated exported CRC symbols unless explicitly intended. |
| **Patch hygiene** | `scripts/checkpatch.pl --strict --git HEAD~1..HEAD` | `0` errors; fix all real warnings (ignore only obvious false positives). |
| **Boot & KUnit** | `./tools/testing/kunit/kunit.py run` + QEMU boot | Clean boot to prompt with `0` `WARNING:` / `BUG:` / `KASAN:` / `lockdep` splats. |

---

## 4. Debugging & Bisection Protocol

- **Kernel panic / oops / regression:** Always run `git bisect` automated with the QEMU boot harness rather than guessing by reading code.
- **Locking bugs:** Enable `CONFIG_PROVE_LOCKING=y` (lockdep) and `CONFIG_DEBUG_ATOMIC_SLEEP=y` in debug runs.
- **Memory corruption / UAF:** Enable `CONFIG_KASAN=y` + `CONFIG_KFENCE=y` and attach `gdb vmlinux -ex "target remote :1234"` against the QEMU stub.
- **Zero-copy & IO regressions:** Verify with `io_uring` micro-tests and confirm no regression in `BTF` / `eBPF` verifier metadata (`CONFIG_DEBUG_INFO_BTF=y`).

---

## 5. Out-of-Tree & Driver Hygiene

- Prefer upstreaming into mainline or keeping minimal, cleanly isolated patches.
- Never silently change `EXPORT_SYMBOL` / `EXPORT_SYMBOL_GPL` signatures without running `holo-kbuild.mts abi-check`.
- Keep hardware drivers modular (`=m`) so the core `bzImage` stays small, fast to boot, and cacheable in `v11` CAS; hydrate hardware `.ko` modules on demand by `modalias`.
