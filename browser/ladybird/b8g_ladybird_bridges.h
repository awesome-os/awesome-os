/*
 * SPDX-License-Identifier: BSD-2-Clause
 * Copyright (c) 2026, Awesome-OS Contributors.
 *
 * Zero-copy C11 accelerator bridges for awesome-os/ladybird:
 *   1. B8gWebGpuRing       - LibWeb/WebGPU -> holo-display-webgpu + Dawn
 *   2. B8gOpfsCasHandle    - OPFS -> B8G v11 CAS (/var/lib/b8g/cas/v11/files/<aa>/<digest>)
 *   3. B8gWebCodecsSession - Generic hardware WebCodecs routing (Vulkan Video / VAAPI /
 *                            NVDEC / VideoToolbox / Apple AVD) with zero desktop-UI coupling.
 *
 * Portable C11 only: zero Linux kernel headers; compiles cleanly on Windows x64,
 * x86_64-linux-musl, and wasm32-wasi under -std=c11 -Wall -Wextra -Werror.
 */

#ifndef B8G_LADYBIRD_BRIDGES_H
#define B8G_LADYBIRD_BRIDGES_H

#include <stdalign.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define B8G_ABI_MAGIC_V3 0x33564742U /* "BGV3" */
#define B8G_BRIDGE_ABI_VERSION 1U

#define B8G_WEBGPU_RING_CAPACITY 64U /* Power of two */
#define B8G_OPFS_DEFAULT_CAS_ROOT "/var/lib/b8g/cas"
#define B8G_OPFS_PATH_MAX 512U
#define B8G_OPFS_DIGEST_HEX_MAX 129U
#define B8G_MODALIAS_MAX 128U

/* Error codes (0 = success, negative = failure) */
#define B8G_OK 0
#define B8G_ERR_INVALID (-1)
#define B8G_ERR_FULL (-2)
#define B8G_ERR_OVERFLOW (-3)
#define B8G_ERR_TRAVERSAL (-4)
#define B8G_ERR_UNSUPPORTED (-5)

/* =========================================================================
 * 1. WebGPU Bridge (LibWeb/WebGPU -> holo-display-webgpu + Dawn)
 * ========================================================================= */

typedef enum B8gWebGpuOpcode {
    B8G_WGPU_OP_NOP = 0U,
    B8G_WGPU_OP_REQUEST_ADAPTER = 1U,
    B8G_WGPU_OP_CREATE_DEVICE = 2U,
    B8G_WGPU_OP_CREATE_BUFFER = 3U,
    B8G_WGPU_OP_WRITE_BUFFER = 4U,
    B8G_WGPU_OP_CREATE_SHADER_WGSL = 5U,
    B8G_WGPU_OP_SUBMIT_QUEUE = 6U,
    B8G_WGPU_OP_PRESENT_SURFACE = 7U
} B8gWebGpuOpcode;

typedef struct B8gWebGpuCmd {
    uint32_t opcode;
    uint32_t byte_len;
    uint64_t wgpu_handle;
    uint64_t seq;
} B8gWebGpuCmd;

typedef struct B8gWebGpuRing {
    _Alignas(64) uint32_t magic;
    uint32_t version;
    uint32_t capacity;
    uint32_t head;
    uint32_t tail;
    uint32_t dropped;
    uint64_t next_seq;
    B8gWebGpuCmd slots[B8G_WEBGPU_RING_CAPACITY];
} B8gWebGpuRing;

int b8g_webgpu_ring_init(B8gWebGpuRing *ring);
int b8g_webgpu_submit_cmd(B8gWebGpuRing *ring, uint32_t opcode, uint64_t wgpu_handle, uint32_t byte_len);
size_t b8g_webgpu_drain(B8gWebGpuRing *ring, B8gWebGpuCmd *out_cmds, size_t max);

/* =========================================================================
 * 2. OPFS-to-v11-CAS Bridge (Origin Private File System -> B8G v11 CAS)
 * ========================================================================= */

typedef struct B8gOpfsCasHandle {
    _Alignas(64) uint32_t magic;
    uint32_t flags;
    uint64_t size_bytes;
    char digest_hex[B8G_OPFS_DIGEST_HEX_MAX];
    char cas_path[B8G_OPFS_PATH_MAX];
} B8gOpfsCasHandle;

int b8g_opfs_resolve_cas_path(const char *cas_root, const char *sha512_hex, char *out_path, size_t out_len);
int b8g_opfs_handle_init(B8gOpfsCasHandle *handle, const char *cas_root, const char *sha512_hex,
                         uint64_t size_bytes, uint32_t flags);

/* =========================================================================
 * 3. Generic Hardware WebCodecs Bridge (zero desktop-UI coupling)
 * ========================================================================= */

typedef enum B8gCodecId {
    B8G_CODEC_UNKNOWN = 0U,
    B8G_CODEC_H264 = 1U,
    B8G_CODEC_HEVC = 2U,
    B8G_CODEC_VP9 = 3U,
    B8G_CODEC_AV1 = 4U
} B8gCodecId;

typedef enum B8gHwAccelBackend {
    B8G_HW_BACKEND_SOFTWARE = 0U,
    B8G_HW_BACKEND_VULKAN_VIDEO = 1U,
    B8G_HW_BACKEND_VAAPI = 2U,
    B8G_HW_BACKEND_NVDEC = 3U,
    B8G_HW_BACKEND_VIDEOTOOLBOX = 4U,
    B8G_HW_BACKEND_APPLE_AVD = 5U
} B8gHwAccelBackend;

typedef struct B8gWebCodecsSession {
    _Alignas(64) uint32_t magic;
    uint32_t flags;
    B8gCodecId codec_id;
    B8gHwAccelBackend backend;
    uint32_t width;
    uint32_t height;
    char modalias[B8G_MODALIAS_MAX];
} B8gWebCodecsSession;

int b8g_webcodecs_select_backend(B8gCodecId codec_id, const char *modalias, B8gHwAccelBackend *out_backend);
const char *b8g_webcodecs_backend_name(B8gHwAccelBackend backend);
int b8g_webcodecs_session_init(B8gWebCodecsSession *session, B8gCodecId codec_id, const char *modalias,
                               uint32_t width, uint32_t height);

/* =========================================================================
 * 4. DNS HTTPS (RFC 9460 TYPE 65 SVCB/HTTPS) Parser — Upstream Issue #5107
 * ========================================================================= */

#define B8G_DNS_ALPN_MAX 16U

typedef struct B8gDnsHttpsRecord {
    _Alignas(64) uint32_t magic;
    uint16_t priority;
    uint16_t port;       /* 0 if default 443 */
    uint8_t supports_h3; /* 1 if "h3" advertised in SvcParam key 1 (alpn) */
    uint8_t supports_h2; /* 1 if "h2" advertised in SvcParam key 1 (alpn) */
    uint16_t ech_len;    /* Byte length of ECH config (SvcParam key 5), if any */
    char primary_alpn[B8G_DNS_ALPN_MAX];
} B8gDnsHttpsRecord;

int b8g_dns_parse_https_rdata(const uint8_t *rdata, size_t rdata_len, B8gDnsHttpsRecord *out_rec);

/* =========================================================================
 * 5. ContentBlocker / uBlock MV3 Rule Matcher — Upstream Issue #976
 * ========================================================================= */

#define B8G_BLOCKER_MAX_RULES 64U
#define B8G_BLOCKER_PATTERN_MAX 128U

typedef struct B8gContentBlocker {
    _Alignas(64) uint32_t magic;
    uint32_t rule_count;
    uint64_t blocked_hits;
    char domain_rules[B8G_BLOCKER_MAX_RULES][B8G_BLOCKER_PATTERN_MAX];
} B8gContentBlocker;

int b8g_content_blocker_init(B8gContentBlocker *cb);
int b8g_content_blocker_add_rule(B8gContentBlocker *cb, const char *rule);
int b8g_content_blocker_should_block(B8gContentBlocker *cb, const char *request_host);

/* =========================================================================
 * 6. WebTransport QUIC Ring & LibJS Holo-JIT Cache
 * ========================================================================= */

typedef struct B8gQuicTransportRing {
    _Alignas(64) uint32_t magic;
    uint32_t head;
    uint32_t tail;
    uint32_t max_datagram_size;
    uint64_t bytes_queued;
} B8gQuicTransportRing;

int b8g_quic_ring_init(B8gQuicTransportRing *ring, uint32_t max_datagram_size);
int b8g_quic_send_datagram(B8gQuicTransportRing *ring, uint32_t payload_len);

#ifdef __cplusplus
}
#endif

#endif /* B8G_LADYBIRD_BRIDGES_H */
