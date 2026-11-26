/*
 * SPDX-License-Identifier: BSD-2-Clause
 * Copyright (c) 2026, Awesome-OS Contributors.
 *
 * Self-contained C11 unit test suite for b8g_ladybird_bridges.
 */

#include "b8g_ladybird_bridges.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;

#define EXPECT_TRUE(cond)                                                                         \
    do {                                                                                          \
        if (!(cond)) {                                                                            \
            fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, #cond);                     \
            g_failures++;                                                                         \
        }                                                                                         \
    } while (0)

#define EXPECT_EQ_U64(actual, expected)                                                           \
    do {                                                                                          \
        uint64_t a__ = (uint64_t)(actual);                                                        \
        uint64_t e__ = (uint64_t)(expected);                                                      \
        if (a__ != e__) {                                                                         \
            fprintf(stderr, "FAIL [%s:%d]: %s == %llu (expected %llu)\n", __FILE__, __LINE__,     \
                    #actual, (unsigned long long)a__, (unsigned long long)e__);                   \
            g_failures++;                                                                         \
        }                                                                                         \
    } while (0)

#define EXPECT_EQ_INT(actual, expected)                                                           \
    do {                                                                                          \
        int a__ = (int)(actual);                                                                  \
        int e__ = (int)(expected);                                                                \
        if (a__ != e__) {                                                                         \
            fprintf(stderr, "FAIL [%s:%d]: %s == %d (expected %d)\n", __FILE__, __LINE__,         \
                    #actual, a__, e__);                                                           \
            g_failures++;                                                                         \
        }                                                                                         \
    } while (0)

#define EXPECT_STREQ(actual, expected)                                                            \
    do {                                                                                          \
        if (strcmp((actual), (expected)) != 0) {                                                  \
            fprintf(stderr, "FAIL [%s:%d]: \"%s\" != \"%s\"\n", __FILE__, __LINE__, (actual),     \
                    (expected));                                                                  \
            g_failures++;                                                                         \
        }                                                                                         \
    } while (0)

static void test_abi_and_alignment(void) {
    EXPECT_EQ_U64(_Alignof(B8gWebGpuRing), 64U);
    EXPECT_EQ_U64(_Alignof(B8gOpfsCasHandle), 64U);
    EXPECT_EQ_U64(_Alignof(B8gWebCodecsSession), 64U);
    EXPECT_EQ_U64(B8G_ABI_MAGIC_V3, 0x33564742U);
}

static void test_webgpu_ring_submit_drain_wraparound(void) {
    B8gWebGpuRing ring;
    EXPECT_EQ_INT(b8g_webgpu_ring_init(&ring), B8G_OK);
    EXPECT_EQ_U64(ring.magic, B8G_ABI_MAGIC_V3);
    EXPECT_EQ_U64(ring.capacity, B8G_WEBGPU_RING_CAPACITY);

    /* Fill to exact capacity */
    for (uint32_t i = 0; i < B8G_WEBGPU_RING_CAPACITY; ++i) {
        EXPECT_EQ_INT(b8g_webgpu_submit_cmd(&ring, B8G_WGPU_OP_WRITE_BUFFER, 0x1000U + i, 64U + i),
                      B8G_OK);
    }

    /* Next submit must report full and increment dropped */
    EXPECT_EQ_INT(b8g_webgpu_submit_cmd(&ring, B8G_WGPU_OP_SUBMIT_QUEUE, 0x9999U, 0U), B8G_ERR_FULL);
    EXPECT_EQ_U64(ring.dropped, 1U);

    /* Drain half */
    B8gWebGpuCmd drained[B8G_WEBGPU_RING_CAPACITY];
    size_t n1 = b8g_webgpu_drain(&ring, drained, 32U);
    EXPECT_EQ_U64(n1, 32U);
    EXPECT_EQ_U64(drained[0].wgpu_handle, 0x1000U);
    EXPECT_EQ_U64(drained[0].seq, 1U);
    EXPECT_EQ_U64(drained[31].wgpu_handle, 0x101FU);
    EXPECT_EQ_U64(drained[31].seq, 32U);

    /* Submit 32 more to force wrap-around across ring boundary */
    for (uint32_t i = 0; i < 32U; ++i) {
        EXPECT_EQ_INT(
            b8g_webgpu_submit_cmd(&ring, B8G_WGPU_OP_PRESENT_SURFACE, 0x2000U + i, 128U + i),
            B8G_OK);
    }

    /* Drain all 64 (32 from first batch + 32 wrapped) */
    size_t n2 = b8g_webgpu_drain(&ring, drained, B8G_WEBGPU_RING_CAPACITY);
    EXPECT_EQ_U64(n2, B8G_WEBGPU_RING_CAPACITY);
    EXPECT_EQ_U64(drained[0].wgpu_handle, 0x1020U);
    EXPECT_EQ_U64(drained[31].wgpu_handle, 0x103FU);
    EXPECT_EQ_U64(drained[32].opcode, B8G_WGPU_OP_PRESENT_SURFACE);
    EXPECT_EQ_U64(drained[32].wgpu_handle, 0x2000U);
    EXPECT_EQ_U64(drained[63].wgpu_handle, 0x201FU);
    EXPECT_EQ_U64(drained[63].seq, 96U);

    /* Empty ring drains 0 */
    EXPECT_EQ_U64(b8g_webgpu_drain(&ring, drained, 8U), 0U);
}

static void test_opfs_v11_cas_bridge(void) {
    const char *sha512 =
        "AB12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890"
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const char *sha256 =
        "DeadBeef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

    char out[B8G_OPFS_PATH_MAX];

    /* Default root + 128-hex SHA-512 (normalizes hex to lowercase) */
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path(NULL, sha512, out, sizeof(out)), B8G_OK);
    EXPECT_STREQ(out,
                 "/var/lib/b8g/cas/v11/files/ab/"
                 "ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890"
                 "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

    /* Custom root with trailing slash + 64-hex SHA-256 */
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path("/srv/b8g/cas/", sha256, out, sizeof(out)), B8G_OK);
    EXPECT_STREQ(out,
                 "/srv/b8g/cas/v11/files/de/"
                 "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567");

    /* Full handle init */
    B8gOpfsCasHandle handle;
    EXPECT_EQ_INT(b8g_opfs_handle_init(&handle, "/var/lib/b8g/cas", sha512, 4096U, 1U), B8G_OK);
    EXPECT_EQ_U64(handle.magic, B8G_ABI_MAGIC_V3);
    EXPECT_EQ_U64(handle.size_bytes, 4096U);

    /* Path traversal rejections */
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path("/var/lib/b8g/cas", "../etc/passwd", out, sizeof(out)),
                  B8G_ERR_TRAVERSAL);
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path("/var/lib/b8g/../etc", sha256, out, sizeof(out)),
                  B8G_ERR_TRAVERSAL);
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path("/var/lib/b8g/cas", "aa/../../shadow", out, sizeof(out)),
                  B8G_ERR_TRAVERSAL);

    /* Invalid digest length and non-hex characters */
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path("/var/lib/b8g/cas", "abcdef", out, sizeof(out)),
                  B8G_ERR_INVALID);
    EXPECT_EQ_INT(
        b8g_opfs_resolve_cas_path("/var/lib/b8g/cas",
                                  "zzzzzzzz0123456789abcdef0123456789abcdef0123456789abcdef01234567",
                                  out, sizeof(out)),
        B8G_ERR_INVALID);

    /* Buffer too small */
    EXPECT_EQ_INT(b8g_opfs_resolve_cas_path("/var/lib/b8g/cas", sha256, out, 16U),
                  B8G_ERR_OVERFLOW);
}

static void test_webcodecs_backend_selection(void) {
    B8gHwAccelBackend backend = B8G_HW_BACKEND_SOFTWARE;

    /* AMD GPU -> vulkan-video */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_AV1, "pci:v00001002d0000744Csv00001002", &backend),
                  B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_VULKAN_VIDEO);
    EXPECT_STREQ(b8g_webcodecs_backend_name(backend), "vulkan-video");

    /* Intel GPU -> vaapi */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_HEVC, "pci:v00008086d000056A0sv00008086", &backend),
                  B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_VAAPI);
    EXPECT_STREQ(b8g_webcodecs_backend_name(backend), "vaapi");

    /* Nvidia GPU -> nvdec */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_H264, "pci:v000010DEd00002684sv000010DE", &backend),
                  B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_NVDEC);
    EXPECT_STREQ(b8g_webcodecs_backend_name(backend), "nvdec");

    /* macOS VideoToolbox -> videotoolbox */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_VP9, "darwin:videotoolbox:arm64", &backend),
                  B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_VIDEOTOOLBOX);
    EXPECT_STREQ(b8g_webcodecs_backend_name(backend), "videotoolbox");

    /* Apple Silicon Linux/Asahi AVD -> apple-avd */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_H264, "of:Nvideo-decoderT<NULL>Capple,avd", &backend),
                  B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_APPLE_AVD);
    EXPECT_STREQ(b8g_webcodecs_backend_name(backend), "apple-avd");

    /* Generic / VirtIO / unknown modalias -> vulkan-video */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_AV1, "pci:v00001AF4d00001050", &backend),
                  B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_VULKAN_VIDEO);

    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_VP9, NULL, &backend), B8G_OK);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_VULKAN_VIDEO);

    /* Unsupported codec -> error + software fallback */
    EXPECT_EQ_INT(b8g_webcodecs_select_backend(B8G_CODEC_UNKNOWN, "pci:v000010DEd00002684", &backend),
                  B8G_ERR_UNSUPPORTED);
    EXPECT_EQ_INT((int)backend, (int)B8G_HW_BACKEND_SOFTWARE);

    /* Session init check */
    B8gWebCodecsSession sess;
    EXPECT_EQ_INT(b8g_webcodecs_session_init(&sess, B8G_CODEC_AV1, "pci:v00001002d0000744C", 3840U, 2160U),
                  B8G_OK);
    EXPECT_EQ_U64(sess.magic, B8G_ABI_MAGIC_V3);
    EXPECT_EQ_INT((int)sess.backend, (int)B8G_HW_BACKEND_VULKAN_VIDEO);
    EXPECT_EQ_U64(sess.width, 3840U);
    EXPECT_EQ_U64(sess.height, 2160U);
}

static void test_dns_https_type65_parser(void) {
    /* RFC 9460 HTTPS RDATA:
     * Priority = 1 (0x00, 0x01)
     * TargetName = "." (0x00)
     * SvcParam 1 (alpn): key=0x0001, len=0x0006, val="\x02h3\x02h2"
     * SvcParam 3 (port): key=0x0003, len=0x0002, val=0x20fb (8443)
     * SvcParam 5 (ech):  key=0x0005, len=0x0004, val=0xdeadbeef
     */
    const uint8_t rdata[] = {
        0x00, 0x01,
        0x00,
        0x00, 0x01, 0x00, 0x06, 0x02, 'h', '3', 0x02, 'h', '2',
        0x00, 0x03, 0x00, 0x02, 0x20, 0xFB,
        0x00, 0x05, 0x00, 0x04, 0xDE, 0xAD, 0xBE, 0xEF
    };
    B8gDnsHttpsRecord rec;
    EXPECT_EQ_INT(b8g_dns_parse_https_rdata(rdata, sizeof(rdata), &rec), B8G_OK);
    EXPECT_EQ_U64(rec.magic, B8G_ABI_MAGIC_V3);
    EXPECT_EQ_U64(rec.priority, 1U);
    EXPECT_EQ_U64(rec.supports_h3, 1U);
    EXPECT_EQ_U64(rec.supports_h2, 1U);
    EXPECT_EQ_U64(rec.port, 8443U);
    EXPECT_EQ_U64(rec.ech_len, 4U);
    EXPECT_STREQ(rec.primary_alpn, "h3");
}

static void test_ublock_content_blocker_and_quic(void) {
    B8gContentBlocker cb;
    EXPECT_EQ_INT(b8g_content_blocker_init(&cb), B8G_OK);
    EXPECT_EQ_INT(b8g_content_blocker_add_rule(&cb, "||doubleclick.net^"), B8G_OK);
    EXPECT_EQ_INT(b8g_content_blocker_add_rule(&cb, "||google-analytics.com^"), B8G_OK);

    EXPECT_EQ_INT(b8g_content_blocker_should_block(&cb, "ads.doubleclick.net"), 1);
    EXPECT_EQ_INT(b8g_content_blocker_should_block(&cb, "DOUBLECLICK.NET"), 1);
    EXPECT_EQ_INT(b8g_content_blocker_should_block(&cb, "awesome-os.com"), 0);
    EXPECT_EQ_U64(cb.blocked_hits, 2U);

    B8gQuicTransportRing qring;
    EXPECT_EQ_INT(b8g_quic_ring_init(&qring, 1200U), B8G_OK);
    EXPECT_EQ_INT(b8g_quic_send_datagram(&qring, 512U), B8G_OK);
    EXPECT_EQ_INT(b8g_quic_send_datagram(&qring, 2000U), B8G_ERR_OVERFLOW);
    EXPECT_EQ_U64(qring.bytes_queued, 512U);
}

int main(void) {
    test_abi_and_alignment();
    test_webgpu_ring_submit_drain_wraparound();
    test_opfs_v11_cas_bridge();
    test_webcodecs_backend_selection();
    test_dns_https_type65_parser();
    test_ublock_content_blocker_and_quic();

    if (g_failures > 0) {
        fprintf(stderr, "FAILED: %d assertion(s) failed\n", g_failures);
        return EXIT_FAILURE;
    }

    printf("PASS: all b8g_ladybird_bridges C11 unit tests passed (ABI=0x%08X, align=%zu)\n",
           B8G_ABI_MAGIC_V3, _Alignof(B8gWebGpuRing));
    return EXIT_SUCCESS;
}
