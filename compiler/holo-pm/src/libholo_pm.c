#include "libholo_pm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#else
#  include <dlfcn.h>
#endif

typedef uint32_t (*b8g_magic_fn_t)(void);

B8G_HOLO_PM_API uint32_t b8g_holo_pm_abi_magic(void) {
    return B8G_HOLO_PM_ABI_MAGIC_V3;
}

B8G_HOLO_PM_API const char* b8g_holo_pm_version(void) {
    return "0.1.0+b8g-cas-v11";
}

static int32_t write_path(char* out, size_t cap, const char* base, const char* suffix) {
    if (out == NULL || cap == 0 || base == NULL || base[0] == '\0') {
        return -1;
    }

    size_t base_len = strlen(base);
    while (base_len > 1 && (base[base_len - 1] == '/' || base[base_len - 1] == '\\')) {
        base_len--;
    }

    size_t suffix_len = (suffix != NULL) ? strlen(suffix) : 0;
    size_t total_len = base_len + suffix_len;
    if (total_len + 1 > cap) {
        return -1;
    }

    memcpy(out, base, base_len);
    if (suffix_len > 0) {
        memcpy(out + base_len, suffix, suffix_len);
    }
    out[total_len] = '\0';
    return (int32_t)total_len;
}

B8G_HOLO_PM_API int32_t b8g_holo_pm_resolve_v11_root(char* out, size_t cap) {
    if (out == NULL || cap == 0) {
        return -1;
    }

    const char* env_v11 = getenv("B8G_CAS_V11_ROOT");
    if (env_v11 != NULL && env_v11[0] != '\0') {
        return write_path(out, cap, env_v11, NULL);
    }

    const char* env_ghost = getenv("B8G_GHOST_CACHE_DIR");
    if (env_ghost != NULL && env_ghost[0] != '\0') {
#if defined(_WIN32)
        return write_path(out, cap, env_ghost, "\\v11");
#else
        return write_path(out, cap, env_ghost, "/v11");
#endif
    }

    const char* env_xdg = getenv("XDG_DATA_HOME");
    if (env_xdg != NULL && env_xdg[0] != '\0') {
#if defined(_WIN32)
        return write_path(out, cap, env_xdg, "\\awesome-os\\cas\\v11");
#else
        return write_path(out, cap, env_xdg, "/awesome-os/cas/v11");
#endif
    }

#if defined(_WIN32)
    const char* local_app_data = getenv("LOCALAPPDATA");
    if (local_app_data != NULL && local_app_data[0] != '\0') {
        return write_path(out, cap, local_app_data, "\\awesome-os\\cas\\v11");
    }
    const char* user_profile = getenv("USERPROFILE");
    if (user_profile != NULL && user_profile[0] != '\0') {
        return write_path(out, cap, user_profile, "\\.awesome-os\\cas\\v11");
    }
    return write_path(out, cap, ".\\.b8g-cas", "\\v11");
#else
    const char* home = getenv("HOME");
    if (home != NULL && home[0] != '\0') {
        return write_path(out, cap, home, "/.local/share/awesome-os/cas/v11");
    }
    return write_path(out, cap, "./.b8g-cas", "/v11");
#endif
}

B8G_HOLO_PM_API int32_t b8g_holo_pm_probe_lib(
    const char* lib_path,
    const char* magic_sym,
    uint32_t* out_magic
) {
    if (out_magic != NULL) {
        *out_magic = 0u;
    }
    if (lib_path == NULL || lib_path[0] == '\0' || magic_sym == NULL || magic_sym[0] == '\0') {
        return -1;
    }

    b8g_magic_fn_t magic_fn = NULL;

#if defined(_WIN32)
    HMODULE mod = LoadLibraryA(lib_path);
    if (mod == NULL) {
        return -2;
    }
    FARPROC sym = GetProcAddress(mod, magic_sym);
    if (sym == NULL) {
        FreeLibrary(mod);
        return -3;
    }
    memcpy(&magic_fn, &sym, sizeof(magic_fn));
    uint32_t magic = magic_fn();
    FreeLibrary(mod);
#else
    void* mod = dlopen(lib_path, RTLD_NOW | RTLD_LOCAL);
    if (mod == NULL) {
        return -2;
    }
    void* sym = dlsym(mod, magic_sym);
    if (sym == NULL) {
        dlclose(mod);
        return -3;
    }
    memcpy(&magic_fn, &sym, sizeof(magic_fn));
    uint32_t magic = magic_fn();
    dlclose(mod);
#endif

    if (out_magic != NULL) {
        *out_magic = magic;
    }

    return (magic == B8G_HOLO_PM_ABI_MAGIC_V3) ? 0 : -4;
}
