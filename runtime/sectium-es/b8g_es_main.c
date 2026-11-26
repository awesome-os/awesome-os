#include "b8g_es.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *read_file_all(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    return buf;
}

static void print_usage(void) {
    fprintf(stderr,
            "Usage:\n"
            "  sectium-es -v | --version\n"
            "  sectium-es -e \"<code>\"\n"
            "  sectium-es --bench\n"
            "  sectium-es <script.js>\n");
}

static const char *BENCH_SCRIPT =
    "function fib(n) {\n"
    "  if (n <= 1) return n;\n"
    "  return fib(n - 1) + fib(n - 2);\n"
    "}\n"
    "let t0 = sys.clockNs();\n"
    "let sum = 0;\n"
    "for (let i = 0; i < 100000; i++) {\n"
    "  sum += (i & 7);\n"
    "}\n"
    "let f20 = fib(20);\n"
    "let t1 = sys.clockNs();\n"
    "let ms = (t1 - t0) / 1000000;\n"
    "console.log(\"bench loop100k+fib(20):\", \"sum=\" + sum, \"fib(20)=\" + f20, \"elapsed_ms=\" + ms);\n";

int main(int argc, char **argv) {
    if (argc < 2) {
        print_usage();
        return 1;
    }

    if (strcmp(argv[1], "-v") == 0 || strcmp(argv[1], "--version") == 0) {
        printf("sectium-es v%s (c11-zero-v8, dup_v8=0 B)\n", B8G_ES_VERSION);
        return 0;
    }

    B8gEsVm *vm = b8g_es_create();
    if (!vm) {
        fprintf(stderr, "sectium-es: failed to allocate VM\n");
        return 1;
    }

    char out[4096];
    out[0] = '\0';
    int rc = 0;

    if (strcmp(argv[1], "-e") == 0) {
        if (argc < 3) {
            fprintf(stderr, "sectium-es: -e requires a code string\n");
            b8g_es_destroy(vm);
            return 1;
        }
        rc = b8g_es_eval(vm, argv[2], "<eval>", out, sizeof(out));
        if (rc != 0) {
            fprintf(stderr, "Error: %s\n", b8g_es_last_error(vm));
        } else if (!b8g_es_did_print(vm) && out[0] != '\0') {
            printf("%s\n", out);
        }
    } else if (strcmp(argv[1], "--bench") == 0) {
        rc = b8g_es_eval(vm, BENCH_SCRIPT, "<bench>", out, sizeof(out));
        if (rc != 0) {
            fprintf(stderr, "Error: %s\n", b8g_es_last_error(vm));
        }
    } else {
        char *src = read_file_all(argv[1]);
        if (!src) {
            fprintf(stderr, "sectium-es: cannot read file '%s'\n", argv[1]);
            b8g_es_destroy(vm);
            return 1;
        }
        rc = b8g_es_eval(vm, src, argv[1], out, sizeof(out));
        free(src);
        if (rc != 0) {
            fprintf(stderr, "Error: %s\n", b8g_es_last_error(vm));
        }
    }

    b8g_es_destroy(vm);
    return rc == 0 ? 0 : 1;
}
