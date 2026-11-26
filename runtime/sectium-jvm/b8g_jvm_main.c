#include "b8g_jvm.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Embedded real JVM .class binary (0xCAFEBABE, Java 8 / major 52) for --bench:
 *   class Bench {
 *     public static int fib(int n) {
 *       return n < 2 ? n : fib(n - 1) + fib(n - 2);
 *     }
 *     public static long sumLoop(int n) {
 *       long s = 0;
 *       for (int i = 1; i <= n; i++) s += i;
 *       return s;
 *     }
 *     public static void main(String[] args) {
 *       System.out.println(fib(25));
 *       System.out.println(sumLoop(100000));
 *     }
 *   }
 */
static const uint8_t BENCH_CLASS[] = {
  /* Magic: 0xCAFEBABE, minor=0, major=52 (0x0034) */
  0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x00, 0x00, 0x34,
  /* constant_pool_count = 32 (entries #1..#31) */
  0x00, 0x20,

  /* #1 Utf8 "Bench" (len 5) */
  0x01, 0x00, 0x05, 'B', 'e', 'n', 'c', 'h',
  /* #2 Class #1 */
  0x07, 0x00, 0x01,
  /* #3 Utf8 "java/lang/Object" (len 16) */
  0x01, 0x00, 0x10,
  'j', 'a', 'v', 'a', '/', 'l', 'a', 'n', 'g', '/', 'O', 'b', 'j', 'e', 'c', 't',
  /* #4 Class #3 */
  0x07, 0x00, 0x03,
  /* #5 Utf8 "Code" (len 4) */
  0x01, 0x00, 0x04, 'C', 'o', 'd', 'e',
  /* #6 Utf8 "fib" (len 3) */
  0x01, 0x00, 0x03, 'f', 'i', 'b',
  /* #7 Utf8 "(I)I" (len 4) */
  0x01, 0x00, 0x04, '(', 'I', ')', 'I',
  /* #8 NameAndType #6:#7 */
  0x0C, 0x00, 0x06, 0x00, 0x07,
  /* #9 Methodref #2.#8 (Bench.fib:(I)I) */
  0x0A, 0x00, 0x02, 0x00, 0x08,
  /* #10 Utf8 "sumLoop" (len 7) */
  0x01, 0x00, 0x07, 's', 'u', 'm', 'L', 'o', 'o', 'p',
  /* #11 Utf8 "(I)J" (len 4) */
  0x01, 0x00, 0x04, '(', 'I', ')', 'J',
  /* #12 NameAndType #10:#11 */
  0x0C, 0x00, 0x0A, 0x00, 0x0B,
  /* #13 Methodref #2.#12 (Bench.sumLoop:(I)J) */
  0x0A, 0x00, 0x02, 0x00, 0x0C,
  /* #14 Utf8 "main" (len 4) */
  0x01, 0x00, 0x04, 'm', 'a', 'i', 'n',
  /* #15 Utf8 "([Ljava/lang/String;)V" (len 22) */
  0x01, 0x00, 0x16,
  '(', '[', 'L', 'j', 'a', 'v', 'a', '/', 'l', 'a', 'n', 'g', '/',
  'S', 't', 'r', 'i', 'n', 'g', ';', ')', 'V',
  /* #16 Utf8 "java/lang/System" (len 16) */
  0x01, 0x00, 0x10,
  'j', 'a', 'v', 'a', '/', 'l', 'a', 'n', 'g', '/', 'S', 'y', 's', 't', 'e', 'm',
  /* #17 Class #16 */
  0x07, 0x00, 0x10,
  /* #18 Utf8 "out" (len 3) */
  0x01, 0x00, 0x03, 'o', 'u', 't',
  /* #19 Utf8 "Ljava/io/PrintStream;" (len 21) */
  0x01, 0x00, 0x15,
  'L', 'j', 'a', 'v', 'a', '/', 'i', 'o', '/', 'P', 'r', 'i', 'n', 't',
  'S', 't', 'r', 'e', 'a', 'm', ';',
  /* #20 NameAndType #18:#19 */
  0x0C, 0x00, 0x12, 0x00, 0x13,
  /* #21 Fieldref #17.#20 (System.out) */
  0x09, 0x00, 0x11, 0x00, 0x14,
  /* #22 Utf8 "java/io/PrintStream" (len 19) */
  0x01, 0x00, 0x13,
  'j', 'a', 'v', 'a', '/', 'i', 'o', '/', 'P', 'r', 'i', 'n', 't',
  'S', 't', 'r', 'e', 'a', 'm',
  /* #23 Class #22 */
  0x07, 0x00, 0x16,
  /* #24 Utf8 "println" (len 7) */
  0x01, 0x00, 0x07, 'p', 'r', 'i', 'n', 't', 'l', 'n',
  /* #25 Utf8 "(I)V" (len 4) */
  0x01, 0x00, 0x04, '(', 'I', ')', 'V',
  /* #26 NameAndType #24:#25 */
  0x0C, 0x00, 0x18, 0x00, 0x19,
  /* #27 Methodref #23.#26 (PrintStream.println:(I)V) */
  0x0A, 0x00, 0x17, 0x00, 0x1A,
  /* #28 Utf8 "(J)V" (len 4) */
  0x01, 0x00, 0x04, '(', 'J', ')', 'V',
  /* #29 NameAndType #24:#28 */
  0x0C, 0x00, 0x18, 0x00, 0x1C,
  /* #30 Methodref #23.#29 (PrintStream.println:(J)V) */
  0x0A, 0x00, 0x17, 0x00, 0x1D,
  /* #31 Integer 100000 (0x000186A0) */
  0x03, 0x00, 0x01, 0x86, 0xA0,

  /* access_flags=PUBLIC|SUPER (0x0021), this=#2, super=#4 */
  0x00, 0x21, 0x00, 0x02, 0x00, 0x04,
  /* interfaces_count=0, fields_count=0 */
  0x00, 0x00, 0x00, 0x00,
  /* methods_count = 3 */
  0x00, 0x03,

  /* Method 0: public static int fib(int) */
  0x00, 0x09, 0x00, 0x06, 0x00, 0x07, 0x00, 0x01,
  /* Code attr: name=#5, len=12+21=33 (0x21), max_stack=4, max_locals=1, code_len=21 */
  0x00, 0x05, 0x00, 0x00, 0x00, 0x21,
  0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x15,
  0x1A,             /* 0: iload_0 */
  0x05,             /* 1: iconst_2 */
  0xA2, 0x00, 0x05, /* 2: if_icmpge +5 -> 7 */
  0x1A,             /* 5: iload_0 */
  0xAC,             /* 6: ireturn */
  0x1A,             /* 7: iload_0 */
  0x04,             /* 8: iconst_1 */
  0x64,             /* 9: isub */
  0xB8, 0x00, 0x09, /* 10: invokestatic #9 (fib) */
  0x1A,             /* 13: iload_0 */
  0x05,             /* 14: iconst_2 */
  0x64,             /* 15: isub */
  0xB8, 0x00, 0x09, /* 16: invokestatic #9 (fib) */
  0x60,             /* 19: iadd */
  0xAC,             /* 20: ireturn */
  0x00, 0x00,       /* exception_table_length=0 */
  0x00, 0x00,       /* code attributes_count=0 */

  /* Method 1: public static long sumLoop(int) */
  0x00, 0x09, 0x00, 0x0A, 0x00, 0x0B, 0x00, 0x01,
  /* Code attr: name=#5, len=12+22=34 (0x22), max_stack=4, max_locals=4, code_len=22 */
  0x00, 0x05, 0x00, 0x00, 0x00, 0x22,
  0x00, 0x04, 0x00, 0x04, 0x00, 0x00, 0x00, 0x16,
  0x09,             /* 0: lconst_0 */
  0x40,             /* 1: lstore_1 */
  0x04,             /* 2: iconst_1 */
  0x3E,             /* 3: istore_3 */
  0x1D,             /* 4: iload_3 */
  0x1A,             /* 5: iload_0 */
  0xA3, 0x00, 0x0E, /* 6: if_icmpgt +14 -> 20 */
  0x1F,             /* 9: lload_1 */
  0x1D,             /* 10: iload_3 */
  0x85,             /* 11: i2l */
  0x61,             /* 12: ladd */
  0x40,             /* 13: lstore_1 */
  0x84, 0x03, 0x01, /* 14: iinc 3, 1 */
  0xA7, 0xFF, 0xF3, /* 17: goto -13 -> 4 */
  0x1F,             /* 20: lload_1 */
  0xAD,             /* 21: lreturn */
  0x00, 0x00,
  0x00, 0x00,

  /* Method 2: public static void main(String[]) */
  0x00, 0x09, 0x00, 0x0E, 0x00, 0x0F, 0x00, 0x01,
  /* Code attr: name=#5, len=12+23=35 (0x23), max_stack=3, max_locals=1, code_len=23 */
  0x00, 0x05, 0x00, 0x00, 0x00, 0x23,
  0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x17,
  0xB2, 0x00, 0x15, /* 0: getstatic #21 (System.out) */
  0x10, 0x19,       /* 3: bipush 25 */
  0xB8, 0x00, 0x09, /* 5: invokestatic #9 (fib) */
  0xB6, 0x00, 0x1B, /* 8: invokevirtual #27 (println(I)V) */
  0xB2, 0x00, 0x15, /* 11: getstatic #21 (System.out) */
  0x12, 0x1F,       /* 14: ldc #31 (100000) */
  0xB8, 0x00, 0x0D, /* 16: invokestatic #13 (sumLoop) */
  0xB6, 0x00, 0x1E, /* 19: invokevirtual #30 (println(J)V) */
  0xB1,             /* 22: return */
  0x00, 0x00,
  0x00, 0x00,

  /* class attributes_count = 0 */
  0x00, 0x00
};

static uint8_t *read_entire_file(const char *path, size_t *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  long sz = ftell(f);
  if (sz < 0) {
    fclose(f);
    return NULL;
  }
  rewind(f);
  uint8_t *buf = (uint8_t *)malloc((size_t)sz > 0 ? (size_t)sz : 1);
  if (!buf) {
    fclose(f);
    return NULL;
  }
  size_t got = fread(buf, 1, (size_t)sz, f);
  fclose(f);
  if (got != (size_t)sz) {
    free(buf);
    return NULL;
  }
  *out_len = got;
  return buf;
}

static int run_bench(void) {
  b8g_jvm_class_t cls;
  char err[256] = {0};
  if (b8g_jvm_parse_class(BENCH_CLASS, sizeof(BENCH_CLASS), &cls, err,
                          sizeof(err)) != 0) {
    fprintf(stderr, "bench parse error: %s\n", err);
    return 1;
  }

  b8g_jvm_vm_t vm;
  b8g_jvm_vm_init(&vm, &cls);

  const b8g_method_t *m_fib = b8g_jvm_find_method(&cls, "fib", "(I)I");
  const b8g_method_t *m_sum = b8g_jvm_find_method(&cls, "sumLoop", "(I)J");
  if (!m_fib || !m_sum) {
    fprintf(stderr, "bench missing methods\n");
    b8g_jvm_vm_free(&vm);
    b8g_jvm_free_class(&cls);
    return 1;
  }

  b8g_val_t arg, ret;
  arg.i64 = 0;
  arg.i32 = 25;
  ret.i64 = 0;
  int64_t t0 = b8g_jvm_nanotime();
  if (b8g_jvm_exec_method(&vm, m_fib, &arg, 1, &ret) != 0) {
    fprintf(stderr, "bench fib error: %s\n", vm.err);
    b8g_jvm_vm_free(&vm);
    b8g_jvm_free_class(&cls);
    return 1;
  }
  int64_t t1 = b8g_jvm_nanotime();
  int32_t fib_res = ret.i32;
  double fib_ms = (double)(t1 - t0) / 1e6;

  arg.i64 = 0;
  arg.i32 = 100000;
  ret.i64 = 0;
  int64_t t2 = b8g_jvm_nanotime();
  if (b8g_jvm_exec_method(&vm, m_sum, &arg, 1, &ret) != 0) {
    fprintf(stderr, "bench sumLoop error: %s\n", vm.err);
    b8g_jvm_vm_free(&vm);
    b8g_jvm_free_class(&cls);
    return 1;
  }
  int64_t t3 = b8g_jvm_nanotime();
  int64_t sum_res = ret.i64;
  double sum_ms = (double)(t3 - t2) / 1e6;

  printf("sectium-jvm Tier-0 bench (embedded 0xCAFEBABE .class, %zu B)\n",
         sizeof(BENCH_CLASS));
  printf("  fib(25)         = %" PRId32 "  (%.3f ms)\n", fib_res, fib_ms);
  printf("  sumLoop(100000) = %" PRId64 "  (%.3f ms)\n", sum_res, sum_ms);
  printf("  total           = %.3f ms\n", fib_ms + sum_ms);

  b8g_jvm_vm_free(&vm);
  b8g_jvm_free_class(&cls);
  return (fib_res == 75025 && sum_res == 5000050000LL) ? 0 : 1;
}

static void print_usage(void) {
  fprintf(stderr,
          "Usage:\n"
          "  sectium-jvm --version\n"
          "  sectium-jvm --bench\n"
          "  sectium-jvm --run <file.class>\n"
          "  sectium-jvm --emit-c <file.class> [out.c]\n");
}

int main(int argc, char **argv) {
  if (argc < 2) {
    print_usage();
    return 1;
  }

  if (strcmp(argv[1], "--version") == 0) {
    printf("%s\n", B8G_JVM_VERSION_STR);
    return 0;
  }

  if (strcmp(argv[1], "--bench") == 0) {
    return run_bench();
  }

  if (strcmp(argv[1], "--run") == 0) {
    if (argc < 3) {
      fprintf(stderr, "error: --run requires <file.class>\n");
      return 1;
    }
    size_t len = 0;
    uint8_t *data = read_entire_file(argv[2], &len);
    if (!data) {
      fprintf(stderr, "error: cannot read '%s'\n", argv[2]);
      return 1;
    }
    b8g_jvm_class_t cls;
    char err[256] = {0};
    if (b8g_jvm_parse_class(data, len, &cls, err, sizeof(err)) != 0) {
      fprintf(stderr, "parse error: %s\n", err);
      free(data);
      return 1;
    }
    free(data);

    b8g_jvm_vm_t vm;
    b8g_jvm_vm_init(&vm, &cls);
    int rc = b8g_jvm_run_main(&vm);
    if (rc != 0) {
      fprintf(stderr, "runtime error: %s\n", vm.err);
    }
    b8g_jvm_vm_free(&vm);
    b8g_jvm_free_class(&cls);
    return rc == 0 ? 0 : 1;
  }

  if (strcmp(argv[1], "--emit-c") == 0) {
    if (argc < 3) {
      fprintf(stderr, "error: --emit-c requires <file.class> [out.c]\n");
      return 1;
    }
    size_t len = 0;
    uint8_t *data = read_entire_file(argv[2], &len);
    if (!data) {
      fprintf(stderr, "error: cannot read '%s'\n", argv[2]);
      return 1;
    }
    b8g_jvm_class_t cls;
    char err[256] = {0};
    if (b8g_jvm_parse_class(data, len, &cls, err, sizeof(err)) != 0) {
      fprintf(stderr, "parse error: %s\n", err);
      free(data);
      return 1;
    }
    free(data);

    FILE *out = stdout;
    if (argc >= 4) {
      out = fopen(argv[3], "wb");
      if (!out) {
        fprintf(stderr, "error: cannot open '%s' for writing\n", argv[3]);
        b8g_jvm_free_class(&cls);
        return 1;
      }
    }
    int rc = b8g_jvm_emit_c(&cls, out, err, sizeof(err));
    if (out != stdout) fclose(out);
    if (rc != 0) {
      fprintf(stderr, "aot error: %s\n", err);
    }
    b8g_jvm_free_class(&cls);
    return rc == 0 ? 0 : 1;
  }

  print_usage();
  return 1;
}
