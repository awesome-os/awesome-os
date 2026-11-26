/*
 * SPDX-License-Identifier: BSD-2-Clause
 * Copyright (c) 2026, Awesome-OS Contributors.
 *
 * Implementation of the zero-copy C11 Awesome-OS accelerator bridges for Ladybird.
 */

#include "b8g_ladybird_bridges.h"

#include <stdbool.h>
#include <string.h>

/* =========================================================================
 * Internal ASCII helpers (locale-independent, zero OS header dependencies)
 * ========================================================================= */

static char b8g_ascii_tolower(char c) {
    if (c >= 'A' && c <= 'Z') {
        return (char)(c + ('a' - 'A'));
    }
    return c;
}

static bool b8g_is_hex_digit(char c) {
    return (c >= '0' && c <= '9') ||
           (c >= 'a' && c <= 'f') ||
           (c >= 'A' && c <= 'F');
}

static bool b8g_contains_ci(const char *haystack, const char *needle) {
    if (haystack == NULL || needle == NULL || needle[0] == '\0') {
        return false;
    }
    for (size_t i = 0; haystack[i] != '\0'; ++i) {
        size_t j = 0;
        while (needle[j] != '\0' && haystack[i + j] != '\0' &&
               b8g_ascii_tolower(haystack[i + j]) == b8g_ascii_tolower(needle[j])) {
            ++j;
        }
        if (needle[j] == '\0') {
            return true;
        }
    }
    return false;
}

static bool b8g_has_path_traversal(const char *path) {
    if (path == NULL) {
        return false;
    }
    size_t i = 0;
    while (path[i] != '\0') {
        /* Reject control characters or backslashes used for traversal evasion */
        unsigned char uc = (unsigned char)path[i];
        if (uc < 0x20U) {
            return true;
        }
        /* Check each path segment delimited by '/' or '\\' */
        if (i == 0 || path[i - 1] == '/' || path[i - 1] == '\\') {
            if (path[i] == '.' && path[i + 1] == '.' &&
                (path[i + 2] == '\0' || path[i + 2] == '/' || path[i + 2] == '\\')) {
                return true;
            }
        }
        ++i;
    }
    return false;
}

/* =========================================================================
 * 1. WebGPU Bridge
 * ========================================================================= */

int b8g_webgpu_ring_init(B8gWebGpuRing *ring) {
    if (ring == NULL) {
        return B8G_ERR_INVALID;
    }
    memset(ring, 0, sizeof(*ring));
    ring->magic = B8G_ABI_MAGIC_V3;
    ring->version = B8G_BRIDGE_ABI_VERSION;
    ring->capacity = B8G_WEBGPU_RING_CAPACITY;
    ring->head = 0U;
    ring->tail = 0U;
    ring->dropped = 0U;
    ring->next_seq = 1U;
    return B8G_OK;
}

int b8g_webgpu_submit_cmd(B8gWebGpuRing *ring, uint32_t opcode, uint64_t wgpu_handle, uint32_t byte_len) {
    if (ring == NULL || ring->magic != B8G_ABI_MAGIC_V3) {
        return B8G_ERR_INVALID;
    }
    if (ring->capacity == 0U || (ring->capacity & (ring->capacity - 1U)) != 0U ||
        ring->capacity > B8G_WEBGPU_RING_CAPACITY) {
        return B8G_ERR_INVALID;
    }

    uint32_t used = (uint32_t)(ring->head - ring->tail);
    if (used >= ring->capacity) {
        ring->dropped++;
        return B8G_ERR_FULL;
    }

    uint32_t idx = ring->head & (ring->capacity - 1U);
    B8gWebGpuCmd *slot = &ring->slots[idx];
    slot->opcode = opcode;
    slot->byte_len = byte_len;
    slot->wgpu_handle = wgpu_handle;
    slot->seq = ring->next_seq++;

    ring->head++;
    return B8G_OK;
}

size_t b8g_webgpu_drain(B8gWebGpuRing *ring, B8gWebGpuCmd *out_cmds, size_t max) {
    if (ring == NULL || ring->magic != B8G_ABI_MAGIC_V3 || out_cmds == NULL || max == 0U) {
        return 0U;
    }
    if (ring->capacity == 0U || (ring->capacity & (ring->capacity - 1U)) != 0U ||
        ring->capacity > B8G_WEBGPU_RING_CAPACITY) {
        return 0U;
    }

    uint32_t available = (uint32_t)(ring->head - ring->tail);
    size_t count = available < max ? (size_t)available : max;

    for (size_t i = 0; i < count; ++i) {
        uint32_t idx = (ring->tail + (uint32_t)i) & (ring->capacity - 1U);
        out_cmds[i] = ring->slots[idx];
    }

    ring->tail += (uint32_t)count;
    return count;
}

/* =========================================================================
 * 2. OPFS-to-v11-CAS Bridge
 * ========================================================================= */

int b8g_opfs_resolve_cas_path(const char *cas_root, const char *sha512_hex, char *out_path, size_t out_len) {
    if (sha512_hex == NULL || out_path == NULL || out_len == 0U) {
        return B8G_ERR_INVALID;
    }

    const char *root = (cas_root != NULL && cas_root[0] != '\0') ? cas_root : B8G_OPFS_DEFAULT_CAS_ROOT;

    if (b8g_has_path_traversal(root) || b8g_has_path_traversal(sha512_hex)) {
        out_path[0] = '\0';
        return B8G_ERR_TRAVERSAL;
    }

    /* Validate digest: must be strictly 64 (SHA-256) or 128 (SHA-512) hex characters */
    size_t digest_len = 0U;
    while (sha512_hex[digest_len] != '\0') {
        char c = sha512_hex[digest_len];
        if (c == '/' || c == '\\' || c == '.') {
            out_path[0] = '\0';
            return B8G_ERR_TRAVERSAL;
        }
        if (!b8g_is_hex_digit(c)) {
            out_path[0] = '\0';
            return B8G_ERR_INVALID;
        }
        digest_len++;
        if (digest_len > 128U) {
            out_path[0] = '\0';
            return B8G_ERR_INVALID;
        }
    }

    if (digest_len != 64U && digest_len != 128U) {
        out_path[0] = '\0';
        return B8G_ERR_INVALID;
    }

    /* Strip trailing '/' from cas_root (preserving single "/" if root is "/") */
    size_t root_len = strlen(root);
    while (root_len > 1U && root[root_len - 1U] == '/') {
        root_len--;
    }

    static const char k_v11_mid[] = "/v11/files/";
    const size_t mid_len = sizeof(k_v11_mid) - 1U;
    const size_t root_prefix_len = (root_len == 1U && root[0] == '/') ? 0U : root_len;

    /* Format: <root>/v11/files/<aa>/<digest>\0 */
    const size_t needed = root_prefix_len + mid_len + 2U + 1U + digest_len + 1U;
    if (needed > out_len) {
        out_path[0] = '\0';
        return B8G_ERR_OVERFLOW;
    }

    size_t pos = 0U;
    if (root_prefix_len > 0U) {
        memcpy(out_path + pos, root, root_prefix_len);
        pos += root_prefix_len;
    }
    memcpy(out_path + pos, k_v11_mid, mid_len);
    pos += mid_len;

    out_path[pos++] = b8g_ascii_tolower(sha512_hex[0]);
    out_path[pos++] = b8g_ascii_tolower(sha512_hex[1]);
    out_path[pos++] = '/';

    for (size_t i = 0; i < digest_len; ++i) {
        out_path[pos++] = b8g_ascii_tolower(sha512_hex[i]);
    }
    out_path[pos] = '\0';

    return B8G_OK;
}

int b8g_opfs_handle_init(B8gOpfsCasHandle *handle, const char *cas_root, const char *sha512_hex,
                         uint64_t size_bytes, uint32_t flags) {
    if (handle == NULL || sha512_hex == NULL) {
        return B8G_ERR_INVALID;
    }
    memset(handle, 0, sizeof(*handle));

    int rc = b8g_opfs_resolve_cas_path(cas_root, sha512_hex, handle->cas_path, sizeof(handle->cas_path));
    if (rc != B8G_OK) {
        return rc;
    }

    size_t dlen = strlen(sha512_hex);
    for (size_t i = 0; i < dlen && i + 1U < sizeof(handle->digest_hex); ++i) {
        handle->digest_hex[i] = b8g_ascii_tolower(sha512_hex[i]);
    }
    handle->digest_hex[dlen] = '\0';
    handle->magic = B8G_ABI_MAGIC_V3;
    handle->flags = flags;
    handle->size_bytes = size_bytes;
    return B8G_OK;
}

/* =========================================================================
 * 3. Generic Hardware WebCodecs Bridge
 * ========================================================================= */

static bool b8g_is_supported_codec(B8gCodecId codec_id) {
    switch (codec_id) {
        case B8G_CODEC_H264:
        case B8G_CODEC_HEVC:
        case B8G_CODEC_VP9:
        case B8G_CODEC_AV1:
            return true;
        case B8G_CODEC_UNKNOWN:
        default:
            return false;
    }
}

int b8g_webcodecs_select_backend(B8gCodecId codec_id, const char *modalias, B8gHwAccelBackend *out_backend) {
    if (out_backend == NULL) {
        return B8G_ERR_INVALID;
    }

    if (!b8g_is_supported_codec(codec_id)) {
        *out_backend = B8G_HW_BACKEND_SOFTWARE;
        return B8G_ERR_UNSUPPORTED;
    }

    if (modalias == NULL || modalias[0] == '\0') {
        *out_backend = B8G_HW_BACKEND_VULKAN_VIDEO;
        return B8G_OK;
    }

    /* Apple Silicon AVD (Linux/Asahi DeviceTree modalias) */
    if (b8g_contains_ci(modalias, "apple,avd") || b8g_contains_ci(modalias, "apple-avd")) {
        *out_backend = B8G_HW_BACKEND_APPLE_AVD;
        return B8G_OK;
    }

    /* macOS / Darwin VideoToolbox */
    if (b8g_contains_ci(modalias, "videotoolbox") ||
        b8g_contains_ci(modalias, "darwin") ||
        b8g_contains_ci(modalias, "macos")) {
        *out_backend = B8G_HW_BACKEND_VIDEOTOOLBOX;
        return B8G_OK;
    }

    /* Nvidia PCI vendor 0x10DE / NVDEC */
    if (b8g_contains_ci(modalias, "v000010de") ||
        b8g_contains_ci(modalias, "nvidia") ||
        b8g_contains_ci(modalias, "nvdec")) {
        *out_backend = B8G_HW_BACKEND_NVDEC;
        return B8G_OK;
    }

    /* Intel PCI vendor 0x8086 / VAAPI */
    if (b8g_contains_ci(modalias, "v00008086") ||
        b8g_contains_ci(modalias, "i915") ||
        b8g_contains_ci(modalias, "vaapi")) {
        *out_backend = B8G_HW_BACKEND_VAAPI;
        return B8G_OK;
    }

    /* AMD PCI vendor 0x1002 and all generic Vulkan-capable hardware */
    if (b8g_contains_ci(modalias, "v00001002") ||
        b8g_contains_ci(modalias, "amdgpu") ||
        b8g_contains_ci(modalias, "vulkan")) {
        *out_backend = B8G_HW_BACKEND_VULKAN_VIDEO;
        return B8G_OK;
    }

    /* Generic hardware fallback: standard Vulkan Video */
    *out_backend = B8G_HW_BACKEND_VULKAN_VIDEO;
    return B8G_OK;
}

const char *b8g_webcodecs_backend_name(B8gHwAccelBackend backend) {
    switch (backend) {
        case B8G_HW_BACKEND_VULKAN_VIDEO:
            return "vulkan-video";
        case B8G_HW_BACKEND_VAAPI:
            return "vaapi";
        case B8G_HW_BACKEND_NVDEC:
            return "nvdec";
        case B8G_HW_BACKEND_VIDEOTOOLBOX:
            return "videotoolbox";
        case B8G_HW_BACKEND_APPLE_AVD:
            return "apple-avd";
        case B8G_HW_BACKEND_SOFTWARE:
        default:
            return "software";
    }
}

int b8g_webcodecs_session_init(B8gWebCodecsSession *session, B8gCodecId codec_id, const char *modalias,
                               uint32_t width, uint32_t height) {
    if (session == NULL) {
        return B8G_ERR_INVALID;
    }
    memset(session, 0, sizeof(*session));

    B8gHwAccelBackend backend = B8G_HW_BACKEND_SOFTWARE;
    int rc = b8g_webcodecs_select_backend(codec_id, modalias, &backend);
    if (rc != B8G_OK) {
        return rc;
    }

    session->magic = B8G_ABI_MAGIC_V3;
    session->codec_id = codec_id;
    session->backend = backend;
    session->width = width;
    session->height = height;

    if (modalias != NULL) {
        size_t len = strlen(modalias);
        if (len >= sizeof(session->modalias)) {
            len = sizeof(session->modalias) - 1U;
        }
        memcpy(session->modalias, modalias, len);
        session->modalias[len] = '\0';
    }
    return B8G_OK;
}

/* =========================================================================
 * 4. DNS HTTPS (RFC 9460 TYPE 65 SVCB/HTTPS) Parser — Upstream Issue #5107
 *    Wire RDATA: SvcPriority(2B) + TargetName(labels ending in 0x00) + SvcParams
 *    SvcParam: Key(2B big-endian) + Len(2B big-endian) + Value(Len B)
 *      Key 1 = alpn, Key 3 = port, Key 5 = ech
 * ========================================================================= */

static uint16_t b8g_rd_be16(const uint8_t *p) {
    return (uint16_t)(((uint16_t)p[0] << 8) | (uint16_t)p[1]);
}

int b8g_dns_parse_https_rdata(const uint8_t *rdata, size_t rdata_len, B8gDnsHttpsRecord *out_rec) {
    if (rdata == NULL || out_rec == NULL || rdata_len < 3U) {
        return B8G_ERR_INVALID;
    }
    memset(out_rec, 0, sizeof(*out_rec));
    out_rec->magic = B8G_ABI_MAGIC_V3;
    out_rec->priority = b8g_rd_be16(rdata);

    /* Walk uncompressed DNS labels of TargetName until 0x00 root label */
    size_t pos = 2U;
    while (pos < rdata_len) {
        uint8_t label_len = rdata[pos++];
        if (label_len == 0U) {
            break;
        }
        if (label_len >= 64U || pos + label_len > rdata_len) {
            return B8G_ERR_INVALID;
        }
        pos += label_len;
    }

    /* AliasMode (priority == 0) has no SvcParams */
    if (out_rec->priority == 0U) {
        return B8G_OK;
    }

    /* Parse SvcParams (Key, Length, Value) */
    while (pos < rdata_len) {
        if (pos + 4U > rdata_len) {
            return B8G_ERR_INVALID;
        }
        uint16_t key = b8g_rd_be16(rdata + pos);
        uint16_t val_len = b8g_rd_be16(rdata + pos + 2U);
        pos += 4U;
        if (pos + val_len > rdata_len) {
            return B8G_ERR_INVALID;
        }
        const uint8_t *val = rdata + pos;

        if (key == 1U) { /* alpn list: 1-byte len + string */
            size_t apos = 0U;
            while (apos < val_len) {
                uint8_t alen = val[apos++];
                if (alen == 0U || apos + alen > val_len) {
                    return B8G_ERR_INVALID;
                }
                if (out_rec->primary_alpn[0] == '\0') {
                    size_t cpy = alen < (B8G_DNS_ALPN_MAX - 1U) ? alen : (B8G_DNS_ALPN_MAX - 1U);
                    memcpy(out_rec->primary_alpn, val + apos, cpy);
                    out_rec->primary_alpn[cpy] = '\0';
                }
                if (alen == 2U && val[apos] == 'h' && val[apos + 1U] == '3') {
                    out_rec->supports_h3 = 1U;
                } else if (alen == 2U && val[apos] == 'h' && val[apos + 1U] == '2') {
                    out_rec->supports_h2 = 1U;
                }
                apos += alen;
            }
        } else if (key == 3U && val_len == 2U) { /* port */
            out_rec->port = b8g_rd_be16(val);
        } else if (key == 5U) { /* ech */
            out_rec->ech_len = val_len;
        }

        pos += val_len;
    }
    return B8G_OK;
}

/* =========================================================================
 * 5. ContentBlocker / uBlock MV3 Rule Matcher — Upstream Issue #976
 *    Supports Adblock Plus / uBlock Origin "||example.com^" domain anchors.
 * ========================================================================= */

int b8g_content_blocker_init(B8gContentBlocker *cb) {
    if (cb == NULL) {
        return B8G_ERR_INVALID;
    }
    memset(cb, 0, sizeof(*cb));
    cb->magic = B8G_ABI_MAGIC_V3;
    return B8G_OK;
}

int b8g_content_blocker_add_rule(B8gContentBlocker *cb, const char *rule) {
    if (cb == NULL || cb->magic != B8G_ABI_MAGIC_V3 || rule == NULL) {
        return B8G_ERR_INVALID;
    }
    if (cb->rule_count >= B8G_BLOCKER_MAX_RULES) {
        return B8G_ERR_FULL;
    }

    /* Strip leading "||" and trailing "^" or "/" */
    const char *start = rule;
    if (start[0] == '|' && start[1] == '|') {
        start += 2;
    }
    size_t len = 0U;
    while (start[len] != '\0' && start[len] != '^' && start[len] != '/') {
        len++;
    }
    if (len == 0U || len >= B8G_BLOCKER_PATTERN_MAX) {
        return B8G_ERR_INVALID;
    }

    char *dst = cb->domain_rules[cb->rule_count++];
    for (size_t i = 0U; i < len; ++i) {
        dst[i] = b8g_ascii_tolower(start[i]);
    }
    dst[len] = '\0';
    return B8G_OK;
}

int b8g_content_blocker_should_block(B8gContentBlocker *cb, const char *request_host) {
    if (cb == NULL || cb->magic != B8G_ABI_MAGIC_V3 || request_host == NULL || request_host[0] == '\0') {
        return 0;
    }
    size_t host_len = strlen(request_host);
    char lower_host[256];
    if (host_len >= sizeof(lower_host)) {
        return 0;
    }
    for (size_t i = 0U; i < host_len; ++i) {
        lower_host[i] = b8g_ascii_tolower(request_host[i]);
    }
    lower_host[host_len] = '\0';

    for (uint32_t r = 0U; r < cb->rule_count; ++r) {
        const char *pat = cb->domain_rules[r];
        size_t pat_len = strlen(pat);
        if (host_len == pat_len && strcmp(lower_host, pat) == 0) {
            cb->blocked_hits++;
            return 1;
        }
        if (host_len > pat_len &&
            lower_host[host_len - pat_len - 1U] == '.' &&
            strcmp(lower_host + (host_len - pat_len), pat) == 0) {
            cb->blocked_hits++;
            return 1;
        }
    }
    return 0;
}

/* =========================================================================
 * 6. WebTransport QUIC Ring
 * ========================================================================= */

int b8g_quic_ring_init(B8gQuicTransportRing *ring, uint32_t max_datagram_size) {
    if (ring == NULL || max_datagram_size == 0U) {
        return B8G_ERR_INVALID;
    }
    memset(ring, 0, sizeof(*ring));
    ring->magic = B8G_ABI_MAGIC_V3;
    ring->max_datagram_size = max_datagram_size;
    return B8G_OK;
}

int b8g_quic_send_datagram(B8gQuicTransportRing *ring, uint32_t payload_len) {
    if (ring == NULL || ring->magic != B8G_ABI_MAGIC_V3) {
        return B8G_ERR_INVALID;
    }
    if (payload_len > ring->max_datagram_size) {
        return B8G_ERR_OVERFLOW;
    }
    ring->head++;
    ring->bytes_queued += payload_len;
    return B8G_OK;
}
