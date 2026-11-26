#ifndef B8G_LIBHOLO_PM_H
#define B8G_LIBHOLO_PM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) || defined(__CYGWIN__)
#  if defined(B8G_HOLO_PM_BUILDING_DLL)
#    define B8G_HOLO_PM_API __declspec(dllexport)
#  elif defined(B8G_HOLO_PM_USE_DLL)
#    define B8G_HOLO_PM_API __declspec(dllimport)
#  else
#    define B8G_HOLO_PM_API
#  endif
#else
#  define B8G_HOLO_PM_API __attribute__((visibility("default")))
#endif

/** Canonical B8G ABI v3 magic ("BGV3" = 0x33564742). */
#define B8G_HOLO_PM_ABI_MAGIC_V3 0x33564742u

/**
 * Returns the canonical B8G ABI v3 magic constant (0x33564742).
 */
B8G_HOLO_PM_API uint32_t b8g_holo_pm_abi_magic(void);

/**
 * Returns a static NUL-terminated UTF-8 version string ("0.1.0+b8g-cas-v11").
 */
B8G_HOLO_PM_API const char* b8g_holo_pm_version(void);

/**
 * Resolves the unified CAS v11 root directory.
 *
 * Precedence:
 *   1. B8G_CAS_V11_ROOT
 *   2. B8G_CAS_DIR/v11
 *   3. XDG_DATA_HOME/awesome-os/cas/v11
 *   4. OS default (%LOCALAPPDATA%\awesome-os\cas\v11 on Windows,
 *      $HOME/.local/share/awesome-os/cas/v11 on POSIX)
 *
 * Writes a NUL-terminated UTF-8 path into `out` (up to `cap` bytes).
 * Returns the byte length written (excluding the NUL terminator) on success,
 * or -1 if `out` is NULL, `cap` is too small, or resolution fails.
 */
B8G_HOLO_PM_API int32_t b8g_holo_pm_resolve_v11_root(char* out, size_t cap);

/**
 * Dynamically loads a CAS shared library (`lib_path`) via LoadLibraryA / dlopen,
 * resolves `magic_sym` (`uint32_t (*)(void)`), invokes it, stores the returned
 * magic into `*out_magic` (if non-NULL), and verifies `magic == B8G_HOLO_PM_ABI_MAGIC_V3`.
 *
 * Returns:
 *    0  on success (magic == 0x33564742)
 *   -1  invalid arguments
 *   -2  failed to load shared library
 *   -3  failed to resolve `magic_sym`
 *   -4  ABI magic mismatch
 */
B8G_HOLO_PM_API int32_t b8g_holo_pm_probe_lib(
    const char* lib_path,
    const char* magic_sym,
    uint32_t* out_magic
);

#ifdef __cplusplus
}
#endif

#endif /* B8G_LIBHOLO_PM_H */
