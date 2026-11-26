#include "holo_unified_abi.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

_Static_assert(HOLO_ABI_MAGIC_V3 == 0x33564742u, "HOLO_ABI_MAGIC_V3 must equal BGV3 (0x33564742)");
_Static_assert(sizeof(HoloCompileUnitV3) == 128u, "HoloCompileUnitV3 must be exactly 128 bytes (2 cache lines)");
_Static_assert(_Alignof(HoloCompileUnitV3) == 64u, "HoloCompileUnitV3 must be 64-byte aligned");
_Static_assert(offsetof(HoloCompileUnitV3, effect_mask) == 16u, "effect_mask offset mismatch");
_Static_assert(offsetof(HoloCompileUnitV3, allowed_effect_mask) == 24u, "allowed_effect_mask offset mismatch");
_Static_assert(offsetof(HoloCompileUnitV3, item_hash) == 32u, "item_hash offset mismatch");
_Static_assert(offsetof(HoloCompileUnitV3, sig_hash) == 64u, "sig_hash offset mismatch");

static int is_valid_toolchain(uint32_t kind) {
    return kind >= HOLO_TOOLCHAIN_CXX && kind <= HOLO_TOOLCHAIN_TS;
}

static int hash32_equal(const uint8_t a[HOLO_HASH_BYTES], const uint8_t b[HOLO_HASH_BYTES]) {
    uint8_t diff = 0u;
    for (size_t i = 0u; i < HOLO_HASH_BYTES; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0u;
}

HOLO_ABI_EXPORT int32_t holo_unit_init(
    HoloCompileUnitV3 *u,
    uint32_t toolchain_kind,
    uint64_t effect_mask,
    uint64_t allowed_effect_mask
) {
    if (u == NULL) {
        return HOLO_ABI_ERR_INVALID_ARG;
    }
    if (!is_valid_toolchain(toolchain_kind)) {
        return HOLO_ABI_ERR_INVALID_TOOLCHAIN;
    }
    memset(u, 0, sizeof(*u));
    u->abi_magic           = HOLO_ABI_MAGIC_V3;
    u->abi_version         = HOLO_ABI_VERSION_V3;
    u->toolchain_kind      = toolchain_kind;
    u->flags               = 0u;
    u->effect_mask         = effect_mask;
    u->allowed_effect_mask = allowed_effect_mask;
    return HOLO_ABI_OK;
}

HOLO_ABI_EXPORT int32_t holo_check_effect_admissibility(const HoloCompileUnitV3 *u) {
    if (u == NULL) {
        return 0;
    }
    return ((u->effect_mask & ~u->allowed_effect_mask) == 0ULL) ? 1 : 0;
}

HOLO_ABI_EXPORT int32_t holo_unit_validate(const HoloCompileUnitV3 *u) {
    if (u == NULL) {
        return HOLO_ABI_ERR_INVALID_ARG;
    }
    if (u->abi_magic != HOLO_ABI_MAGIC_V3) {
        return HOLO_ABI_ERR_INVALID_MAGIC;
    }
    if (u->abi_version != HOLO_ABI_VERSION_V3) {
        return HOLO_ABI_ERR_INVALID_VERSION;
    }
    if (!is_valid_toolchain(u->toolchain_kind)) {
        return HOLO_ABI_ERR_INVALID_TOOLCHAIN;
    }
    if ((u->arena_offset & (uint64_t)(HOLO_CACHELINE_ALIGN - 1u)) != 0ULL) {
        return HOLO_ABI_ERR_UNALIGNED;
    }
    if (!holo_check_effect_admissibility(u)) {
        return HOLO_ABI_ERR_EFFECT_DENIED;
    }
    return HOLO_ABI_OK;
}

HOLO_ABI_EXPORT HoloSpliceDecision holo_splice_decision(
    const uint8_t prev_item[HOLO_HASH_BYTES],
    const uint8_t prev_sig[HOLO_HASH_BYTES],
    const uint8_t next_item[HOLO_HASH_BYTES],
    const uint8_t next_sig[HOLO_HASH_BYTES]
) {
    if (prev_item == NULL || prev_sig == NULL || next_item == NULL || next_sig == NULL) {
        return HOLO_SPLICE_FULL_REBUILD;
    }
    if (!hash32_equal(prev_sig, next_sig)) {
        return HOLO_SPLICE_FULL_REBUILD;
    }
    if (hash32_equal(prev_item, next_item)) {
        return HOLO_SPLICE_UNCHANGED;
    }
    return HOLO_SPLICE_BODY_ONLY;
}

HOLO_ABI_EXPORT HoloSpliceDecision holo_splice_decision_units(
    const HoloCompileUnitV3 *prev,
    const HoloCompileUnitV3 *next
) {
    if (prev == NULL || next == NULL) {
        return HOLO_SPLICE_FULL_REBUILD;
    }
    if (prev->toolchain_kind != next->toolchain_kind) {
        return HOLO_SPLICE_FULL_REBUILD;
    }
    return holo_splice_decision(prev->item_hash, prev->sig_hash, next->item_hash, next->sig_hash);
}

HOLO_ABI_EXPORT const char *holo_toolchain_name(uint32_t toolchain_kind) {
    switch (toolchain_kind) {
        case HOLO_TOOLCHAIN_CXX:  return "cxx";
        case HOLO_TOOLCHAIN_RUST: return "rust";
        case HOLO_TOOLCHAIN_ZIG:  return "zig";
        case HOLO_TOOLCHAIN_WASI: return "wasi";
        case HOLO_TOOLCHAIN_TS:   return "ts";
        default:                  return "unknown";
    }
}
