#include "libholo_pm.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;

static void check(int cond, const char* label) {
    if (cond) {
        printf("[PASS] %s\n", label);
    } else {
        fprintf(stderr, "[FAIL] %s\n", label);
        g_failures++;
    }
}

static void probe_and_assert(const char* name, const char* path, const char* sym) {
    uint32_t magic = 0u;
    int32_t rc = b8g_holo_pm_probe_lib(path, sym, &magic);
    char label[512];
    snprintf(
        label,
        sizeof(label),
        "probe %s (%s -> 0x%08" PRIX32 ", rc=%" PRId32 ")",
        name,
        sym,
        magic,
        rc
    );
    check(rc == 0 && magic == B8G_HOLO_PM_ABI_MAGIC_V3, label);
}

int main(int argc, char** argv) {
    /* 1. Core ABI magic & version checks */
    check(
        b8g_holo_pm_abi_magic() == 0x33564742u,
        "b8g_holo_pm_abi_magic() == 0x33564742"
    );
    check(
        strcmp(b8g_holo_pm_version(), "0.1.0+b8g-cas-v11") == 0,
        "b8g_holo_pm_version() == 0.1.0+b8g-cas-v11"
    );

    /* 2. CAS v11 root resolution */
    char v11_root[4096];
    int32_t root_len = b8g_holo_pm_resolve_v11_root(v11_root, sizeof(v11_root));
    check(root_len > 0, "b8g_holo_pm_resolve_v11_root returns positive length");
    check(
        root_len >= 3 && strcmp(v11_root + root_len - 3, "v11") == 0,
        "resolved CAS v11 root ends with v11"
    );
    printf("       casV11Root = %s\n", v11_root);

    check(
        b8g_holo_pm_resolve_v11_root(NULL, 64) == -1,
        "b8g_holo_pm_resolve_v11_root rejects NULL buffer"
    );
    check(
        b8g_holo_pm_resolve_v11_root(v11_root, 2) == -1,
        "b8g_holo_pm_resolve_v11_root rejects undersized buffer"
    );

    /* 3. Negative probe checks */
    uint32_t bad_magic = 0xDEADBEEFu;
    check(
        b8g_holo_pm_probe_lib(NULL, "sym", &bad_magic) == -1 && bad_magic == 0u,
        "b8g_holo_pm_probe_lib rejects NULL lib_path"
    );
    check(
        b8g_holo_pm_probe_lib("__nonexistent_b8g_shard__.dll", "b8g_abi_magic", &bad_magic) == -2,
        "b8g_holo_pm_probe_lib returns -2 on missing library"
    );

    /* 4. Optional explicit probe pair from CLI: holo_pm_test <lib_path> <magic_sym> */
    if (argc >= 3) {
        probe_and_assert("cli-target", argv[1], argv[2]);
    }

#if defined(_WIN32)
    /* 5. Live multi-shard C-ABI unification proof inside ONE process */
    const char* skip_shards = getenv("HOLO_PM_SKIP_LOCAL_SHARDS");
    if (skip_shards == NULL || skip_shards[0] == '\0') {
        probe_and_assert(
            "libpnpm.dll",
            "e:\\awesome-os\\github-mirror\\awesome-os\\pnpm\\dist\\libpnpm.dll",
            "b8g_pnpm_abi_magic"
        );
        probe_and_assert(
            "libcargo.dll",
            "e:\\awesome-os\\github-mirror\\awesome-os\\cargo\\dist\\libcargo.dll",
            "b8g_cargo_abi_magic"
        );
        probe_and_assert(
            "libuvpy.dll",
            "e:\\awesome-os\\github-mirror\\awesome-os\\uv\\dist\\libuvpy.dll",
            "b8g_uvpy_abi_magic"
        );
    }
#endif

    if (g_failures > 0) {
        fprintf(stderr, "\nFAILED: %d check(s) failed.\n", g_failures);
        return 1;
    }
    printf("\nALL CHECKS PASSED.\n");
    return 0;
}
