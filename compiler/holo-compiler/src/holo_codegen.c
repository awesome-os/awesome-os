#include "holo_codegen.h"

/* ============================================================================
 * Zero-dependency helpers (no libc required for .dll / .so / .wasm builds)
 * ============================================================================ */

static size_t cg_strlen(const char *s) {
    size_t n = 0u;
    if (!s) return 0u;
    while (s[n] != '\0') n++;
    return n;
}

static void cg_zero(void *dst, size_t n) {
    uint8_t *p = (uint8_t *)dst;
    for (size_t i = 0u; i < n; i++) p[i] = 0u;
}

static int cg_is_space(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static int cg_is_ident_start(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

static int cg_is_ident_char(char c) {
    return cg_is_ident_start(c) || (c >= '0' && c <= '9');
}

static int cg_is_digit(char c) {
    return c >= '0' && c <= '9';
}

static int cg_starts_with(const char *p, const char *lit) {
    while (*lit != '\0') {
        if (*p != *lit) return 0;
        p++;
        lit++;
    }
    return 1;
}

static int cg_fits_i32(uint64_t v) {
    int64_t s = (int64_t)v;
    return s >= (-2147483647LL - 1LL) && s <= 2147483647LL;
}

static void cg_write_u32_le(uint8_t *dst, uint32_t v) {
    dst[0] = (uint8_t)(v & 0xFFu);
    dst[1] = (uint8_t)((v >> 8) & 0xFFu);
    dst[2] = (uint8_t)((v >> 16) & 0xFFu);
    dst[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static void cg_write_u64_le(uint8_t *dst, uint64_t v) {
    dst[0] = (uint8_t)(v & 0xFFu);
    dst[1] = (uint8_t)((v >> 8) & 0xFFu);
    dst[2] = (uint8_t)((v >> 16) & 0xFFu);
    dst[3] = (uint8_t)((v >> 24) & 0xFFu);
    dst[4] = (uint8_t)((v >> 32) & 0xFFu);
    dst[5] = (uint8_t)((v >> 40) & 0xFFu);
    dst[6] = (uint8_t)((v >> 48) & 0xFFu);
    dst[7] = (uint8_t)((v >> 56) & 0xFFu);
}

static size_t cg_encode_uleb128(uint8_t *dst, uint64_t v) {
    size_t n = 0u;
    do {
        uint8_t byte = (uint8_t)(v & 0x7Fu);
        v >>= 7;
        if (v != 0u) byte |= 0x80u;
        dst[n++] = byte;
    } while (v != 0u);
    return n;
}

static size_t cg_encode_sleb128(uint8_t *dst, int64_t v) {
    size_t n = 0u;
    int more = 1;
    while (more) {
        uint8_t byte = (uint8_t)(v & 0x7F);
        v >>= 7;
        int sign_bit = (byte & 0x40u) != 0u;
        if ((v == 0 && !sign_bit) || (v == -1 && sign_bit)) {
            more = 0;
        } else {
            byte |= 0x80u;
        }
        dst[n++] = byte;
    }
    return n;
}

/* ============================================================================
 * x86-64 Native Machine-Code Emitter (Win64 & System V)
 * ============================================================================ */

static int32_t emit_x64(
    const HoloFnIr *ir,
    int is_win64,
    uint8_t *out_buf,
    size_t out_cap,
    size_t *out_len
) {
    /* Enforce 64-byte cacheline alignment for native code buffers */
    if (((uintptr_t)out_buf & (uintptr_t)(HOLO_CACHELINE_ALIGN - 1u)) != 0u) {
        return HOLO_CG_ERR_UNALIGNED_BUF;
    }

    uint8_t tmp[32];
    size_t n = 0u;

    /* Win64: arg0=rcx (1), arg1=rdx (2). SysV: arg0=rdi (7), arg1=rsi (6). */
    const uint8_t modrm_mov_rax_arg0 = is_win64 ? 0xC8u : 0xF8u;
    const uint8_t modrm_imul_rax_arg0 = is_win64 ? 0xC1u : 0xC7u;

    switch (ir->op) {
        case HOLO_OP_ADD_IMM:
            if (cg_fits_i32(ir->imm)) {
                /* mov rax, arg0; add rax, imm32; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0x89u; tmp[n++] = modrm_mov_rax_arg0;
                tmp[n++] = 0x48u; tmp[n++] = 0x05u;
                cg_write_u32_le(tmp + n, (uint32_t)(int32_t)ir->imm);
                n += 4u;
                tmp[n++] = 0xC3u;
            } else {
                /* mov rax, imm64; add rax, arg0; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0xB8u;
                cg_write_u64_le(tmp + n, ir->imm);
                n += 8u;
                tmp[n++] = 0x48u; tmp[n++] = 0x01u; tmp[n++] = modrm_mov_rax_arg0;
                tmp[n++] = 0xC3u;
            }
            break;

        case HOLO_OP_SUB_IMM:
            if (cg_fits_i32(ir->imm)) {
                /* mov rax, arg0; sub rax, imm32; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0x89u; tmp[n++] = modrm_mov_rax_arg0;
                tmp[n++] = 0x48u; tmp[n++] = 0x2Du;
                cg_write_u32_le(tmp + n, (uint32_t)(int32_t)ir->imm);
                n += 4u;
                tmp[n++] = 0xC3u;
            } else {
                /* mov rax, arg0; mov r10, imm64; sub rax, r10; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0x89u; tmp[n++] = modrm_mov_rax_arg0;
                tmp[n++] = 0x49u; tmp[n++] = 0xBAu;
                cg_write_u64_le(tmp + n, ir->imm);
                n += 8u;
                tmp[n++] = 0x4Cu; tmp[n++] = 0x29u; tmp[n++] = 0xD0u;
                tmp[n++] = 0xC3u;
            }
            break;

        case HOLO_OP_MUL_IMM:
            if (cg_fits_i32(ir->imm)) {
                /* imul rax, arg0, imm32; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0x69u; tmp[n++] = modrm_imul_rax_arg0;
                cg_write_u32_le(tmp + n, (uint32_t)(int32_t)ir->imm);
                n += 4u;
                tmp[n++] = 0xC3u;
            } else {
                /* mov rax, imm64; imul rax, arg0; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0xB8u;
                cg_write_u64_le(tmp + n, ir->imm);
                n += 8u;
                tmp[n++] = 0x48u; tmp[n++] = 0x0Fu; tmp[n++] = 0xAFu; tmp[n++] = modrm_imul_rax_arg0;
                tmp[n++] = 0xC3u;
            }
            break;

        case HOLO_OP_XOR_IMM:
            if (cg_fits_i32(ir->imm)) {
                /* mov rax, arg0; xor rax, imm32; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0x89u; tmp[n++] = modrm_mov_rax_arg0;
                tmp[n++] = 0x48u; tmp[n++] = 0x35u;
                cg_write_u32_le(tmp + n, (uint32_t)(int32_t)ir->imm);
                n += 4u;
                tmp[n++] = 0xC3u;
            } else {
                /* mov rax, imm64; xor rax, arg0; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0xB8u;
                cg_write_u64_le(tmp + n, ir->imm);
                n += 8u;
                tmp[n++] = 0x48u; tmp[n++] = 0x31u; tmp[n++] = modrm_mov_rax_arg0;
                tmp[n++] = 0xC3u;
            }
            break;

        case HOLO_OP_ADD_ARGS:
            /* Win64: lea rax, [rcx + rdx]; ret (48 8D 04 11 C3)
             * SysV:  lea rax, [rdi + rsi]; ret (48 8D 04 37 C3) */
            tmp[n++] = 0x48u;
            tmp[n++] = 0x8Du;
            tmp[n++] = 0x04u;
            tmp[n++] = is_win64 ? 0x11u : 0x37u;
            tmp[n++] = 0xC3u;
            break;

        case HOLO_OP_RET_CONST:
            if (ir->imm == 0ULL) {
                /* xor eax, eax; ret */
                tmp[n++] = 0x31u; tmp[n++] = 0xC0u; tmp[n++] = 0xC3u;
            } else if (ir->imm <= 0xFFFFFFFFULL) {
                /* mov eax, imm32; ret (zero-extends to rax) */
                tmp[n++] = 0xB8u;
                cg_write_u32_le(tmp + n, (uint32_t)ir->imm);
                n += 4u;
                tmp[n++] = 0xC3u;
            } else {
                /* mov rax, imm64; ret */
                tmp[n++] = 0x48u; tmp[n++] = 0xB8u;
                cg_write_u64_le(tmp + n, ir->imm);
                n += 8u;
                tmp[n++] = 0xC3u;
            }
            break;

        default:
            return HOLO_CG_ERR_UNSUPPORTED_OP;
    }

    if (n > out_cap) {
        return HOLO_CG_ERR_BUFFER_TOO_SMALL;
    }

    for (size_t i = 0u; i < n; i++) {
        out_buf[i] = tmp[i];
    }
    *out_len = n;
    return HOLO_CG_OK;
}

/* ============================================================================
 * WebAssembly (wasm32-wasi) Binary Module Emitter
 * ============================================================================ */

static int32_t emit_wasm32(
    const HoloFnIr *ir,
    uint8_t *out_buf,
    size_t out_cap,
    size_t *out_len
) {
    uint32_t pcount = ir->param_count;
    switch (ir->op) {
        case HOLO_OP_ADD_IMM:
        case HOLO_OP_SUB_IMM:
        case HOLO_OP_MUL_IMM:
        case HOLO_OP_XOR_IMM:
            if (pcount < 1u) pcount = 1u;
            break;
        case HOLO_OP_ADD_ARGS:
            if (pcount < 2u) pcount = 2u;
            break;
        case HOLO_OP_RET_CONST:
            break;
        default:
            return HOLO_CG_ERR_UNSUPPORTED_OP;
    }
    if (pcount > 8u) pcount = 8u;

    const char *exp_name = (ir->name[0] != '\0') ? ir->name : "holo_fn";
    size_t exp_name_len = cg_strlen(exp_name);
    if (exp_name_len > (HOLO_CG_MAX_NAME_LEN - 1u)) {
        exp_name_len = HOLO_CG_MAX_NAME_LEN - 1u;
    }

    /* Build function body */
    uint8_t body[32];
    size_t body_len = 0u;
    body[body_len++] = 0x00u; /* local decl count = 0 */

    switch (ir->op) {
        case HOLO_OP_ADD_IMM:
            body[body_len++] = 0x20u; body[body_len++] = 0x00u; /* local.get 0 */
            body[body_len++] = 0x42u; /* i64.const */
            body_len += cg_encode_sleb128(body + body_len, (int64_t)ir->imm);
            body[body_len++] = 0x7Cu; /* i64.add */
            break;
        case HOLO_OP_SUB_IMM:
            body[body_len++] = 0x20u; body[body_len++] = 0x00u;
            body[body_len++] = 0x42u;
            body_len += cg_encode_sleb128(body + body_len, (int64_t)ir->imm);
            body[body_len++] = 0x7Du; /* i64.sub */
            break;
        case HOLO_OP_MUL_IMM:
            body[body_len++] = 0x20u; body[body_len++] = 0x00u;
            body[body_len++] = 0x42u;
            body_len += cg_encode_sleb128(body + body_len, (int64_t)ir->imm);
            body[body_len++] = 0x7Eu; /* i64.mul */
            break;
        case HOLO_OP_XOR_IMM:
            body[body_len++] = 0x20u; body[body_len++] = 0x00u;
            body[body_len++] = 0x42u;
            body_len += cg_encode_sleb128(body + body_len, (int64_t)ir->imm);
            body[body_len++] = 0x85u; /* i64.xor */
            break;
        case HOLO_OP_ADD_ARGS:
            body[body_len++] = 0x20u; body[body_len++] = 0x00u; /* local.get 0 */
            body[body_len++] = 0x20u; body[body_len++] = 0x01u; /* local.get 1 */
            body[body_len++] = 0x7Cu; /* i64.add */
            break;
        case HOLO_OP_RET_CONST:
            body[body_len++] = 0x42u; /* i64.const */
            body_len += cg_encode_sleb128(body + body_len, (int64_t)ir->imm);
            break;
        default:
            return HOLO_CG_ERR_UNSUPPORTED_OP;
    }
    body[body_len++] = 0x0Bu; /* end */

    /* Assemble complete Wasm module into stack buffer */
    uint8_t mod[256];
    size_t n = 0u;

    /* Magic + Version: \0asm\1\0\0\0 */
    mod[n++] = 0x00u; mod[n++] = 0x61u; mod[n++] = 0x73u; mod[n++] = 0x6Du;
    mod[n++] = 0x01u; mod[n++] = 0x00u; mod[n++] = 0x00u; mod[n++] = 0x00u;

    /* Section 1: Type section (1 func type: (i64^pcount) -> (i64)) */
    {
        uint8_t sec[24];
        size_t s = 0u;
        sec[s++] = 0x01u; /* type count */
        sec[s++] = 0x60u; /* func */
        sec[s++] = (uint8_t)pcount;
        for (uint32_t i = 0u; i < pcount; i++) sec[s++] = 0x7Eu; /* i64 */
        sec[s++] = 0x01u; /* result count */
        sec[s++] = 0x7Eu; /* i64 */

        mod[n++] = 0x01u; /* section id = Type */
        n += cg_encode_uleb128(mod + n, (uint64_t)s);
        for (size_t i = 0u; i < s; i++) mod[n++] = sec[i];
    }

    /* Section 3: Function section (1 function using type 0) */
    mod[n++] = 0x03u; /* section id = Function */
    mod[n++] = 0x02u; /* section size */
    mod[n++] = 0x01u; /* func count */
    mod[n++] = 0x00u; /* type idx 0 */

    /* Section 7: Export section (1 exported func) */
    {
        uint8_t name_len_buf[4];
        size_t nl_bytes = cg_encode_uleb128(name_len_buf, (uint64_t)exp_name_len);
        size_t sec_size = 1u + nl_bytes + exp_name_len + 2u;

        mod[n++] = 0x07u; /* section id = Export */
        n += cg_encode_uleb128(mod + n, (uint64_t)sec_size);
        mod[n++] = 0x01u; /* export count */
        for (size_t i = 0u; i < nl_bytes; i++) mod[n++] = name_len_buf[i];
        for (size_t i = 0u; i < exp_name_len; i++) mod[n++] = (uint8_t)exp_name[i];
        mod[n++] = 0x00u; /* export kind = func */
        mod[n++] = 0x00u; /* func idx 0 */
    }

    /* Section 10: Code section (1 function body) */
    {
        uint8_t bl_buf[4];
        size_t bl_bytes = cg_encode_uleb128(bl_buf, (uint64_t)body_len);
        size_t sec_size = 1u + bl_bytes + body_len;

        mod[n++] = 0x0Au; /* section id = Code */
        n += cg_encode_uleb128(mod + n, (uint64_t)sec_size);
        mod[n++] = 0x01u; /* code count */
        for (size_t i = 0u; i < bl_bytes; i++) mod[n++] = bl_buf[i];
        for (size_t i = 0u; i < body_len; i++) mod[n++] = body[i];
    }

    if (n > out_cap) {
        return HOLO_CG_ERR_BUFFER_TOO_SMALL;
    }

    for (size_t i = 0u; i < n; i++) {
        out_buf[i] = mod[i];
    }
    *out_len = n;
    return HOLO_CG_OK;
}

/* ============================================================================
 * Public API Implementation
 * ============================================================================ */

HOLO_CG_EXPORT int32_t holo_codegen_check_effects(const HoloFnIr *ir) {
    if (!ir) return 0;
    return ((ir->effect_mask & ~ir->allowed_effect_mask) == 0ULL) ? 1 : 0;
}

HOLO_CG_EXPORT int32_t holo_codegen_emit(
    const HoloFnIr *ir,
    HoloTarget target,
    uint8_t *out_buf,
    size_t out_cap,
    size_t *out_len
) {
    if (out_len) *out_len = 0u;
    if (!ir || !out_buf || !out_len) {
        return HOLO_CG_ERR_INVALID_ARG;
    }

    if (ir->abi_magic != 0u && ir->abi_magic != B8G_ABI_MAGIC_V3) {
        return HOLO_CG_ERR_BAD_MAGIC;
    }

    /* O(1) B8G_ABI_MAGIC_V3 effect gate BEFORE emitting a single byte */
    if ((ir->effect_mask & ~ir->allowed_effect_mask) != 0ULL) {
        return HOLO_CG_ERR_EFFECT_FORBIDDEN;
    }

    switch (target) {
        case HOLO_TARGET_WIN64_X64:
            return emit_x64(ir, 1, out_buf, out_cap, out_len);
        case HOLO_TARGET_SYSV_X64:
            return emit_x64(ir, 0, out_buf, out_cap, out_len);
        case HOLO_TARGET_WASM32_WASI:
            return emit_wasm32(ir, out_buf, out_cap, out_len);
        default:
            return HOLO_CG_ERR_UNSUPPORTED_TARGET;
    }
}

/* ============================================================================
 * Zero-AST Single-Pass Function Source Parser (C / Rust / Zig / TypeScript)
 * ============================================================================ */

static const char *skip_ws(const char *p) {
    while (*p != '\0' && cg_is_space(*p)) p++;
    return p;
}

static int parse_u64_lit(const char *p, uint64_t *out_val, const char **out_end) {
    uint64_t val = 0ULL;
    if (!cg_is_digit(*p)) return 0;

    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
        p += 2;
        if (!cg_is_digit(*p) && !(*p >= 'a' && *p <= 'f') && !(*p >= 'A' && *p <= 'F')) {
            return 0;
        }
        while (*p != '\0') {
            if (*p == '_') { p++; continue; }
            uint64_t d;
            if (*p >= '0' && *p <= '9') d = (uint64_t)(*p - '0');
            else if (*p >= 'a' && *p <= 'f') d = (uint64_t)(10 + (*p - 'a'));
            else if (*p >= 'A' && *p <= 'F') d = (uint64_t)(10 + (*p - 'A'));
            else break;
            val = (val << 4) | d;
            p++;
        }
    } else {
        while (*p != '\0') {
            if (*p == '_') { p++; continue; }
            if (!cg_is_digit(*p)) break;
            val = val * 10ULL + (uint64_t)(*p - '0');
            p++;
        }
    }

    /* Skip optional numeric suffixes (u64, ULL, n, etc.) */
    while (cg_is_ident_char(*p)) p++;
    *out_val = val;
    if (out_end) *out_end = p;
    return 1;
}

HOLO_CG_EXPORT int32_t holo_codegen_parse_fn_source(
    const char *src,
    HoloFnIr *out_ir
) {
    if (!src || !out_ir) {
        return HOLO_CG_ERR_INVALID_ARG;
    }

    cg_zero(out_ir, sizeof(*out_ir));
    out_ir->abi_magic = B8G_ABI_MAGIC_V3;
    out_ir->effect_mask = HOLO_EFFECT_PURE;
    out_ir->allowed_effect_mask = HOLO_EFFECT_PURE;

    /* 1. Locate '(' for parameter list */
    const char *lparen = src;
    while (*lparen != '\0' && *lparen != '(') lparen++;
    if (*lparen != '(') return HOLO_CG_ERR_PARSE_FAILED;

    /* Extract function name immediately before '(' */
    const char *name_end = lparen;
    while (name_end > src && cg_is_space(*(name_end - 1))) name_end--;
    const char *name_start = name_end;
    while (name_start > src && cg_is_ident_char(*(name_start - 1))) name_start--;
    size_t name_len = (size_t)(name_end - name_start);
    if (name_len == 0u) return HOLO_CG_ERR_PARSE_FAILED;
    if (name_len >= HOLO_CG_MAX_NAME_LEN) name_len = HOLO_CG_MAX_NAME_LEN - 1u;
    for (size_t i = 0u; i < name_len; i++) out_ir->name[i] = name_start[i];
    out_ir->name[name_len] = '\0';

    /* 2. Locate matching ')' and count parameters */
    const char *rparen = lparen + 1;
    uint32_t commas = 0u;
    int has_non_ws = 0;
    const char *first_tok = skip_ws(lparen + 1);
    while (*rparen != '\0' && *rparen != ')') {
        if (!cg_is_space(*rparen)) has_non_ws = 1;
        if (*rparen == ',') commas++;
        rparen++;
    }
    if (*rparen != ')') return HOLO_CG_ERR_PARSE_FAILED;

    if (!has_non_ws) {
        out_ir->param_count = 0u;
    } else if (commas == 0u && cg_starts_with(first_tok, "void") && !cg_is_ident_char(first_tok[4])) {
        const char *after_void = skip_ws(first_tok + 4);
        out_ir->param_count = (*after_void == ')') ? 0u : 1u;
    } else {
        out_ir->param_count = commas + 1u;
    }

    /* 3. Locate function body '{' */
    const char *lbrace = rparen + 1;
    while (*lbrace != '\0' && *lbrace != '{') lbrace++;
    if (*lbrace != '{') return HOLO_CG_ERR_PARSE_FAILED;

    const char *p = skip_ws(lbrace + 1);

    /* Optional leading 'return' keyword */
    if (cg_starts_with(p, "return") && !cg_is_ident_char(p[6])) {
        p = skip_ws(p + 6);
    }

    /* Case A: Constant return (e.g. `return 42;` or `{ 0x100 }`) */
    if (cg_is_digit(*p)) {
        uint64_t v = 0ULL;
        if (!parse_u64_lit(p, &v, &p)) return HOLO_CG_ERR_PARSE_FAILED;
        out_ir->op = HOLO_OP_RET_CONST;
        out_ir->imm = v;
        return HOLO_CG_OK;
    }

    /* Case B: Identifier expression (e.g. `x + 999999`, `x.wrapping_add(999999)`, `a + b`) */
    if (!cg_is_ident_start(*p)) return HOLO_CG_ERR_PARSE_FAILED;
    while (cg_is_ident_char(*p)) p++;
    p = skip_ws(p);

    /* Rust method syntax: `.wrapping_add(...)`, `.wrapping_sub(...)`, `.wrapping_mul(...)` */
    if (*p == '.') {
        p++;
        HoloFnOp meth_op;
        if (cg_starts_with(p, "wrapping_add")) {
            meth_op = HOLO_OP_ADD_IMM;
            p += 12;
        } else if (cg_starts_with(p, "wrapping_sub")) {
            meth_op = HOLO_OP_SUB_IMM;
            p += 12;
        } else if (cg_starts_with(p, "wrapping_mul")) {
            meth_op = HOLO_OP_MUL_IMM;
            p += 12;
        } else {
            return HOLO_CG_ERR_PARSE_FAILED;
        }

        p = skip_ws(p);
        if (*p != '(') return HOLO_CG_ERR_PARSE_FAILED;
        p = skip_ws(p + 1);

        if (cg_is_digit(*p)) {
            uint64_t v = 0ULL;
            if (!parse_u64_lit(p, &v, &p)) return HOLO_CG_ERR_PARSE_FAILED;
            out_ir->op = meth_op;
            out_ir->imm = v;
            return HOLO_CG_OK;
        } else if (cg_is_ident_start(*p) && meth_op == HOLO_OP_ADD_IMM) {
            out_ir->op = HOLO_OP_ADD_ARGS;
            out_ir->imm = 0ULL;
            if (out_ir->param_count < 2u) out_ir->param_count = 2u;
            return HOLO_CG_OK;
        }
        return HOLO_CG_ERR_PARSE_FAILED;
    }

    /* Infix operator: +, +%, -, -%, *, *%, ^ */
    char op_ch = *p;
    if (op_ch != '+' && op_ch != '-' && op_ch != '*' && op_ch != '^') {
        return HOLO_CG_ERR_PARSE_FAILED;
    }
    p++;
    if (*p == '%' && (op_ch == '+' || op_ch == '-' || op_ch == '*')) {
        p++; /* Zig wrapping arithmetic operator (+%, -%, *%) */
    }
    p = skip_ws(p);

    if (cg_is_digit(*p)) {
        uint64_t v = 0ULL;
        if (!parse_u64_lit(p, &v, &p)) return HOLO_CG_ERR_PARSE_FAILED;
        switch (op_ch) {
            case '+': out_ir->op = HOLO_OP_ADD_IMM; break;
            case '-': out_ir->op = HOLO_OP_SUB_IMM; break;
            case '*': out_ir->op = HOLO_OP_MUL_IMM; break;
            case '^': out_ir->op = HOLO_OP_XOR_IMM; break;
            default:  return HOLO_CG_ERR_PARSE_FAILED;
        }
        out_ir->imm = v;
        return HOLO_CG_OK;
    } else if (cg_is_ident_start(*p) && op_ch == '+') {
        out_ir->op = HOLO_OP_ADD_ARGS;
        out_ir->imm = 0ULL;
        if (out_ir->param_count < 2u) out_ir->param_count = 2u;
        return HOLO_CG_OK;
    }

    return HOLO_CG_ERR_PARSE_FAILED;
}

HOLO_CG_EXPORT const char *holo_codegen_target_name(HoloTarget target) {
    switch (target) {
        case HOLO_TARGET_WIN64_X64:   return "win64-x64";
        case HOLO_TARGET_SYSV_X64:    return "sysv-x64";
        case HOLO_TARGET_WASM32_WASI: return "wasm32-wasi";
        default:                      return "unknown";
    }
}
