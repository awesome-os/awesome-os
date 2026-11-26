/*
 * b8g-shim — Native C11 Multicall Binary Dispatcher
 *
 * Eliminates the Node/pwsh double-hop wrapper overhead for fast-path tools
 * (sectium-es, sectium-jvm, node, zig, git, gh, pnpm, pnx, npm->pnpm,
 * yarn->pnpm, npx->pnx) while preserving exact exit codes and UTF-8 console I/O.
 *
 * Compiled via holo-compiler (.\bin\zig.cmd cc -std=c11 -O2 -Wall -Wextra -Werror).
 */

#if !defined(_WIN32) && !defined(__APPLE__)
#define _POSIX_C_SOURCE 200809L
#endif

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define PATH_SEP '\\'
#define PATH_LIST_SEP ';'
#define B8G_DEFAULT_DEVPLANE_PIPE "\\\\.\\pipe\\sectium-dev"
#else
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#define PATH_SEP '/'
#define PATH_LIST_SEP ':'
#define B8G_DEFAULT_DEVPLANE_PIPE "/tmp/sectium-dev.sock"
#endif

#define B8G_SHIM_VERSION "b8g-shim v0.1.0 (native C11 multicall dispatcher)"
#define B8G_MAX_PATH 4096

#ifdef _WIN32
#define B8G_FALLBACK_NODE_PATH \
    "D:\\pnpm\\global\\v11\\b18d9690784fd6811328e505a24831dab2e02f59aafadf8ad2485f14fb73e74f\\node_modules\\node\\node.exe"
#endif

static int ascii_lower(int c) {
    if (c >= 'A' && c <= 'Z') {
        return c - 'A' + 'a';
    }
    return c;
}

static bool str_ieq(const char *a, const char *b) {
    while (*a && *b) {
        if (ascii_lower((unsigned char)*a) != ascii_lower((unsigned char)*b)) {
            return false;
        }
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

static bool str_istarts_with(const char *s, const char *prefix) {
    while (*prefix) {
        if (*s == '\0') {
            return false;
        }
        if (ascii_lower((unsigned char)*s) != ascii_lower((unsigned char)*prefix)) {
            return false;
        }
        s++;
        prefix++;
    }
    return true;
}

#ifdef _WIN32
static bool str_iends_with(const char *s, const char *suffix) {
    size_t slen = strlen(s);
    size_t suflen = strlen(suffix);
    if (suflen > slen) {
        return false;
    }
    return str_ieq(s + (slen - suflen), suffix);
}
#endif

static bool is_path_sep(char c) {
    return c == '/' || c == '\\';
}

static bool file_exists(const char *path) {
    if (!path || path[0] == '\0') {
        return false;
    }
#ifdef _WIN32
    DWORD attr = GetFileAttributesA(path);
    return (attr != INVALID_FILE_ATTRIBUTES) && ((attr & FILE_ATTRIBUTE_DIRECTORY) == 0);
#else
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode) && access(path, X_OK) == 0;
#endif
}

static void extract_basename(const char *path, char *out, size_t out_size) {
    const char *base = path;
    for (const char *p = path; *p; p++) {
        if (is_path_sep(*p)) {
            base = p + 1;
        }
    }
    size_t len = strlen(base);
#ifdef _WIN32
    if (len > 4 && str_ieq(base + len - 4, ".exe")) {
        len -= 4;
    }
#endif
    if (len >= out_size) {
        len = out_size - 1;
    }
    memcpy(out, base, len);
    out[len] = '\0';
}

static bool is_self_name(const char *base) {
    return str_ieq(base, "b8g-shim") || str_istarts_with(base, "b8g-shim-");
}

static bool is_known_tool(const char *name) {
    static const char *const kTools[] = {
        "sectium-es", "sectium-jvm", "node", "zig",
        "git",        "gh",          "pnpm", "pnx",
        "npm",        "yarn",        "npx"
    };
    for (size_t i = 0; i < sizeof(kTools) / sizeof(kTools[0]); i++) {
        if (str_ieq(name, kTools[i])) {
            return true;
        }
    }
    return false;
}

static void normalize_dir_for_cmp(const char *in, char *out, size_t out_size) {
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 1 < out_size; i++) {
        char c = in[i];
        if (c == '\\') {
            c = '/';
        }
#ifdef _WIN32
        c = (char)ascii_lower((unsigned char)c);
#endif
        out[j++] = c;
    }
    while (j > 1 && out[j - 1] == '/') {
        j--;
    }
    out[j] = '\0';
}

static bool resolve_exe_and_root(
    const char *argv0,
    char *exe_dir,
    size_t exe_dir_size,
    char *root_dir,
    size_t root_dir_size
) {
    char exe_path[B8G_MAX_PATH];
    exe_path[0] = '\0';

#ifdef _WIN32
    DWORD n = GetModuleFileNameA(NULL, exe_path, (DWORD)sizeof(exe_path));
    if (n == 0 || n >= sizeof(exe_path)) {
        snprintf(exe_path, sizeof(exe_path), "%s", argv0 ? argv0 : "");
    }
#elif defined(__APPLE__)
    uint32_t sz = (uint32_t)sizeof(exe_path);
    if (_NSGetExecutablePath(exe_path, &sz) != 0) {
        snprintf(exe_path, sizeof(exe_path), "%s", argv0 ? argv0 : "");
    }
#else
    ssize_t n = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
    if (n > 0) {
        exe_path[n] = '\0';
    } else {
        snprintf(exe_path, sizeof(exe_path), "%s", argv0 ? argv0 : "");
    }
#endif

    /* Find last separator for exe_dir */
    const char *last_sep = NULL;
    for (const char *p = exe_path; *p; p++) {
        if (is_path_sep(*p)) {
            last_sep = p;
        }
    }
    if (!last_sep) {
        snprintf(exe_dir, exe_dir_size, ".");
        snprintf(root_dir, root_dir_size, ".");
        return true;
    }

    size_t dir_len = (size_t)(last_sep - exe_path);
    if (dir_len == 0) {
        dir_len = 1;
    }
    if (dir_len >= exe_dir_size) {
        dir_len = exe_dir_size - 1;
    }
    memcpy(exe_dir, exe_path, dir_len);
    exe_dir[dir_len] = '\0';

    /* If exe_dir ends with /bin or \bin, workspace root is its parent */
    const char *dir_sep = NULL;
    for (const char *p = exe_dir; *p; p++) {
        if (is_path_sep(*p)) {
            dir_sep = p;
        }
    }
    if (dir_sep && str_ieq(dir_sep + 1, "bin")) {
        size_t rlen = (size_t)(dir_sep - exe_dir);
        if (rlen == 0) {
            rlen = 1;
        }
        if (rlen >= root_dir_size) {
            rlen = root_dir_size - 1;
        }
        memcpy(root_dir, exe_dir, rlen);
        root_dir[rlen] = '\0';
    } else {
        snprintf(root_dir, root_dir_size, "%s", exe_dir);
    }

    return true;
}

static char *build_filtered_path(const char *skip_bin_dir, const char *skip_exe_dir) {
    const char *env_path = getenv("PATH");
    if (!env_path) {
        return NULL;
    }

    char norm_bin[B8G_MAX_PATH];
    char norm_exe[B8G_MAX_PATH];
    normalize_dir_for_cmp(skip_bin_dir, norm_bin, sizeof(norm_bin));
    normalize_dir_for_cmp(skip_exe_dir, norm_exe, sizeof(norm_exe));

    size_t cap = strlen(env_path) + 2;
    char *filtered = (char *)malloc(cap);
    if (!filtered) {
        return NULL;
    }
    filtered[0] = '\0';
    size_t out_len = 0;

    const char *p = env_path;
    while (*p) {
        const char *end = strchr(p, PATH_LIST_SEP);
        size_t seg_len = end ? (size_t)(end - p) : strlen(p);
        if (seg_len > 0 && seg_len < B8G_MAX_PATH) {
            char seg[B8G_MAX_PATH];
            char norm_seg[B8G_MAX_PATH];
            memcpy(seg, p, seg_len);
            seg[seg_len] = '\0';
            /* Strip optional surrounding quotes in Windows PATH */
            char *clean = seg;
            if (clean[0] == '"' && seg_len >= 2 && clean[seg_len - 1] == '"') {
                clean[seg_len - 1] = '\0';
                clean++;
            }
            normalize_dir_for_cmp(clean, norm_seg, sizeof(norm_seg));
            if (strcmp(norm_seg, norm_bin) != 0 && strcmp(norm_seg, norm_exe) != 0) {
                if (out_len > 0) {
                    filtered[out_len++] = PATH_LIST_SEP;
                }
                size_t clen = strlen(clean);
                memcpy(filtered + out_len, clean, clen);
                out_len += clen;
                filtered[out_len] = '\0';
            }
        }
        if (!end) {
            break;
        }
        p = end + 1;
    }

    return filtered;
}

static bool search_filtered_path(
    const char *tool,
    const char *skip_bin_dir,
    const char *skip_exe_dir,
    char *out_path,
    size_t out_size
) {
    char *filtered = build_filtered_path(skip_bin_dir, skip_exe_dir);
    if (!filtered) {
        return false;
    }

    bool found = false;
#ifdef _WIN32
    static const char *const kExts[] = { ".exe", ".cmd", ".bat", ".com", NULL };
    for (size_t i = 0; i < sizeof(kExts) / sizeof(kExts[0]); i++) {
        DWORD n = SearchPathA(filtered, tool, kExts[i], (DWORD)out_size, out_path, NULL);
        if (n > 0 && n < out_size) {
            found = true;
            break;
        }
    }
#else
    const char *p = filtered;
    while (*p) {
        const char *end = strchr(p, PATH_LIST_SEP);
        size_t seg_len = end ? (size_t)(end - p) : strlen(p);
        if (seg_len > 0 && seg_len + strlen(tool) + 2 < out_size) {
            memcpy(out_path, p, seg_len);
            out_path[seg_len] = '/';
            strcpy(out_path + seg_len + 1, tool);
            if (file_exists(out_path)) {
                found = true;
                break;
            }
        }
        if (!end) {
            break;
        }
        p = end + 1;
    }
#endif

    free(filtered);
    return found;
}

static bool resolve_target_executable(
    const char *tool_in,
    const char *root_dir,
    const char *exe_dir,
    char *out_path,
    size_t out_size
) {
    /* Rewrite legacy package manager aliases */
    const char *tool = tool_in;
    if (str_ieq(tool, "npx")) {
        tool = "pnx";
    } else if (str_ieq(tool, "npm") || str_ieq(tool, "yarn")) {
        tool = "pnpm";
    }

    char root_bin[B8G_MAX_PATH];
    snprintf(root_bin, sizeof(root_bin), "%s%cbin", root_dir, PATH_SEP);

    /* Fast-path: sectium-es */
    if (str_ieq(tool, "sectium-es")) {
#ifdef _WIN32
        snprintf(out_path, out_size, "%s\\sections\\b8g-es\\dist\\sectium-es.exe", root_dir);
        return file_exists(out_path);
#elif defined(__APPLE__)
        snprintf(out_path, out_size, "%s/sections/b8g-es/dist/sectium-es-macos-arm64", root_dir);
        return file_exists(out_path);
#elif defined(__aarch64__)
        snprintf(out_path, out_size, "%s/sections/b8g-es/dist/sectium-es-linux-arm64", root_dir);
        return file_exists(out_path);
#else
        snprintf(out_path, out_size, "%s/sections/b8g-es/dist/sectium-es-linux-x64", root_dir);
        if (file_exists(out_path)) {
            return true;
        }
        snprintf(out_path, out_size, "%s/sections/b8g-es/dist/sectium-es", root_dir);
        return file_exists(out_path);
#endif
    }

    /* Fast-path: sectium-jvm */
    if (str_ieq(tool, "sectium-jvm")) {
#ifdef _WIN32
        snprintf(out_path, out_size, "%s\\sections\\b8g-jvm\\dist\\sectium-jvm.exe", root_dir);
        return file_exists(out_path);
#elif defined(__APPLE__)
        snprintf(out_path, out_size, "%s/sections/b8g-jvm/dist/sectium-jvm-macos-arm64", root_dir);
        return file_exists(out_path);
#elif defined(__aarch64__)
        snprintf(out_path, out_size, "%s/sections/b8g-jvm/dist/sectium-jvm-linux-arm64", root_dir);
        return file_exists(out_path);
#else
        snprintf(out_path, out_size, "%s/sections/b8g-jvm/dist/sectium-jvm-linux-x64", root_dir);
        if (file_exists(out_path)) {
            return true;
        }
        snprintf(out_path, out_size, "%s/sections/b8g-jvm/dist/sectium-jvm", root_dir);
        return file_exists(out_path);
#endif
    }

    /* Fast-path: node */
    if (str_ieq(tool, "node")) {
        const char *env_node = getenv("B8G_NODE_BIN");
        if (env_node && file_exists(env_node)) {
            snprintf(out_path, out_size, "%s", env_node);
            return true;
        }
#ifdef _WIN32
        if (file_exists(B8G_FALLBACK_NODE_PATH)) {
            snprintf(out_path, out_size, "%s", B8G_FALLBACK_NODE_PATH);
            return true;
        }
#endif
        return search_filtered_path("node", root_bin, exe_dir, out_path, out_size);
    }

    /* Fast-path: zig */
    if (str_ieq(tool, "zig")) {
#ifdef _WIN32
        snprintf(out_path, out_size, "%s\\bin\\zig-real.exe", root_dir);
#else
        snprintf(out_path, out_size, "%s/bin/zig-real", root_dir);
#endif
        if (file_exists(out_path)) {
            return true;
        }
        return search_filtered_path("zig", root_bin, exe_dir, out_path, out_size);
    }

    /* General PATH lookup skipping <root>/bin to prevent recursion */
    return search_filtered_path(tool, root_bin, exe_dir, out_path, out_size);
}

#ifdef _WIN32
typedef struct {
    char *data;
    size_t len;
    size_t cap;
} StrBuf;

static bool sb_reserve(StrBuf *sb, size_t extra) {
    if (sb->len + extra + 1 <= sb->cap) {
        return true;
    }
    size_t new_cap = sb->cap ? sb->cap * 2 : 256;
    while (new_cap < sb->len + extra + 1) {
        new_cap *= 2;
    }
    char *next = (char *)realloc(sb->data, new_cap);
    if (!next) {
        return false;
    }
    sb->data = next;
    sb->cap = new_cap;
    return true;
}

static bool sb_push_char(StrBuf *sb, char c) {
    if (!sb_reserve(sb, 1)) {
        return false;
    }
    sb->data[sb->len++] = c;
    sb->data[sb->len] = '\0';
    return true;
}

static bool sb_push_str(StrBuf *sb, const char *s) {
    size_t n = strlen(s);
    if (!sb_reserve(sb, n)) {
        return false;
    }
    memcpy(sb->data + sb->len, s, n);
    sb->len += n;
    sb->data[sb->len] = '\0';
    return true;
}

/* Standard Windows MSVCRT CommandLineToArgvW quoting */
static bool sb_append_win_arg(StrBuf *sb, const char *arg) {
    if (sb->len > 0) {
        if (!sb_push_char(sb, ' ')) {
            return false;
        }
    }

    bool needs_quotes = (arg[0] == '\0');
    for (const char *p = arg; *p; p++) {
        if (*p == ' ' || *p == '\t' || *p == '"' || *p == '\n' || *p == '\v') {
            needs_quotes = true;
            break;
        }
    }

    if (!needs_quotes) {
        return sb_push_str(sb, arg);
    }

    if (!sb_push_char(sb, '"')) {
        return false;
    }

    size_t backslashes = 0;
    for (const char *p = arg; *p; p++) {
        if (*p == '\\') {
            backslashes++;
        } else if (*p == '"') {
            for (size_t i = 0; i < backslashes * 2 + 1; i++) {
                if (!sb_push_char(sb, '\\')) {
                    return false;
                }
            }
            if (!sb_push_char(sb, '"')) {
                return false;
            }
            backslashes = 0;
        } else {
            for (size_t i = 0; i < backslashes; i++) {
                if (!sb_push_char(sb, '\\')) {
                    return false;
                }
            }
            backslashes = 0;
            if (!sb_push_char(sb, *p)) {
                return false;
            }
        }
    }

    for (size_t i = 0; i < backslashes * 2; i++) {
        if (!sb_push_char(sb, '\\')) {
            return false;
        }
    }

    return sb_push_char(sb, '"');
}
#endif

static size_t format_devplane_ndjson(
    char *out,
    size_t out_size,
    const char *tool,
    int exit_code,
    double elapsed_ms
) {
    char safe_tool[128];
    size_t j = 0;
    for (size_t i = 0; tool && tool[i] && j + 2 < sizeof(safe_tool); i++) {
        char c = tool[i];
        if (c == '"' || c == '\\') {
            safe_tool[j++] = '\\';
            safe_tool[j++] = c;
        } else if ((unsigned char)c >= 0x20) {
            safe_tool[j++] = c;
        }
    }
    safe_tool[j] = '\0';

    int n = snprintf(
        out,
        out_size,
        "{\"channel\":\"command\",\"kind\":\"bin.exec\",\"tool\":\"%s\",\"exit\":%d,\"elapsed_ms\":%.2f}\n",
        safe_tool,
        exit_code,
        elapsed_ms
    );
    if (n <= 0) {
        return 0;
    }
    if ((size_t)n >= out_size) {
        return out_size - 1;
    }
    return (size_t)n;
}

static const char *get_devplane_pipe_path(void) {
    const char *env_pipe = getenv("B8G_DEVPLANE_PIPE");
    if (env_pipe && env_pipe[0] != '\0') {
        return env_pipe;
    }
    return B8G_DEFAULT_DEVPLANE_PIPE;
}

static void emit_devplane_event(const char *tool, int exit_code, double elapsed_ms) {
    const char *pipe_path = get_devplane_pipe_path();
    char payload[512];
    size_t payload_len = format_devplane_ndjson(payload, sizeof(payload), tool, exit_code, elapsed_ms);
    if (payload_len == 0) {
        return;
    }

#ifdef _WIN32
    HANDLE h = CreateFileA(
        pipe_path,
        GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        0,
        NULL
    );
    if (h == INVALID_HANDLE_VALUE) {
        return;
    }
    DWORD written = 0;
    WriteFile(h, payload, (DWORD)payload_len, &written, NULL);
    CloseHandle(h);
#else
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        return;
    }
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) {
        (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    size_t plen = strlen(pipe_path);
    if (plen >= sizeof(addr.sun_path)) {
        close(fd);
        return;
    }
    memcpy(addr.sun_path, pipe_path, plen + 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
        ssize_t ignored = write(fd, payload, payload_len);
        (void)ignored;
    }
    close(fd);
#endif
}

#ifdef _WIN32
static int exec_child_win32(const char *tool, const char *exe_path, int child_argc, char **child_argv) {
    StrBuf cmd = { NULL, 0, 0 };
    bool is_batch = str_iends_with(exe_path, ".cmd") || str_iends_with(exe_path, ".bat");

    const char *app_name = exe_path;
    char comspec_buf[B8G_MAX_PATH];

    if (is_batch) {
        const char *comspec = getenv("ComSpec");
        if (!comspec || comspec[0] == '\0') {
            comspec = "C:\\Windows\\System32\\cmd.exe";
        }
        snprintf(comspec_buf, sizeof(comspec_buf), "%s", comspec);
        app_name = comspec_buf;

        if (!sb_append_win_arg(&cmd, comspec_buf) ||
            !sb_append_win_arg(&cmd, "/d") ||
            !sb_append_win_arg(&cmd, "/c") ||
            !sb_append_win_arg(&cmd, exe_path)) {
            free(cmd.data);
            return 1;
        }
    } else {
        if (!sb_append_win_arg(&cmd, exe_path)) {
            free(cmd.data);
            return 1;
        }
    }

    for (int i = 0; i < child_argc; i++) {
        if (!sb_append_win_arg(&cmd, child_argv[i])) {
            free(cmd.data);
            return 1;
        }
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);

    LARGE_INTEGER freq, t0, t1;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&t0);

    BOOL ok = CreateProcessA(
        app_name,
        cmd.data,
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        NULL,
        &si,
        &pi
    );

    free(cmd.data);

    if (!ok) {
        fprintf(stderr, "b8g-shim: failed to launch '%s' (win32 error %lu)\n",
                exe_path, (unsigned long)GetLastError());
        return 127;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    QueryPerformanceCounter(&t1);

    DWORD exit_code = 1;
    if (!GetExitCodeProcess(pi.hProcess, &exit_code)) {
        exit_code = 1;
    }

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    double elapsed_ms = (freq.QuadPart > 0)
        ? ((double)(t1.QuadPart - t0.QuadPart) * 1000.0 / (double)freq.QuadPart)
        : 0.0;
    emit_devplane_event(tool, (int)exit_code, elapsed_ms);

    return (int)exit_code;
}
#else
static int exec_child_posix(const char *tool, const char *exe_path, int child_argc, char **child_argv) {
    char **exec_argv = (char **)malloc((size_t)(child_argc + 2) * sizeof(char *));
    if (!exec_argv) {
        return 1;
    }
    exec_argv[0] = (char *)exe_path;
    for (int i = 0; i < child_argc; i++) {
        exec_argv[i + 1] = child_argv[i];
    }
    exec_argv[child_argc + 1] = NULL;

    /* Fast path: when no devplane socket exists, exec directly with zero fork overhead */
    const char *pipe_path = get_devplane_pipe_path();
    if (access(pipe_path, F_OK) != 0) {
        execvp(exe_path, exec_argv);
        fprintf(stderr, "b8g-shim: failed to exec '%s': %s\n", exe_path, strerror(errno));
        free(exec_argv);
        return 127;
    }

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    pid_t pid = fork();
    if (pid < 0) {
        execvp(exe_path, exec_argv);
        free(exec_argv);
        return 127;
    }
    if (pid == 0) {
        execvp(exe_path, exec_argv);
        _exit(127);
    }

    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    free(exec_argv);

    int exit_code = 1;
    if (WIFEXITED(status)) {
        exit_code = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        exit_code = 128 + WTERMSIG(status);
    }

    double elapsed_ms = ((double)(t1.tv_sec - t0.tv_sec) * 1000.0) +
                        ((double)(t1.tv_nsec - t0.tv_nsec) / 1000000.0);
    emit_devplane_event(tool, exit_code, elapsed_ms);
    return exit_code;
}
#endif

static void print_list(void) {
    puts("sectium-es");
    puts("sectium-jvm");
    puts("node");
    puts("zig");
    puts("git");
    puts("gh");
    puts("pnpm");
    puts("pnx");
    puts("npm->pnpm");
    puts("yarn->pnpm");
    puts("npx->pnx");
}

int main(int argc, char **argv) {
#ifdef _WIN32
    SetConsoleOutputCP(65001);
    SetConsoleCP(65001);
#endif

    char base_name[256];
    extract_basename(argc > 0 && argv[0] ? argv[0] : "b8g-shim", base_name, sizeof(base_name));

    const char *target_tool = NULL;
    int arg_start = 1;

    if (!is_self_name(base_name)) {
        /* BusyBox multicall mode */
        target_tool = base_name;
        arg_start = 1;
    } else {
        /* Direct b8g-shim invocation */
        if (argc >= 2 && strcmp(argv[1], "--version") == 0) {
            puts(B8G_SHIM_VERSION);
            return 0;
        }
        if (argc >= 2 && strcmp(argv[1], "--list") == 0) {
            print_list();
            return 0;
        }

        const char *env_target = getenv("SHIM_TARGET");
        if (argc >= 3 && strcmp(argv[1], "--tool") == 0) {
            target_tool = argv[2];
            arg_start = 3;
        } else if (argc >= 2 && strcmp(argv[1], "--from-env") == 0) {
            if (!env_target || env_target[0] == '\0') {
                fprintf(stderr, "b8g-shim: --from-env requires SHIM_TARGET\n");
                return 1;
            }
            target_tool = env_target;
            arg_start = 2;
        } else if (env_target && env_target[0] != '\0' && (argc < 2 || !is_known_tool(argv[1]))) {
            target_tool = env_target;
            arg_start = 1;
        } else if (argc >= 2) {
            target_tool = argv[1];
            arg_start = 2;
        } else {
            fprintf(stderr, "usage: b8g-shim [--version | --list | --tool <name> | <tool>] [args...]\n");
            return 1;
        }
    }

    char exe_dir[B8G_MAX_PATH];
    char root_dir[B8G_MAX_PATH];
    resolve_exe_and_root(argc > 0 ? argv[0] : NULL, exe_dir, sizeof(exe_dir), root_dir, sizeof(root_dir));

    char resolved_exe[B8G_MAX_PATH];
    if (!resolve_target_executable(target_tool, root_dir, exe_dir, resolved_exe, sizeof(resolved_exe))) {
        fprintf(stderr, "b8g-shim: tool '%s' not found (workspace root: %s)\n", target_tool, root_dir);
        return 127;
    }

    int child_argc = argc - arg_start;
    char **child_argv = (child_argc > 0) ? (argv + arg_start) : NULL;

#ifdef _WIN32
    return exec_child_win32(target_tool, resolved_exe, child_argc, child_argv);
#else
    return exec_child_posix(target_tool, resolved_exe, child_argc, child_argv);
#endif
}
