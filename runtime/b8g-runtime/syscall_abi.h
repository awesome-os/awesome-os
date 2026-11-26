#ifndef B8G_SYSCALL_ABI_H
#define B8G_SYSCALL_ABI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef B8G_ABI_MAGIC_V3
#define B8G_ABI_MAGIC_V3 0x33564742u
#endif

/**
 * Returns the canonical B8G ABI v3 magic identifier (0x33564742u / "BGV3").
 */
uint32_t b8g_syscall_abi_magic(void);

/**
 * Returns the active OS/architecture syscall backend identifier:
 * - "linux-raw-syscall" on Linux (x86_64 / aarch64)
 * - "win64-kernel32"    on Windows (direct kernel32.dll boundary)
 * - "macos-libsystem"   on macOS (stable libSystem boundary)
 * - "wasi-preview1"     on WASI preview1
 */
const char* b8g_syscall_backend_name(void);

/**
 * Writes up to `len` bytes from `buf` to file descriptor `fd` (1 = stdout, 2 = stderr).
 * Returns the number of bytes written (>= 0) on success, or a negative error code on failure.
 */
int64_t b8g_sys_write(int fd, const void* buf, size_t len);

/**
 * Returns the current process identifier (non-zero).
 */
uint64_t b8g_sys_getpid(void);

/**
 * Returns a monotonic timestamp in nanoseconds.
 */
uint64_t b8g_sys_monotonic_ns(void);

#ifdef __cplusplus
}
#endif

#endif /* B8G_SYSCALL_ABI_H */
