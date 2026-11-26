#include "syscall_abi.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char* expected_backend(void) {
#if defined(__linux__) && (defined(__x86_64__) || defined(__aarch64__))
    return "linux-raw-syscall";
#elif defined(_WIN32)
    return "win64-kernel32";
#elif defined(__APPLE__)
    return "macos-libsystem";
#elif defined(__wasi__)
    return "wasi-preview1";
#else
    return "unknown";
#endif
}

int main(void) {
    uint32_t magic = b8g_syscall_abi_magic();
    if (magic != 0x33564742u) {
        fprintf(stderr, "FAIL: magic=0x%08" PRIx32 " expected=0x33564742\n", magic);
        return 1;
    }

    const char* backend = b8g_syscall_backend_name();
    const char* expected = expected_backend();
    if (backend == NULL || strcmp(backend, expected) != 0) {
        fprintf(stderr, "FAIL: backend='%s' expected='%s'\n",
                backend ? backend : "(null)", expected);
        return 2;
    }

    uint64_t pid = b8g_sys_getpid();
    if (pid == 0) {
        fprintf(stderr, "FAIL: b8g_sys_getpid() returned 0\n");
        return 3;
    }

    uint64_t t1 = b8g_sys_monotonic_ns();
    uint64_t t2 = b8g_sys_monotonic_ns();
    if (t1 == 0 || t2 < t1) {
        fprintf(stderr, "FAIL: monotonic_ns invalid t1=%" PRIu64 " t2=%" PRIu64 "\n", t1, t2);
        return 4;
    }

    const char msg[] = "[b8g-syscall-abi] write(1) ok\n";
    size_t msg_len = sizeof(msg) - 1;
    int64_t written = b8g_sys_write(1, msg, msg_len);
    if (written != (int64_t)msg_len) {
        fprintf(stderr, "FAIL: b8g_sys_write returned %" PRId64 " expected %zu\n", written, msg_len);
        return 5;
    }

    printf("PASS: magic=0x%08" PRIx32 " backend=%s pid=%" PRIu64 " t1=%" PRIu64 " t2=%" PRIu64 " written=%" PRId64 "\n",
           magic, backend, pid, t1, t2, written);
    return 0;
}
