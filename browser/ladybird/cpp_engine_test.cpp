/* SPDX-License-Identifier: BSD-2-Clause */
#include "../Extensions/WebExtensionsMV3.h"
#include "LibJS/JIT/HoloHotLoopJIT.h"
#include "LibWasm/SIMD/Simd128.h"
#include "b8g_ladybird_bridges.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define EXPECT_OK(cond)                                                               \
    do {                                                                              \
        if (!(cond)) {                                                                \
            std::fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, #cond);    \
            return EXIT_FAILURE;                                                      \
        }                                                                             \
    } while (0)

int main()
{
    // 1. Verify LibJS HoloHotLoopJIT tier-up at N=100 & 4-way unrolled f64 kernel
    JS::JIT::HoloHotLoopJIT jit;
    JS::JIT::HotLoopProfile prof { .bytecode_hash = 0xCAFEBABEULL };
    for (uint32_t i = 0; i < 99; ++i)
        EXPECT_OK(!jit.record_and_maybe_tier_up(prof));
    EXPECT_OK(jit.record_and_maybe_tier_up(prof));
    EXPECT_OK(jit.compiled_kernel_count() == 1);

    std::vector<double> vals = { 1.5, 2.5, 3.0, 4.0, 5.0 };
    EXPECT_OK(std::fabs(jit.execute_compiled_sum_f64(vals.data(), vals.size()) - 16.0) < 1e-9);

    // 2. Verify LibWasm 128-bit SIMD128 vector lanes
    auto va = Wasm::SIMD::i32x4_splat(10);
    auto vb = Wasm::SIMD::i32x4_splat(32);
    auto vc = Wasm::SIMD::i32x4_add(va, vb);
    for (int lane : vc.i32x4)
        EXPECT_OK(lane == 42);

    // 3. Verify MV3 WebExtensions / uBlock ContentBlocker (#976)
    Ladybird::Extensions::WebExtensionsMV3Host mv3;
    EXPECT_OK(mv3.register_filter_rule("||telemetry.example.com^"));
    EXPECT_OK(mv3.should_block_request("sub.telemetry.example.com"));
    EXPECT_OK(!mv3.should_block_request("awesome-os.com"));
    EXPECT_OK(mv3.blocked_count() == 1);

    std::printf("PASS: Ladybird C++23 HoloHotLoopJIT + Wasm::SIMD128 + MV3 uBlock host verified\n");
    return EXIT_SUCCESS;
}
