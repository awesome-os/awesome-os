#include "syscall_abi.h"

uint32_t b8g_syscall_abi_magic(void) {
    return B8G_ABI_MAGIC_V3;
}

#if defined(__linux__) && defined(__x86_64__)

struct b8g_timespec {
    int64_t tv_sec;
    int64_t tv_nsec;
};

const char* b8g_syscall_backend_name(void) {
    return "linux-raw-syscall";
}

int64_t b8g_sys_write(int fd, const void* buf, size_t len) {
    int64_t ret;
    __asm__ volatile(
        "syscall"
        : "=a"(ret)
        : "a"(1L), "D"((long)fd), "S"(buf), "d"(len)
        : "rcx", "r11", "memory"
    );
    return ret;
}

uint64_t b8g_sys_getpid(void) {
    int64_t ret;
    __asm__ volatile(
        "syscall"
        : "=a"(ret)
        : "a"(39L)
        : "rcx", "r11", "memory"
    );
    return ret > 0 ? (uint64_t)ret : 0ULL;
}

uint64_t b8g_sys_monotonic_ns(void) {
    struct b8g_timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = 0;
    int64_t ret;
    __asm__ volatile(
        "syscall"
        : "=a"(ret)
        : "a"(228L), "D"(1L), "S"(&ts)
        : "rcx", "r11", "memory"
    );
    if (ret != 0) {
        return 0ULL;
    }
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

#elif defined(__linux__) && defined(__aarch64__)

struct b8g_timespec {
    int64_t tv_sec;
    int64_t tv_nsec;
};

const char* b8g_syscall_backend_name(void) {
    return "linux-raw-syscall";
}

int64_t b8g_sys_write(int fd, const void* buf, size_t len) {
    register long x8 __asm__("x8") = 64L;
    register long x0 __asm__("x0") = (long)fd;
    register long x1 __asm__("x1") = (long)buf;
    register long x2 __asm__("x2") = (long)len;
    __asm__ volatile(
        "svc #0"
        : "+r"(x0)
        : "r"(x8), "r"(x1), "r"(x2)
        : "memory"
    );
    return (int64_t)x0;
}

uint64_t b8g_sys_getpid(void) {
    register long x8 __asm__("x8") = 172L;
    register long x0 __asm__("x0");
    __asm__ volatile(
        "svc #0"
        : "=r"(x0)
        : "r"(x8)
        : "memory"
    );
    return x0 > 0 ? (uint64_t)x0 : 0ULL;
}

uint64_t b8g_sys_monotonic_ns(void) {
    struct b8g_timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = 0;
    register long x8 __asm__("x8") = 113L;
    register long x0 __asm__("x0") = 1L;
    register long x1 __asm__("x1") = (long)&ts;
    __asm__ volatile(
        "svc #0"
        : "+r"(x0)
        : "r"(x8), "r"(x1)
        : "memory"
    );
    if (x0 != 0) {
        return 0ULL;
    }
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

#elif defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

const char* b8g_syscall_backend_name(void) {
    return "win64-kernel32";
}

int64_t b8g_sys_write(int fd, const void* buf, size_t len) {
    DWORD std_handle;
    if (fd == 1) {
        std_handle = STD_OUTPUT_HANDLE;
    } else if (fd == 2) {
        std_handle = STD_ERROR_HANDLE;
    } else {
        return -9; /* EBADF */
    }

    HANDLE h = GetStdHandle(std_handle);
    if (h == INVALID_HANDLE_VALUE || h == NULL) {
        return -9;
    }
    if (len == 0) {
        return 0;
    }

    DWORD to_write = (len > 0x7FFFFFFFu) ? 0x7FFFFFFFu : (DWORD)len;
    DWORD written = 0;
    if (!WriteFile(h, buf, to_write, &written, NULL)) {
        return -5; /* EIO */
    }
    return (int64_t)written;
}

uint64_t b8g_sys_getpid(void) {
    return (uint64_t)GetCurrentProcessId();
}

uint64_t b8g_sys_monotonic_ns(void) {
    LARGE_INTEGER freq;
    LARGE_INTEGER counter;
    if (!QueryPerformanceFrequency(&freq) || freq.QuadPart <= 0) {
        return 0ULL;
    }
    if (!QueryPerformanceCounter(&counter) || counter.QuadPart < 0) {
        return 0ULL;
    }
    uint64_t ticks = (uint64_t)counter.QuadPart;
    uint64_t f = (uint64_t)freq.QuadPart;
    uint64_t sec = ticks / f;
    uint64_t rem = ticks % f;
    return sec * 1000000000ULL + (rem * 1000000000ULL) / f;
}

#elif defined(__APPLE__)

#include <time.h>
#include <unistd.h>

const char* b8g_syscall_backend_name(void) {
    return "macos-libsystem";
}

int64_t b8g_sys_write(int fd, const void* buf, size_t len) {
    return (int64_t)write(fd, buf, len);
}

uint64_t b8g_sys_getpid(void) {
    return (uint64_t)getpid();
}

uint64_t b8g_sys_monotonic_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return 0ULL;
    }
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

#elif defined(__wasi__)

#include <wasi/api.h>

const char* b8g_syscall_backend_name(void) {
    return "wasi-preview1";
}

int64_t b8g_sys_write(int fd, const void* buf, size_t len) {
    __wasi_ciovec_t iov;
    iov.buf = (const uint8_t*)buf;
    iov.buf_len = len;
    size_t nwritten = 0;
    __wasi_errno_t err = __wasi_fd_write((__wasi_fd_t)fd, &iov, 1, &nwritten);
    if (err != __WASI_ERRNO_SUCCESS) {
        return -(int64_t)err;
    }
    return (int64_t)nwritten;
}

uint64_t b8g_sys_getpid(void) {
    /* WASI preview1 does not expose host PIDs; return canonical sandbox PID 1. */
    return 1ULL;
}

uint64_t b8g_sys_monotonic_ns(void) {
    __wasi_timestamp_t ts = 0;
    __wasi_errno_t err = __wasi_clock_time_get(__WASI_CLOCKID_MONOTONIC, 1, &ts);
    if (err != __WASI_ERRNO_SUCCESS) {
        return 0ULL;
    }
    return (uint64_t)ts;
}

#else
#error "Unsupported target platform for b8g syscall ABI"
#endif
