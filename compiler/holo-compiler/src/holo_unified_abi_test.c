#include "holo_unified_abi.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t g_assertions = 0u;

#define EXPECT(cond)                                                          \
    do {                                                                      \
        g_assertions++;                                                       \
        if (!(cond)) {                                                        \
            fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, #cond); \
            exit(1);                                                          \
        }                                                                     \
    } while (0)

static void fill_hash(uint8_t out[HOLO_HASH_BYTES], uint8_t seed) {
    for (size_t i = 0u; i < HOLO_HASH_BYTES; i++) {
        out[i] = (uint8_t)(seed ^ (uint8_t)(i * 13u + 7u));
    }
}

int main(void) {
    /* 1. Verify ABI magic, size, and 64-byte alignment */
    HoloCompileUnitV3 u;
    EXPECT(HOLO_ABI_MAGIC_V3 == 0x33564742u);
    EXPECT(sizeof(HoloCompileUnitV3) == 128u);
    EXPECT(_Alignof(HoloCompileUnitV3) == 64u);
    EXPECT(((uintptr_t)&u & 63u) == 0u);

    /* 2. Verify all 5 unified toolchains initialize and report canonical names */
    const uint32_t toolchains[5] = {
        HOLO_TOOLCHAIN_CXX,
        HOLO_TOOLCHAIN_RUST,
        HOLO_TOOLCHAIN_ZIG,
        HOLO_TOOLCHAIN_WASI,
        HOLO_TOOLCHAIN_TS
    };
    const char *names[5] = { "cxx", "rust", "zig", "wasi", "ts" };
    for (size_t i = 0u; i < 5u; i++) {
        EXPECT(holo_unit_init(&u, toolchains[i], HOLO_EFFECT_PURE, HOLO_EFFECT_ALL_MASK) == HOLO_ABI_OK);
        EXPECT(u.abi_magic == HOLO_ABI_MAGIC_V3);
        EXPECT(u.abi_version == HOLO_ABI_VERSION_V3);
        EXPECT(u.toolchain_kind == toolchains[i]);
        EXPECT(strcmp(holo_toolchain_name(toolchains[i]), names[i]) == 0);
        EXPECT(holo_unit_validate(&u) == HOLO_ABI_OK);
    }
    EXPECT(strcmp(holo_toolchain_name(0u), "unknown") == 0);
    EXPECT(strcmp(holo_toolchain_name(99u), "unknown") == 0);
    EXPECT(holo_unit_init(NULL, HOLO_TOOLCHAIN_CXX, 0ULL, 0ULL) == HOLO_ABI_ERR_INVALID_ARG);
    EXPECT(holo_unit_init(&u, 0u, 0ULL, 0ULL) == HOLO_ABI_ERR_INVALID_TOOLCHAIN);
    EXPECT(holo_unit_init(&u, 6u, 0ULL, 0ULL) == HOLO_ABI_ERR_INVALID_TOOLCHAIN);

    /* 3. O(1) bitwise effect admissibility gate across all 9 effect categories */
    EXPECT(holo_check_effect_admissibility(NULL) == 0);

    /* PURE is always admissible even when allowed_effect_mask == PURE (0) */
    EXPECT(holo_unit_init(&u, HOLO_TOOLCHAIN_WASI, HOLO_EFFECT_PURE, HOLO_EFFECT_PURE) == HOLO_ABI_OK);
    EXPECT(holo_check_effect_admissibility(&u) == 1);
    EXPECT(holo_unit_validate(&u) == HOLO_ABI_OK);

    /* Exact subset of allowed effects passes */
    uint64_t wasm_allowed = HOLO_EFFECT_ALLOC | HOLO_EFFECT_ARENA_SAB | HOLO_EFFECT_ASYNC | HOLO_EFFECT_GPU_WGPU;
    uint64_t unit_req = HOLO_EFFECT_ALLOC | HOLO_EFFECT_ARENA_SAB;
    EXPECT(holo_unit_init(&u, HOLO_TOOLCHAIN_RUST, unit_req, wasm_allowed) == HOLO_ABI_OK);
    EXPECT(holo_check_effect_admissibility(&u) == 1);
    EXPECT(holo_unit_validate(&u) == HOLO_ABI_OK);

    /* Every single disallowed bit fails closed */
    const uint64_t single_effects[8] = {
        HOLO_EFFECT_ALLOC,
        HOLO_EFFECT_IO_FS,
        HOLO_EFFECT_IO_NET,
        HOLO_EFFECT_ARENA_SAB,
        HOLO_EFFECT_UNSAFE_FFI,
        HOLO_EFFECT_ASYNC,
        HOLO_EFFECT_GPU_WGPU,
        HOLO_EFFECT_PROCESS_SPAWN
    };
    for (size_t i = 0u; i < 8u; i++) {
        uint64_t allow_others = HOLO_EFFECT_ALL_MASK & ~single_effects[i];
        EXPECT(holo_unit_init(&u, HOLO_TOOLCHAIN_ZIG, single_effects[i], allow_others) == HOLO_ABI_OK);
        EXPECT(holo_check_effect_admissibility(&u) == 0);
        EXPECT(holo_unit_validate(&u) == HOLO_ABI_ERR_EFFECT_DENIED);

        /* Adding the bit back restores admissibility */
        u.allowed_effect_mask |= single_effects[i];
        EXPECT(holo_check_effect_admissibility(&u) == 1);
        EXPECT(holo_unit_validate(&u) == HOLO_ABI_OK);
    }

    /* Validation catches corrupted magic, version, and unaligned arena offset */
    EXPECT(holo_unit_init(&u, HOLO_TOOLCHAIN_TS, HOLO_EFFECT_ASYNC, HOLO_EFFECT_ASYNC) == HOLO_ABI_OK);
    u.arena_offset = 65u;
    EXPECT(holo_unit_validate(&u) == HOLO_ABI_ERR_UNALIGNED);
    u.arena_offset = 4096u;
    EXPECT(holo_unit_validate(&u) == HOLO_ABI_OK);
    u.abi_version = 2u;
    EXPECT(holo_unit_validate(&u) == HOLO_ABI_ERR_INVALID_VERSION);
    u.abi_version = HOLO_ABI_VERSION_V3;
    u.abi_magic = 0xDEADBEEFu;
    EXPECT(holo_unit_validate(&u) == HOLO_ABI_ERR_INVALID_MAGIC);

    /* 4. Sub-TU function-level splice decision */
    uint8_t item_a[HOLO_HASH_BYTES];
    uint8_t item_b[HOLO_HASH_BYTES];
    uint8_t sig_a[HOLO_HASH_BYTES];
    uint8_t sig_b[HOLO_HASH_BYTES];
    fill_hash(item_a, 0x11u);
    fill_hash(item_b, 0x22u);
    fill_hash(sig_a,  0xA1u);
    fill_hash(sig_b,  0xB2u);

    /* Identical sig + identical item -> UNCHANGED */
    EXPECT(holo_splice_decision(item_a, sig_a, item_a, sig_a) == HOLO_SPLICE_UNCHANGED);

    /* Identical sig + modified item -> BODY_ONLY */
    EXPECT(holo_splice_decision(item_a, sig_a, item_b, sig_a) == HOLO_SPLICE_BODY_ONLY);

    /* Modified sig (even if item matches or differs) -> FULL_REBUILD */
    EXPECT(holo_splice_decision(item_a, sig_a, item_a, sig_b) == HOLO_SPLICE_FULL_REBUILD);
    EXPECT(holo_splice_decision(item_a, sig_a, item_b, sig_b) == HOLO_SPLICE_FULL_REBUILD);

    /* Single-bit flip at the very last byte of item or sig is detected */
    uint8_t item_a_flip[HOLO_HASH_BYTES];
    uint8_t sig_a_flip[HOLO_HASH_BYTES];
    memcpy(item_a_flip, item_a, HOLO_HASH_BYTES);
    memcpy(sig_a_flip,  sig_a,  HOLO_HASH_BYTES);
    item_a_flip[31] ^= 0x01u;
    sig_a_flip[31]  ^= 0x80u;
    EXPECT(holo_splice_decision(item_a, sig_a, item_a_flip, sig_a) == HOLO_SPLICE_BODY_ONLY);
    EXPECT(holo_splice_decision(item_a, sig_a, item_a, sig_a_flip) == HOLO_SPLICE_FULL_REBUILD);

    /* Fail-closed on NULL hash pointers */
    EXPECT(holo_splice_decision(NULL, sig_a, item_a, sig_a) == HOLO_SPLICE_FULL_REBUILD);
    EXPECT(holo_splice_decision(item_a, NULL, item_a, sig_a) == HOLO_SPLICE_FULL_REBUILD);
    EXPECT(holo_splice_decision(item_a, sig_a, NULL, sig_a) == HOLO_SPLICE_FULL_REBUILD);
    EXPECT(holo_splice_decision(item_a, sig_a, item_a, NULL) == HOLO_SPLICE_FULL_REBUILD);

    /* 5. Unit-level splice comparison including toolchain change */
    HoloCompileUnitV3 prev_u, next_u;
    EXPECT(holo_unit_init(&prev_u, HOLO_TOOLCHAIN_CXX, HOLO_EFFECT_ALLOC, HOLO_EFFECT_ALL_MASK) == HOLO_ABI_OK);
    EXPECT(holo_unit_init(&next_u, HOLO_TOOLCHAIN_CXX, HOLO_EFFECT_ALLOC, HOLO_EFFECT_ALL_MASK) == HOLO_ABI_OK);
    memcpy(prev_u.item_hash, item_a, HOLO_HASH_BYTES);
    memcpy(prev_u.sig_hash,  sig_a,  HOLO_HASH_BYTES);
    memcpy(next_u.item_hash, item_a, HOLO_HASH_BYTES);
    memcpy(next_u.sig_hash,  sig_a,  HOLO_HASH_BYTES);
    EXPECT(holo_splice_decision_units(&prev_u, &next_u) == HOLO_SPLICE_UNCHANGED);

    memcpy(next_u.item_hash, item_b, HOLO_HASH_BYTES);
    EXPECT(holo_splice_decision_units(&prev_u, &next_u) == HOLO_SPLICE_BODY_ONLY);

    /* Changing toolchain forces FULL_REBUILD even when hashes match */
    memcpy(next_u.item_hash, item_a, HOLO_HASH_BYTES);
    next_u.toolchain_kind = HOLO_TOOLCHAIN_ZIG;
    EXPECT(holo_splice_decision_units(&prev_u, &next_u) == HOLO_SPLICE_FULL_REBUILD);
    EXPECT(holo_splice_decision_units(NULL, &next_u) == HOLO_SPLICE_FULL_REBUILD);
    EXPECT(holo_splice_decision_units(&prev_u, NULL) == HOLO_SPLICE_FULL_REBUILD);

    printf("holo_unified_abi_test: PASS (%u assertions)\n", g_assertions);
    return 0;
}
