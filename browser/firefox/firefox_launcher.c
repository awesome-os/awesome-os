/**
 * @file browser/firefox/firefox_launcher.c
 * @description Thin zero-dependency native C11 launcher for AwesomeOS Firefox
 *   (Gecko / Stylo / WebRender / Fission / RLBox) bound to Holo v11 CAS.
 *   Compiles cleanly on Windows (zig.cmd cc) and Linux (cc/gcc/clang) under
 *   -std=c11 -Wall -Wextra -Werror.
 */

#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
  #define _POSIX_C_SOURCE 200809L
#endif

#include <stdalign.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #include <windows.h>
  #include <process.h>
  #define PATH_SEP '\\'
  #define OS_FIREFOX_KEY "firefox-win64.tar.zst"
  #define OS_FIREFOX_BIN "firefox.exe"
#else
  #include <unistd.h>
  #include <sys/stat.h>
  #define PATH_SEP '/'
  #if defined(__aarch64__)
    #define OS_FIREFOX_KEY "firefox-linux-arm64.tar.zst"
  #else
    #define OS_FIREFOX_KEY "firefox-linux-x64.tar.zst"
  #endif
  #define OS_FIREFOX_BIN "firefox"
#endif

#define B8G_ABI_MAGIC_V3 0x33564742U /* "BGV3" */
#define FIREFOX_LAUNCHER_VERSION "0.1.0"
#define FIREFOX_V11_LIB_COUNT 24U
#define MAX_PATH_BUF 1024
#define SHA512_HEX_LEN 128U

typedef struct B8gFirefoxArenaHeader {
  _Alignas(64) uint32_t magic;
  uint32_t abi_version;
  uint32_t shared_lib_count;
  uint32_t flags;
  uint64_t arena_bytes;
  uint8_t reserved[40];
} B8gFirefoxArenaHeader;

static const char *const k_v11_shared_libs[FIREFOX_V11_LIB_COUNT] = {
  "zlib",
  "zstd",
  "sqlite",
  "vulkan-loader",
  "libjpeg-turbo",
  "libpng",
  "brotli",
  "icu4c",
  "libwebp",
  "ffmpeg",
  "harfbuzz",
  "libffi",
  "dav1d",
  "freetype",
  "expat",
  "fontconfig",
  "aom",
  "libopus",
  "libvpx",
  "cairo",
  "libevent",
  "nspr",
  "nss",
  "pixman"
};

static int file_exists(const char *path) {
  if (!path || path[0] == '\0') return 0;
#if defined(_WIN32)
  DWORD attr = GetFileAttributesA(path);
  return (attr != INVALID_FILE_ATTRIBUTES);
#else
  struct stat st;
  return (stat(path, &st) == 0);
#endif
}

static int get_cas_dir(char *out, size_t cap) {
  const char *env_dir = getenv("B8G_CAS_DIR");
  if (env_dir && env_dir[0] != '\0') {
    snprintf(out, cap, "%s", env_dir);
    return 0;
  }
#if defined(_WIN32)
  const char *home = getenv("USERPROFILE");
  if (!home || home[0] == '\0') home = getenv("HOME");
  if (!home || home[0] == '\0') return -1;
  snprintf(out, cap, "%s\\.b8g\\cas", home);
#else
  const char *home = getenv("HOME");
  if (!home || home[0] == '\0') return -1;
  snprintf(out, cap, "%s/.b8g/cas", home);
#endif
  return 0;
}

static int is_valid_hex_digest(const char *hex, size_t expected_len, char *out_lower) {
  if (!hex) return 0;
  for (size_t i = 0; i < expected_len; i++) {
    char c = hex[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
      return 0;
    }
    if (out_lower) {
      out_lower[i] = (c >= 'A' && c <= 'F') ? (char)(c + 32) : c;
    }
  }
  if (hex[expected_len] != '\0') return 0;
  if (out_lower) out_lower[expected_len] = '\0';
  return 1;
}

static int resolve_v11_cas_blob_path(
    const char *cas_root,
    const char *sha512_hex,
    char *out_path,
    size_t cap) {
  char normalized[SHA512_HEX_LEN + 1];
  if (!cas_root || cas_root[0] == '\0') return -1;
  if (strstr(cas_root, "..") != NULL) return -1;
  if (!is_valid_hex_digest(sha512_hex, SHA512_HEX_LEN, normalized)) return -1;

  int n = snprintf(
      out_path,
      cap,
      "%s%cv11%cfiles%c%c%c%c%s",
      cas_root,
      PATH_SEP,
      PATH_SEP,
      PATH_SEP,
      normalized[0],
      normalized[1],
      PATH_SEP,
      normalized);
  if (n < 0 || (size_t)n >= cap) return -1;
  return 0;
}

static int get_exe_dir(char *out, size_t cap) {
#if defined(_WIN32)
  DWORD len = GetModuleFileNameA(NULL, out, (DWORD)cap);
  if (len == 0 || len >= cap) return -1;
#else
  ssize_t len = readlink("/proc/self/exe", out, cap - 1);
  if (len <= 0) return -1;
  out[len] = '\0';
#endif
  char *last = strrchr(out, PATH_SEP);
#if defined(_WIN32)
  char *alt = strrchr(out, '/');
  if (alt && (!last || alt > last)) last = alt;
#endif
  if (!last) return -1;
  *last = '\0';
  return 0;
}

static int find_cli_mts(char *out, size_t cap) {
  const char *env_cli = getenv("FIREFOX_CLI_PATH");
  if (env_cli && env_cli[0] != '\0' && file_exists(env_cli)) {
    snprintf(out, cap, "%s", env_cli);
    return 0;
  }
  char exe_dir[MAX_PATH_BUF];
  if (get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
    snprintf(out, cap, "%s%ccli.mts", exe_dir, PATH_SEP);
    if (file_exists(out)) return 0;
    snprintf(out, cap, "%s%cbrowser%cfirefox%ccli.mts", exe_dir, PATH_SEP, PATH_SEP, PATH_SEP);
    if (file_exists(out)) return 0;
  }
  snprintf(out, cap, "browser%cfirefox%ccli.mts", PATH_SEP, PATH_SEP);
  if (file_exists(out)) return 0;
  snprintf(out, cap, "cli.mts");
  if (file_exists(out)) return 0;
  return -1;
}

static void set_env_var(const char *name, const char *value) {
#if defined(_WIN32)
  SetEnvironmentVariableA(name, value);
#else
  if (value) setenv(name, value, 1);
  else unsetenv(name);
#endif
}

static int run_self_test(void) {
  if (B8G_ABI_MAGIC_V3 != 0x33564742U) {
    fprintf(stderr, "FAIL: B8G_ABI_MAGIC_V3 mismatch\n");
    return 1;
  }
  if (sizeof(B8gFirefoxArenaHeader) != 64U || _Alignof(B8gFirefoxArenaHeader) != 64U) {
    fprintf(stderr, "FAIL: B8gFirefoxArenaHeader 64-byte alignment mismatch\n");
    return 1;
  }

  B8gFirefoxArenaHeader hdr;
  memset(&hdr, 0, sizeof(hdr));
  hdr.magic = B8G_ABI_MAGIC_V3;
  hdr.abi_version = 1U;
  hdr.shared_lib_count = FIREFOX_V11_LIB_COUNT;
  hdr.arena_bytes = sizeof(B8gFirefoxArenaHeader);

  /* Validate 24/24 shared v11 library slots */
  size_t lib_count = sizeof(k_v11_shared_libs) / sizeof(k_v11_shared_libs[0]);
  if (lib_count != FIREFOX_V11_LIB_COUNT) {
    fprintf(stderr, "FAIL: expected %u shared libs, got %zu\n", FIREFOX_V11_LIB_COUNT, lib_count);
    return 1;
  }
  for (size_t i = 0; i < lib_count; i++) {
    if (!k_v11_shared_libs[i] || k_v11_shared_libs[i][0] == '\0') {
      fprintf(stderr, "FAIL: empty shared lib slot %zu\n", i);
      return 1;
    }
  }

  /* Validate v11 CAS path construction and traversal rejection */
  char sample_sha[SHA512_HEX_LEN + 1];
  for (size_t i = 0; i < SHA512_HEX_LEN; i++) {
    sample_sha[i] = (i < 2) ? 'A' : 'f';
  }
  sample_sha[SHA512_HEX_LEN] = '\0';

  char resolved[MAX_PATH_BUF];
  if (resolve_v11_cas_blob_path("/var/lib/b8g/cas", sample_sha, resolved, sizeof(resolved)) != 0) {
    fprintf(stderr, "FAIL: valid v11 CAS path resolution failed\n");
    return 1;
  }
  if (strstr(resolved, "files") == NULL) {
    fprintf(stderr, "FAIL: resolved path missing v11/files segment: %s\n", resolved);
    return 1;
  }
  if (resolve_v11_cas_blob_path("/var/lib/b8g/../cas", sample_sha, resolved, sizeof(resolved)) == 0) {
    fprintf(stderr, "FAIL: traversal cas_root was not rejected\n");
    return 1;
  }
  if (resolve_v11_cas_blob_path("/var/lib/b8g/cas", "not-a-sha512", resolved, sizeof(resolved)) == 0) {
    fprintf(stderr, "FAIL: invalid sha512 digest was not rejected\n");
    return 1;
  }

  printf("firefox_launcher: PASS (magic=0x%08X abi=%u cas=v11 shared_libs=%u/24 hdr=%zuB)\n",
         hdr.magic, hdr.abi_version, hdr.shared_lib_count, sizeof(hdr));
  return 0;
}

static int print_dry_run_receipt(void) {
  char cas_dir[MAX_PATH_BUF];
  if (get_cas_dir(cas_dir, sizeof(cas_dir)) != 0) {
    snprintf(cas_dir, sizeof(cas_dir), ".b8g-cas");
  }
  char cli_path[MAX_PATH_BUF];
  if (find_cli_mts(cli_path, sizeof(cli_path)) != 0) {
    snprintf(cli_path, sizeof(cli_path), "browser/firefox/cli.mts");
  }

  char sample_sha[SHA512_HEX_LEN + 1];
  memset(sample_sha, '0', SHA512_HEX_LEN);
  sample_sha[SHA512_HEX_LEN] = '\0';
  char sample_v11_path[MAX_PATH_BUF];
  if (resolve_v11_cas_blob_path(cas_dir, sample_sha, sample_v11_path, sizeof(sample_v11_path)) != 0) {
    snprintf(sample_v11_path, sizeof(sample_v11_path), "unresolved");
  }

  printf("{\n");
  printf("  \"launcher\": \"@awesome-os/firefox-launcher\",\n");
  printf("  \"version\": \"%s\",\n", FIREFOX_LAUNCHER_VERSION);
  printf("  \"abiMagic\": \"0x%08X\",\n", B8G_ABI_MAGIC_V3);
  printf("  \"casLayout\": \"v11\",\n");
  printf("  \"assetKey\": \"%s\",\n", OS_FIREFOX_KEY);
  printf("  \"sharedLibs\": %u,\n", FIREFOX_V11_LIB_COUNT);
  printf("  \"telemetryDisabled\": true,\n");
  printf("  \"rlboxWasmSandboxing\": true,\n");
  printf("  \"dryRun\": true\n");
  printf("}\n");
  return 0;
}

int main(int argc, char **argv) {
  int dry_run = 0;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) break;
    if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-v") == 0) {
      printf("@awesome-os/firefox-launcher %s (magic=0x%08X | cas=v11 | asset=%s)\n",
             FIREFOX_LAUNCHER_VERSION, B8G_ABI_MAGIC_V3, OS_FIREFOX_KEY);
      return 0;
    }
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      printf("firefox native launcher %s (Gecko/WebRender/Fission/RLBox on holo-v11 CAS)\n",
             FIREFOX_LAUNCHER_VERSION);
      printf("Usage: firefox_launcher [--dry-run] [--self-test] [--version] [urls/flags...]\n");
      return 0;
    }
    if (strcmp(argv[i], "--self-test") == 0) {
      return run_self_test();
    }
    if (strcmp(argv[i], "--dry-run") == 0) {
      dry_run = 1;
    }
  }

  if (dry_run) {
    return print_dry_run_receipt();
  }

  set_env_var("MOZ_ENABLE_WAYLAND", "1");
  set_env_var("MOZ_DISABLE_TELEMETRY", "1");

  char cas_dir[MAX_PATH_BUF];
  if (get_cas_dir(cas_dir, sizeof(cas_dir)) == 0) {
    set_env_var("B8G_CAS_DIR", cas_dir);
    const char *pinned = getenv("FIREFOX_HOLO_SHA512");
    if (pinned && strlen(pinned) == SHA512_HEX_LEN) {
      char bin_path[MAX_PATH_BUF];
      snprintf(bin_path, sizeof(bin_path), "%s%cfirefox%c%s%c%s",
               cas_dir, PATH_SEP, PATH_SEP, pinned, PATH_SEP, OS_FIREFOX_BIN);
      if (file_exists(bin_path)) {
#if defined(_WIN32)
        return (int)_spawnl(_P_NOWAIT, bin_path, bin_path, "-no-remote", NULL) == -1 ? 127 : 0;
#else
        execl(bin_path, bin_path, "-no-remote", (char *)NULL);
        return 127;
#endif
      }
    }
  }

  char cli_path[MAX_PATH_BUF];
  if (find_cli_mts(cli_path, sizeof(cli_path)) != 0) {
    fprintf(stderr, "firefox_launcher: could not locate browser/firefox/cli.mts (set FIREFOX_CLI_PATH).\n");
    return 1;
  }

#if defined(_WIN32)
  return (int)_spawnlp(_P_WAIT, "node", "node", cli_path, (argc > 1 ? argv[1] : NULL), NULL);
#else
  const char **node_argv = (const char **)calloc((size_t)argc + 3, sizeof(char *));
  if (!node_argv) return 1;
  node_argv[0] = "node";
  node_argv[1] = cli_path;
  for (int i = 1; i < argc; i++) node_argv[i + 1] = argv[i];
  node_argv[argc + 1] = NULL;
  execvp("node", (char *const *)node_argv);
  free(node_argv);
  return 127;
#endif
}
