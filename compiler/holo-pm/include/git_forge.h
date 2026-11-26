#ifndef B8G_GIT_FORGE_H
#define B8G_GIT_FORGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) || defined(__CYGWIN__)
#  if defined(B8G_HOLO_PM_BUILDING_DLL)
#    define B8G_GIT_FORGE_API __declspec(dllexport)
#  elif defined(B8G_HOLO_PM_USE_DLL)
#    define B8G_GIT_FORGE_API __declspec(dllimport)
#  else
#    define B8G_GIT_FORGE_API
#  endif
#else
#  define B8G_GIT_FORGE_API __attribute__((visibility("default")))
#endif

/** Canonical B8G ABI v3 magic ("BGV3" = 0x33564742). */
#define B8G_GIT_FORGE_ABI_MAGIC_V3 0x33564742u

/** Fixed-size buffer capacities for zero-allocation URI parsing. */
#define B8G_GIT_FORGE_HOST_MAX    256u
#define B8G_GIT_FORGE_ORG_MAX     128u
#define B8G_GIT_FORGE_REPO_MAX    128u
#define B8G_GIT_FORGE_REF_MAX     128u
#define B8G_GIT_FORGE_SUBPATH_MAX 512u
#define B8G_GIT_FORGE_HOOK_MAX     64u
#define B8G_GIT_FORGE_TARGET_MAX   64u

/** Error codes returned by git-forge C ABI functions. */
enum b8g_git_forge_status {
    B8G_GIT_FORGE_OK                 =  0,
    B8G_GIT_FORGE_ERR_NULL           = -1,
    B8G_GIT_FORGE_ERR_SCHEME         = -2,
    B8G_GIT_FORGE_ERR_SYNTAX         = -3,
    B8G_GIT_FORGE_ERR_MISSING_REF    = -4,
    B8G_GIT_FORGE_ERR_TRAVERSAL      = -5,
    B8G_GIT_FORGE_ERR_LOCALHOST      = -6, /* B8G016: local HTTP/loopback prohibited */
    B8G_GIT_FORGE_ERR_OVERFLOW       = -7,
    B8G_GIT_FORGE_ERR_INVALID_SHA512 = -8
};

/**
 * Parsed `git-forge://` URI components in fixed-size NUL-terminated buffers.
 * Zero heap allocation.
 */
typedef struct b8g_git_forge_uri {
    char host[B8G_GIT_FORGE_HOST_MAX];
    char org[B8G_GIT_FORGE_ORG_MAX];
    char repo[B8G_GIT_FORGE_REPO_MAX];
    char ref[B8G_GIT_FORGE_REF_MAX];
    char subpath[B8G_GIT_FORGE_SUBPATH_MAX];
    char hook[B8G_GIT_FORGE_HOOK_MAX];
    char target[B8G_GIT_FORGE_TARGET_MAX];
} b8g_git_forge_uri_t;

/**
 * Returns the canonical B8G ABI v3 magic constant (0x33564742u).
 */
B8G_GIT_FORGE_API uint32_t b8g_git_forge_abi_magic(void);

/** Canonical primary URI scheme and legacy alias. */
#define B8G_REPOSITORY_SCHEME      "repository://"
#define B8G_GIT_FORGE_SCHEME_ALIAS "git-forge://"

/**
 * Parses a `repository://<host>/<org>/<repo>@<ref>[#<subpath>][?hook=<h>&target=<t>]`
 * URI (or legacy `git-forge://` alias) into `out` without any heap allocation.
 *
 * Returns `0` (`B8G_GIT_FORGE_OK`) on success, or a negative error code from
 * `enum b8g_git_forge_status` on failure (invalid scheme, missing `@ref`,
 * `..` path traversal, `127.0.0.1`/`localhost` B8G016 violation, or buffer overflow).
 */
B8G_GIT_FORGE_API int b8g_git_forge_parse_uri(
    const char* uri,
    b8g_git_forge_uri_t* out
);

/** Canonical alias for `b8g_git_forge_parse_uri`. */
#define b8g_repository_parse_uri(uri, out) b8g_git_forge_parse_uri((uri), (out))

/**
 * Validates a 128-character lowercase hex SHA-512 digest and formats the
 * unified CAS v11 blob path:
 *   `<cas_root>/v11/files/<xx>/<sha512>`       (when `is_exec == 0`)
 *   `<cas_root>/v11/files/<xx>/<sha512>-exec`  (when `is_exec != 0`)
 *
 * Returns `0` (`B8G_GIT_FORGE_OK`) on success, or a negative error code on failure.
 */
B8G_GIT_FORGE_API int b8g_git_forge_v11_blob_path(
    const char* cas_root,
    const char* sha512_hex,
    int is_exec,
    char* out_buf,
    size_t out_cap
);

#ifdef __cplusplus
}
#endif

#endif /* B8G_GIT_FORGE_H */
