#include "git_forge.h"

#include <stdio.h>
#include <string.h>

static int ascii_tolower(int c) {
    if (c >= 'A' && c <= 'Z') {
        return c + ('a' - 'A');
    }
    return c;
}

static int ascii_eq_ci_n(const char* a, size_t a_len, const char* b) {
    size_t b_len = strlen(b);
    if (a_len != b_len) {
        return 0;
    }
    for (size_t i = 0; i < a_len; ++i) {
        if (ascii_tolower((unsigned char)a[i]) != ascii_tolower((unsigned char)b[i])) {
            return 0;
        }
    }
    return 1;
}

static int ascii_ends_with_ci(const char* s, size_t len, const char* suffix) {
    size_t slen = strlen(suffix);
    if (len < slen) {
        return 0;
    }
    return ascii_eq_ci_n(s + (len - slen), slen, suffix);
}

static int copy_checked(const char* src, size_t len, char* dst, size_t cap) {
    if (len + 1u > cap) {
        return B8G_GIT_FORGE_ERR_OVERFLOW;
    }
    if (len > 0u) {
        memcpy(dst, src, len);
    }
    dst[len] = '\0';
    return B8G_GIT_FORGE_OK;
}

static int has_ctrl_or_space(const char* s, size_t len) {
    for (size_t i = 0; i < len; ++i) {
        unsigned char ch = (unsigned char)s[i];
        if (ch <= 0x20u || ch == 0x7Fu) {
            return 1;
        }
    }
    return 0;
}

static int has_path_traversal(const char* s, size_t len) {
    if (len == 0u) {
        return 0;
    }
    if (s[0] == '/' || s[0] == '\\') {
        return 1;
    }
    size_t seg_start = 0u;
    for (size_t i = 0; i <= len; ++i) {
        if (i < len && s[i] == '\\') {
            return 1;
        }
        if (i == len || s[i] == '/') {
            size_t seg_len = i - seg_start;
            if (seg_len == 0u) {
                return 1;
            }
            if (seg_len == 2u && s[seg_start] == '.' && s[seg_start + 1u] == '.') {
                return 1;
            }
            seg_start = i + 1u;
        }
    }
    return 0;
}

static int is_forbidden_host(const char* host, size_t len) {
    if (len == 0u) {
        return 1;
    }

    /* Strip optional :port (handling bracketed IPv6 like [::1]:8080). */
    const char* name = host;
    size_t name_len = len;
    if (host[0] == '[') {
        const char* close_bracket = (const char*)memchr(host, ']', len);
        if (close_bracket == NULL) {
            return 1;
        }
        name = host + 1;
        name_len = (size_t)(close_bracket - (host + 1));
    } else {
        const char* colon = (const char*)memchr(host, ':', len);
        if (colon != NULL) {
            /* If there is another colon, treat as unbracketed IPv6 literal. */
            const char* second_colon = (const char*)memchr(
                colon + 1, ':', (size_t)((host + len) - (colon + 1))
            );
            if (second_colon == NULL) {
                name_len = (size_t)(colon - host);
            }
        }
    }

    /* Strip optional trailing DNS root dot. */
    while (name_len > 0u && name[name_len - 1u] == '.') {
        --name_len;
    }

    if (name_len == 0u) {
        return 1;
    }

    if (ascii_eq_ci_n(name, name_len, "localhost") ||
        ascii_ends_with_ci(name, name_len, ".localhost") ||
        ascii_eq_ci_n(name, name_len, "127.0.0.1") ||
        ascii_eq_ci_n(name, name_len, "0.0.0.0") ||
        ascii_eq_ci_n(name, name_len, "::1") ||
        ascii_eq_ci_n(name, name_len, "0:0:0:0:0:0:0:1")) {
        return 1;
    }

    /* Reject entire 127.0.0.0/8 loopback block (B8G016). */
    if (name_len >= 4u &&
        name[0] == '1' && name[1] == '2' && name[2] == '7' && name[3] == '.') {
        return 1;
    }

    return 0;
}

static int parse_query(const char* query, size_t query_len, b8g_git_forge_uri_t* out) {
    if (query_len == 0u) {
        return B8G_GIT_FORGE_ERR_SYNTAX;
    }

    size_t pos = 0u;
    while (pos < query_len) {
        const char* amp = (const char*)memchr(query + pos, '&', query_len - pos);
        size_t pair_len = (amp != NULL)
            ? (size_t)(amp - (query + pos))
            : (query_len - pos);

        if (pair_len == 0u) {
            return B8G_GIT_FORGE_ERR_SYNTAX;
        }

        const char* pair = query + pos;
        const char* eq = (const char*)memchr(pair, '=', pair_len);
        if (eq == NULL) {
            return B8G_GIT_FORGE_ERR_SYNTAX;
        }

        size_t key_len = (size_t)(eq - pair);
        const char* val = eq + 1;
        size_t val_len = pair_len - key_len - 1u;

        if (key_len == 0u || val_len == 0u || has_ctrl_or_space(val, val_len)) {
            return B8G_GIT_FORGE_ERR_SYNTAX;
        }
        if (has_path_traversal(val, val_len)) {
            return B8G_GIT_FORGE_ERR_TRAVERSAL;
        }

        if (key_len == 4u && memcmp(pair, "hook", 4u) == 0) {
            int rc = copy_checked(val, val_len, out->hook, sizeof(out->hook));
            if (rc != B8G_GIT_FORGE_OK) {
                return rc;
            }
        } else if (key_len == 6u && memcmp(pair, "target", 6u) == 0) {
            int rc = copy_checked(val, val_len, out->target, sizeof(out->target));
            if (rc != B8G_GIT_FORGE_OK) {
                return rc;
            }
        } else {
            return B8G_GIT_FORGE_ERR_SYNTAX;
        }

        if (amp == NULL) {
            break;
        }
        pos = (size_t)((amp + 1) - query);
        if (pos == query_len) {
            return B8G_GIT_FORGE_ERR_SYNTAX;
        }
    }

    return B8G_GIT_FORGE_OK;
}

B8G_GIT_FORGE_API uint32_t b8g_git_forge_abi_magic(void) {
    return B8G_GIT_FORGE_ABI_MAGIC_V3;
}

B8G_GIT_FORGE_API int b8g_git_forge_parse_uri(
    const char* uri,
    b8g_git_forge_uri_t* out
) {
    static const char kPrimaryScheme[] = B8G_REPOSITORY_SCHEME;
    static const char kLegacyScheme[]  = B8G_GIT_FORGE_SCHEME_ALIAS;
    const size_t kPrimaryLen = sizeof(kPrimaryScheme) - 1u;
    const size_t kLegacyLen  = sizeof(kLegacyScheme) - 1u;

    if (uri == NULL || out == NULL) {
        return B8G_GIT_FORGE_ERR_NULL;
    }

    memset(out, 0, sizeof(*out));

    size_t uri_len = strlen(uri);
    size_t scheme_len = 0u;
    if (uri_len >= kPrimaryLen && memcmp(uri, kPrimaryScheme, kPrimaryLen) == 0) {
        scheme_len = kPrimaryLen;
    } else if (uri_len >= kLegacyLen && memcmp(uri, kLegacyScheme, kLegacyLen) == 0) {
        scheme_len = kLegacyLen;
    } else {
        return B8G_GIT_FORGE_ERR_SCHEME;
    }

    const char* rest = uri + scheme_len;
    size_t rest_len = uri_len - scheme_len;
    if (rest_len == 0u || has_ctrl_or_space(rest, rest_len)) {
        return B8G_GIT_FORGE_ERR_SYNTAX;
    }

    /* Separate optional ?query suffix. */
    const char* qmark = (const char*)memchr(rest, '?', rest_len);
    size_t pre_query_len = (qmark != NULL) ? (size_t)(qmark - rest) : rest_len;
    if (qmark != NULL) {
        size_t query_len = rest_len - pre_query_len - 1u;
        int rc = parse_query(qmark + 1, query_len, out);
        if (rc != B8G_GIT_FORGE_OK) {
            memset(out, 0, sizeof(*out));
            return rc;
        }
    }

    /* Separate optional #subpath suffix. */
    const char* hash = (const char*)memchr(rest, '#', pre_query_len);
    size_t base_len = (hash != NULL) ? (size_t)(hash - rest) : pre_query_len;
    if (hash != NULL) {
        const char* subpath = hash + 1;
        size_t subpath_len = pre_query_len - base_len - 1u;
        if (subpath_len == 0u) {
            memset(out, 0, sizeof(*out));
            return B8G_GIT_FORGE_ERR_SYNTAX;
        }
        if (has_path_traversal(subpath, subpath_len)) {
            memset(out, 0, sizeof(*out));
            return B8G_GIT_FORGE_ERR_TRAVERSAL;
        }
        int rc = copy_checked(subpath, subpath_len, out->subpath, sizeof(out->subpath));
        if (rc != B8G_GIT_FORGE_OK) {
            memset(out, 0, sizeof(*out));
            return rc;
        }
    }

    /* Parse <host>/<org>/<repo>@<ref> from rest[0..base_len). */
    const char* slash1 = (const char*)memchr(rest, '/', base_len);
    if (slash1 == NULL || slash1 == rest) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_SYNTAX;
    }
    const char* host = rest;
    size_t host_len = (size_t)(slash1 - rest);
    if (is_forbidden_host(host, host_len)) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_LOCALHOST;
    }

    const char* after_host = slash1 + 1;
    size_t after_host_len = base_len - host_len - 1u;
    const char* slash2 = (const char*)memchr(after_host, '/', after_host_len);
    if (slash2 == NULL || slash2 == after_host) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_SYNTAX;
    }
    const char* org = after_host;
    size_t org_len = (size_t)(slash2 - after_host);
    if (has_path_traversal(org, org_len)) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_TRAVERSAL;
    }

    const char* repo_and_ref = slash2 + 1;
    size_t repo_and_ref_len = after_host_len - org_len - 1u;
    const char* at = (const char*)memchr(repo_and_ref, '@', repo_and_ref_len);
    if (at == NULL) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_MISSING_REF;
    }

    const char* repo = repo_and_ref;
    size_t repo_len = (size_t)(at - repo_and_ref);
    const char* ref = at + 1;
    size_t ref_len = repo_and_ref_len - repo_len - 1u;

    if (repo_len == 0u || memchr(repo, '/', repo_len) != NULL) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_SYNTAX;
    }
    if (has_path_traversal(repo, repo_len)) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_TRAVERSAL;
    }

    if (ref_len == 0u) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_MISSING_REF;
    }
    if (has_path_traversal(ref, ref_len)) {
        memset(out, 0, sizeof(*out));
        return B8G_GIT_FORGE_ERR_TRAVERSAL;
    }

    int rc = copy_checked(host, host_len, out->host, sizeof(out->host));
    if (rc == B8G_GIT_FORGE_OK) {
        rc = copy_checked(org, org_len, out->org, sizeof(out->org));
    }
    if (rc == B8G_GIT_FORGE_OK) {
        rc = copy_checked(repo, repo_len, out->repo, sizeof(out->repo));
    }
    if (rc == B8G_GIT_FORGE_OK) {
        rc = copy_checked(ref, ref_len, out->ref, sizeof(out->ref));
    }

    if (rc != B8G_GIT_FORGE_OK) {
        memset(out, 0, sizeof(*out));
        return rc;
    }

    return B8G_GIT_FORGE_OK;
}

static int is_lower_hex(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

B8G_GIT_FORGE_API int b8g_git_forge_v11_blob_path(
    const char* cas_root,
    const char* sha512_hex,
    int is_exec,
    char* out_buf,
    size_t out_cap
) {
    if (cas_root == NULL || sha512_hex == NULL || out_buf == NULL || out_cap == 0u) {
        return B8G_GIT_FORGE_ERR_NULL;
    }

    out_buf[0] = '\0';

    size_t root_len = strlen(cas_root);
    if (root_len == 0u) {
        return B8G_GIT_FORGE_ERR_SYNTAX;
    }
    while (root_len > 1u &&
           (cas_root[root_len - 1u] == '/' || cas_root[root_len - 1u] == '\\')) {
        --root_len;
    }

    /* Strictly validate 128-char lowercase hex SHA-512. */
    for (size_t i = 0u; i < 128u; ++i) {
        if (sha512_hex[i] == '\0' || !is_lower_hex(sha512_hex[i])) {
            return B8G_GIT_FORGE_ERR_INVALID_SHA512;
        }
    }
    if (sha512_hex[128u] != '\0') {
        return B8G_GIT_FORGE_ERR_INVALID_SHA512;
    }

    const char* suffix = (is_exec != 0) ? "-exec" : "";
    const char* sep = (root_len == 1u && (cas_root[0] == '/' || cas_root[0] == '\\'))
        ? ""
        : "/";

    int written = snprintf(
        out_buf,
        out_cap,
        "%.*s%sv11/files/%.2s/%s%s",
        (int)root_len,
        cas_root,
        sep,
        sha512_hex,
        sha512_hex,
        suffix
    );
    if (written < 0 || (size_t)written >= out_cap) {
        out_buf[0] = '\0';
        return B8G_GIT_FORGE_ERR_OVERFLOW;
    }

    return B8G_GIT_FORGE_OK;
}
