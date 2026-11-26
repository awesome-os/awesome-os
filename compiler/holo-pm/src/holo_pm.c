#include "libholo_pm.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char* detect_os(void) {
#if defined(_WIN32)
    return "windows";
#elif defined(__APPLE__)
    return "macos";
#elif defined(__linux__)
    return "linux";
#else
    return "unknown";
#endif
}

static const char* detect_arch(void) {
#if defined(__x86_64__) || defined(_M_X64)
    return "x86_64";
#elif defined(__aarch64__) || defined(_M_ARM64)
    return "aarch64";
#else
    return "unknown";
#endif
}

static void print_json_escaped(const char* s) {
    putchar('"');
    for (; s != NULL && *s != '\0'; ++s) {
        unsigned char c = (unsigned char)*s;
        if (c == '"') {
            fputs("\\\"", stdout);
        } else if (c == '\\') {
            fputs("\\\\", stdout);
        } else if (c == '\n') {
            fputs("\\n", stdout);
        } else if (c == '\r') {
            fputs("\\r", stdout);
        } else if (c == '\t') {
            fputs("\\t", stdout);
        } else {
            putchar((int)c);
        }
    }
    putchar('"');
}

static int cmd_info(void) {
    char v11_root[4096];
    if (b8g_holo_pm_resolve_v11_root(v11_root, sizeof(v11_root)) < 0) {
        v11_root[0] = '\0';
    }

    printf("{\"abiMagic\":\"0x%08" PRIX32 "\",\"version\":", b8g_holo_pm_abi_magic());
    print_json_escaped(b8g_holo_pm_version());
    fputs(",\"casV11Root\":", stdout);
    print_json_escaped(v11_root);
    fputs(",\"os\":", stdout);
    print_json_escaped(detect_os());
    fputs(",\"arch\":", stdout);
    print_json_escaped(detect_arch());
    fputs("}\n", stdout);
    return 0;
}

static int cmd_probe(const char* lib_path, const char* magic_sym) {
    uint32_t magic = 0u;
    int32_t rc = b8g_holo_pm_probe_lib(lib_path, magic_sym, &magic);

    fputs("{\"ok\":", stdout);
    fputs(rc == 0 ? "true" : "false", stdout);
    fputs(",\"path\":", stdout);
    print_json_escaped(lib_path);
    fputs(",\"symbol\":", stdout);
    print_json_escaped(magic_sym);
    printf(",\"abiMagic\":\"0x%08" PRIX32 "\",\"code\":%" PRId32 "}\n", magic, rc);

    return (rc == 0) ? 0 : 1;
}

static void print_usage(FILE* out) {
    fprintf(
        out,
        "holo-pm %s (B8G ABI v3 0x%08" PRIX32 ")\n"
        "Usage:\n"
        "  holo-pm --info\n"
        "  holo-pm --probe <lib-path> <magic-symbol>\n"
        "  holo-pm --version\n",
        b8g_holo_pm_version(),
        b8g_holo_pm_abi_magic()
    );
}

int main(int argc, char** argv) {
    if (argc < 2) {
        return cmd_info();
    }

    if (strcmp(argv[1], "--info") == 0) {
        return cmd_info();
    }

    if (strcmp(argv[1], "--version") == 0) {
        printf("%s\n", b8g_holo_pm_version());
        return 0;
    }

    if (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0) {
        print_usage(stdout);
        return 0;
    }

    if (strcmp(argv[1], "--probe") == 0) {
        if (argc < 4) {
            fprintf(stderr, "error: --probe requires <lib-path> <magic-symbol>\n");
            return 2;
        }
        return cmd_probe(argv[2], argv[3]);
    }

    fprintf(stderr, "error: unknown option '%s'\n", argv[1]);
    print_usage(stderr);
    return 2;
}
