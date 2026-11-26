#include "holo_codegen.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <sys/mman.h>
#  include <time.h>
#endif

static int g_failures = 0;

#define EXPECT(cond, msg)                                                      \
    do {                                                                       \
        if (!(cond)) {                                                         \
            fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, (msg));  \
            g_failures++;                                                      \
        }                                                                      \
    } while (0)

typedef uint64_t (*fn_u64_1_t)(uint64_t);
typedef uint64_t (*fn_u64_2_t)(uint64_t, uint64_t);
typedef uint64_t (*fn_u64_0_t)(void);

static double now_us(void) {
#if defined(_WIN32)
    LARGE_INTEGER freq, counter;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&counter);
    return ((double)counter.QuadPart * 1000000.0) / (double)freq.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000000.0 + (double)ts.tv_nsec / 1000.0;
#endif
}

static uint8_t *alloc_exec_page(size_t size) {
#if defined(_WIN32)
    return (uint8_t *)VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
#else
    void *p = mmap(NULL, size, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    return (p == MAP_FAILED) ? NULL : (uint8_t *)p;
#endif
}

static void free_exec_page(uint8_t *p, size_t size) {
#if defined(_WIN32)
    (void)size;
    if (p) VirtualFree(p, 0, MEM_RELEASE);
#else
    if (p) munmap(p, size);
#endif
}

static void test_parser_and_live_execution(void) {
    printf("[1/4] Testing zero-AST source parser & live native x86-64 execution...\n");

    uint8_t *exec_buf = alloc_exec_page(4096u);
    EXPECT(exec_buf != NULL, "VirtualAlloc/mmap executable page succeeded");
    if (!exec_buf) return;

    /* 1a. Rust source -> compute_250(42) == 1000041 */
    const char *rust_src = "pub fn compute_250(x: u64) -> u64 { x.wrapping_add(999999) }";
    HoloFnIr ir_rust;
    int32_t rc = holo_codegen_parse_fn_source(rust_src, &ir_rust);
    EXPECT(rc == HOLO_CG_OK, "parse Rust compute_250");
    EXPECT(strcmp(ir_rust.name, "compute_250") == 0, "Rust fn name == compute_250");
    EXPECT(ir_rust.param_count == 1u, "Rust param_count == 1");
    EXPECT(ir_rust.op == HOLO_OP_ADD_IMM, "Rust op == HOLO_OP_ADD_IMM");
    EXPECT(ir_rust.imm == 999999ULL, "Rust imm == 999999");

    size_t code_len = 0u;
    HoloTarget host_target =
#if defined(_WIN32)
        HOLO_TARGET_WIN64_X64;
#else
        HOLO_TARGET_SYSV_X64;
#endif

    rc = holo_codegen_emit(&ir_rust, host_target, exec_buf, 64u, &code_len);
    EXPECT(rc == HOLO_CG_OK, "emit native compute_250");
    EXPECT(code_len == 10u, "compute_250 x86-64 size == 10 bytes");

    fn_u64_1_t compute_250 = (fn_u64_1_t)(void *)exec_buf;
    uint64_t r0 = compute_250(42ULL);
    EXPECT(r0 == 1000041ULL, "LIVE EXEC: compute_250(42) == 1000041");
    printf("      LIVE EXEC (Rust->x86-64): compute_250(42) = %llu (expected 1000041, %zu bytes)\n",
           (unsigned long long)r0, code_len);

    /* 1b. C source -> compute_250(42) == 1000041 */
    const char *c_src = "uint64_t compute_250(uint64_t x) { return x + 999999; }";
    HoloFnIr ir_c;
    rc = holo_codegen_parse_fn_source(c_src, &ir_c);
    EXPECT(rc == HOLO_CG_OK, "parse C compute_250");
    EXPECT(strcmp(ir_c.name, "compute_250") == 0, "C fn name == compute_250");
    EXPECT(ir_c.op == HOLO_OP_ADD_IMM && ir_c.imm == 999999ULL, "C IR matches Rust IR");

    /* 1c. Zig & TypeScript sources + all ops live execution */
    const char *zig_sub = "pub fn sub_fn(x: u64) u64 { return x -% 100; }";
    HoloFnIr ir_sub;
    EXPECT(holo_codegen_parse_fn_source(zig_sub, &ir_sub) == HOLO_CG_OK, "parse Zig sub_fn");
    EXPECT(holo_codegen_emit(&ir_sub, host_target, exec_buf + 64u, 64u, &code_len) == HOLO_CG_OK, "emit sub_fn");
    uint64_t r_sub = ((fn_u64_1_t)(void *)(exec_buf + 64u))(142ULL);
    EXPECT(r_sub == 42ULL, "LIVE EXEC: sub_fn(142) == 42");

    const char *ts_mul = "export function mul_fn(x: number): number { return x * 7; }";
    HoloFnIr ir_mul;
    EXPECT(holo_codegen_parse_fn_source(ts_mul, &ir_mul) == HOLO_CG_OK, "parse TS mul_fn");
    EXPECT(holo_codegen_emit(&ir_mul, host_target, exec_buf + 128u, 64u, &code_len) == HOLO_CG_OK, "emit mul_fn");
    uint64_t r_mul = ((fn_u64_1_t)(void *)(exec_buf + 128u))(6ULL);
    EXPECT(r_mul == 42ULL, "LIVE EXEC: mul_fn(6) == 42");

    const char *c_xor = "uint64_t xor_fn(uint64_t x) { return x ^ 0xFF; }";
    HoloFnIr ir_xor;
    EXPECT(holo_codegen_parse_fn_source(c_xor, &ir_xor) == HOLO_CG_OK, "parse C xor_fn");
    EXPECT(holo_codegen_emit(&ir_xor, host_target, exec_buf + 192u, 64u, &code_len) == HOLO_CG_OK, "emit xor_fn");
    uint64_t r_xor = ((fn_u64_1_t)(void *)(exec_buf + 192u))(0xA5ULL);
    EXPECT(r_xor == 0x5AULL, "LIVE EXEC: xor_fn(0xA5) == 0x5A");

    const char *c_add2 = "uint64_t add_args(uint64_t a, uint64_t b) { return a + b; }";
    HoloFnIr ir_add2;
    EXPECT(holo_codegen_parse_fn_source(c_add2, &ir_add2) == HOLO_CG_OK, "parse C add_args");
    EXPECT(holo_codegen_emit(&ir_add2, host_target, exec_buf + 256u, 64u, &code_len) == HOLO_CG_OK, "emit add_args");
    EXPECT(code_len == 5u, "add_args x86-64 size == 5 bytes");
    uint64_t r_add2 = ((fn_u64_2_t)(void *)(exec_buf + 256u))(1000ULL, 337ULL);
    EXPECT(r_add2 == 1337ULL, "LIVE EXEC: add_args(1000, 337) == 1337");

    const char *c_const = "uint64_t ret_const(void) { return 0xCAFEBABE12345678ULL; }";
    HoloFnIr ir_const;
    EXPECT(holo_codegen_parse_fn_source(c_const, &ir_const) == HOLO_CG_OK, "parse C ret_const");
    EXPECT(holo_codegen_emit(&ir_const, host_target, exec_buf + 320u, 64u, &code_len) == HOLO_CG_OK, "emit ret_const");
    uint64_t r_const = ((fn_u64_0_t)(void *)(exec_buf + 320u))();
    EXPECT(r_const == 0xCAFEBABE12345678ULL, "LIVE EXEC: ret_const() == 0xCAFEBABE12345678");

    /* 1d. Full 64-bit immediate add live execution */
    HoloFnIr ir_big = ir_rust;
    ir_big.imm = 0x100000000ULL;
    EXPECT(holo_codegen_emit(&ir_big, host_target, exec_buf + 384u, 64u, &code_len) == HOLO_CG_OK, "emit 64-bit imm add");
    uint64_t r_big = ((fn_u64_1_t)(void *)(exec_buf + 384u))(42ULL);
    EXPECT(r_big == 0x10000002AULL, "LIVE EXEC: add64(42, 0x100000000) == 0x10000002A");

    free_exec_page(exec_buf, 4096u);
}

static void test_sysv_and_wasm_encoding(void) {
    printf("[2/4] Verifying System V x86-64 & WASI WebAssembly binary emission...\n");

    _Alignas(64) uint8_t buf[256];
    size_t len = 0u;

    HoloFnIr ir;
    EXPECT(holo_codegen_parse_fn_source(
        "pub fn compute_250(x: u64) -> u64 { x.wrapping_add(999999) }", &ir
    ) == HOLO_CG_OK, "parse compute_250 for SysV/WASI");

    /* System V x86-64: 48 89 F8 (3) + 48 05 3F 42 0F 00 (6) + C3 (1) = 10 bytes */
    EXPECT(holo_codegen_emit(&ir, HOLO_TARGET_SYSV_X64, buf, sizeof(buf), &len) == HOLO_CG_OK, "emit SysV x64");
    EXPECT(len == 10u, "SysV x64 compact encoding == 10 bytes");
    EXPECT(buf[0] == 0x48u && buf[1] == 0x89u && buf[2] == 0xF8u, "SysV mov rax, rdi");
    EXPECT(buf[3] == 0x48u && buf[4] == 0x05u, "SysV add rax, imm32");
    EXPECT(buf[5] == 0x3Fu && buf[6] == 0x42u && buf[7] == 0x0Fu && buf[8] == 0x00u, "SysV imm32 == 999999");
    EXPECT(buf[9] == 0xC3u, "SysV ret");

    /* WASI WebAssembly module */
    EXPECT(holo_codegen_emit(&ir, HOLO_TARGET_WASM32_WASI, buf, sizeof(buf), &len) == HOLO_CG_OK, "emit WASI wasm");
    EXPECT(len >= 32u, "WASI wasm module non-trivial size");
    EXPECT(buf[0] == 0x00u && buf[1] == 0x61u && buf[2] == 0x73u && buf[3] == 0x6Du, "Wasm magic \\0asm");
    EXPECT(buf[4] == 0x01u && buf[5] == 0x00u && buf[6] == 0x00u && buf[7] == 0x00u, "Wasm version 1");
    printf("      SysV x64: %u bytes | WASI .wasm: %zu bytes (magic=\\0asm v1, export='compute_250')\n",
           10u, len);
}

static void test_effect_gate_rejection(void) {
    printf("[3/4] Testing B8G_ABI_MAGIC_V3 O(1) effect gate rejection (IO_NET vs PURE)...\n");

    _Alignas(64) uint8_t buf[256];
    memset(buf, 0xCC, sizeof(buf));
    size_t len = 999u;

    HoloFnIr ir;
    EXPECT(holo_codegen_parse_fn_source(
        "uint64_t evil_net(uint64_t x) { return x + 1; }", &ir
    ) == HOLO_CG_OK, "parse evil_net");

    ir.effect_mask = HOLO_EFFECT_IO_NET;
    ir.allowed_effect_mask = HOLO_EFFECT_PURE;

    EXPECT(holo_codegen_check_effects(&ir) == 0, "effect gate denies IO_NET under PURE");

    int32_t rc = holo_codegen_emit(&ir, HOLO_TARGET_WIN64_X64, buf, sizeof(buf), &len);
    EXPECT(rc == HOLO_CG_ERR_EFFECT_FORBIDDEN, "emit returns HOLO_CG_ERR_EFFECT_FORBIDDEN");
    EXPECT(len == 0u, "0 bytes emitted on forbidden effect");
    EXPECT(buf[0] == 0xCCu, "output buffer untouched on forbidden effect");

    /* Also verify unaligned native buffer rejection */
    ir.effect_mask = HOLO_EFFECT_PURE;
    rc = holo_codegen_emit(&ir, HOLO_TARGET_WIN64_X64, buf + 1u, sizeof(buf) - 1u, &len);
    EXPECT(rc == HOLO_CG_ERR_UNALIGNED_BUF && len == 0u, "unaligned buffer rejected with 0 bytes");

    printf("      Effect gate: IO_NET under PURE -> HOLO_CG_ERR_EFFECT_FORBIDDEN (%d), 0 bytes emitted\n",
           HOLO_CG_ERR_EFFECT_FORBIDDEN);
}

static void benchmark_1000_functions(void) {
    printf("[4/4] Benchmarking 1,000 in-process compilations x 3 targets (Win64, SysV, WASI)...\n");

    enum { N_FUNCS = 1000 };
    HoloFnIr *irs = (HoloFnIr *)malloc(sizeof(HoloFnIr) * N_FUNCS);
    EXPECT(irs != NULL, "allocated IR table");
    if (!irs) return;

    char src_buf[128];
    for (int i = 0; i < N_FUNCS; i++) {
        snprintf(src_buf, sizeof(src_buf),
                 "pub fn compute_%d(x: u64) -> u64 { x.wrapping_add(%d) }",
                 i, 100000 + i * 7);
        int32_t rc = holo_codegen_parse_fn_source(src_buf, &irs[i]);
        if (rc != HOLO_CG_OK) {
            EXPECT(0, "parse benchmark function");
            free(irs);
            return;
        }
    }

    _Alignas(64) uint8_t out_buf[256];
    const HoloTarget targets[3] = {
        HOLO_TARGET_WIN64_X64,
        HOLO_TARGET_SYSV_X64,
        HOLO_TARGET_WASM32_WASI
    };

    /* Warmup */
    size_t out_len = 0u;
    for (int t = 0; t < 3; t++) {
        (void)holo_codegen_emit(&irs[0], targets[t], out_buf, sizeof(out_buf), &out_len);
    }

    for (int t = 0; t < 3; t++) {
        size_t total_bytes = 0u;
        double t0 = now_us();
        for (int i = 0; i < N_FUNCS; i++) {
            int32_t rc = holo_codegen_emit(&irs[i], targets[t], out_buf, sizeof(out_buf), &out_len);
            if (rc != HOLO_CG_OK) {
                EXPECT(0, "benchmark emit failed");
                break;
            }
            total_bytes += out_len;
        }
        double elapsed_us = now_us() - t0;
        double us_per_fn = elapsed_us / (double)N_FUNCS;
        double speedup_vs_301ms = 301000.0 / (us_per_fn > 0.0001 ? us_per_fn : 0.0001);
        printf("      %-11s : %d fns in %8.2f us -> %6.4f us/fn (%zu bytes total, ~%.0fx faster than 301 ms zig cc)\n",
               holo_codegen_target_name(targets[t]),
               N_FUNCS, elapsed_us, us_per_fn, total_bytes, speedup_vs_301ms);
    }

    /* End-to-end parse + emit (Win64) benchmark */
    {
        size_t total_bytes = 0u;
        double t0 = now_us();
        for (int i = 0; i < N_FUNCS; i++) {
            HoloFnIr tmp_ir;
            snprintf(src_buf, sizeof(src_buf),
                     "pub fn compute_%d(x: u64) -> u64 { x.wrapping_add(%d) }",
                     i, 100000 + i * 7);
            int32_t rc = holo_codegen_parse_fn_source(src_buf, &tmp_ir);
            if (rc == HOLO_CG_OK) {
                rc = holo_codegen_emit(&tmp_ir, HOLO_TARGET_WIN64_X64, out_buf, sizeof(out_buf), &out_len);
            }
            if (rc != HOLO_CG_OK) {
                EXPECT(0, "e2e parse+emit failed");
                break;
            }
            total_bytes += out_len;
        }
        double elapsed_us = now_us() - t0;
        double us_per_fn = elapsed_us / (double)N_FUNCS;
        double speedup_vs_301ms = 301000.0 / (us_per_fn > 0.0001 ? us_per_fn : 0.0001);
        printf("      %-11s : %d fns in %8.2f us -> %6.4f us/fn (%zu bytes total, ~%.0fx faster than 301 ms zig cc)\n",
               "parse+win64", N_FUNCS, elapsed_us, us_per_fn, total_bytes, speedup_vs_301ms);
    }

    free(irs);
}

int main(void) {
    printf("=== libholo_codegen In-Process Native Machine-Code & WASI Emitter Test Suite ===\n");
    test_parser_and_live_execution();
    test_sysv_and_wasm_encoding();
    test_effect_gate_rejection();
    benchmark_1000_functions();

    if (g_failures == 0) {
        printf("=== ALL TESTS PASSED (0 failures) ===\n");
        return 0;
    }
    fprintf(stderr, "=== FAILED (%d failures) ===\n", g_failures);
    return 1;
}
