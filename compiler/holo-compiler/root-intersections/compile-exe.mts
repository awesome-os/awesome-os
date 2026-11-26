/**
 * @file intersections/holo-compiler/compile-exe.mts
 * @description Bun-style `pnpm build --compile` Ghost / Standalone Single-Executable Packager.
 *
 * Compiles any JS/TS entry file into a tiny native executable (~20 KB in `ghost` mode)
 * using `e:\awesome-os\bin\zig.cmd cc -Os -s -std=c11` backed by the unified
 * pnpm-v12-compatible `CasV11Store` (`v11/files/XX/<sha512>`).
 *
 * Modes:
 *   - `ghost` (default): ~20 KB native stub embedding `B8G_ABI_MAGIC_V3` (`0x33564742`),
 *     app name, SHA-512 digest, and `<casRoot>/v11/files/<XX>/<sha512>` resolution.
 *     Hydrates & executes the CAS-stored payload directly via `node` / `b8g-node`.
 *   - `standalone`: Appends the raw payload bytes + 24-byte `B8GEXE01` footer
 *     (`magic[8] + payloadLen_u64le[8] + sha256Prefix[8]`) onto the compiled executable
 *     so it is 100% self-contained offline.
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  CAS_V11_VERSION,
  CasV11Store,
  resolveUnifiedCasRoot,
} from './cas-v11-store.mts';

export const B8G_ABI_MAGIC_V3 = 0x33564742 as const;
export const B8G_ABI_MAGIC_V3_HEX = '0x33564742' as const;
export const B8G_EXE_FOOTER_MAGIC = 'B8GEXE01' as const;
export const B8G_EXE_FOOTER_BYTES = 24 as const;

export type CompileExeMode = 'ghost' | 'standalone';

export interface CompileExeOptions {
  readonly entryPath: string;
  readonly outPath: string;
  readonly appName: string;
  readonly mode?: CompileExeMode;
  readonly targetTriple?: string;
  readonly casStoreRoot?: string;
}

export interface CompileExeResult {
  readonly outPath: string;
  readonly mode: CompileExeMode;
  readonly binaryBytes: number;
  readonly payloadSha512: string;
  readonly casBlobPath: string;
  readonly compileMs: number;
}

export interface StandaloneFooter {
  readonly magic: string;
  readonly payloadLen: number;
  readonly sha256PrefixHex: string;
}

// ============================================================================
// Pure Helpers
// ============================================================================

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(MODULE_DIR, '..', '..');

function resolveZigCommand(): { readonly command: string; readonly useShell: boolean } {
  if (process.platform === 'win32') {
    const workspaceZigCmd = path.join(WORKSPACE_ROOT, 'bin', 'zig.cmd');
    if (fs.existsSync(workspaceZigCmd)) {
      return { command: workspaceZigCmd, useShell: true };
    }
    return { command: 'zig.cmd', useShell: true };
  }
  const workspaceZig = path.join(WORKSPACE_ROOT, 'bin', 'zig');
  if (fs.existsSync(workspaceZig)) {
    return { command: workspaceZig, useShell: false };
  }
  return { command: 'zig', useShell: false };
}

function normalizeV11StoreRoot(casStoreRoot?: string): string {
  if (!casStoreRoot || casStoreRoot.trim().length === 0) {
    return resolveUnifiedCasRoot();
  }
  const resolved = path.resolve(casStoreRoot.trim());
  if (path.basename(resolved) === CAS_V11_VERSION) {
    return resolved;
  }
  return path.join(resolved, CAS_V11_VERSION);
}

function escapeCString(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x5c) {
      out += '\\\\';
    } else if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x0a) {
      out += '\\n';
    } else if (code === 0x0d) {
      out += '\\r';
    } else if (code === 0x09) {
      out += '\\t';
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += value[i];
    }
  }
  return out;
}

function quoteWinCmdArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Builds the 24-byte `B8GEXE01` standalone footer:
 *   - bytes 0..7:   ASCII `"B8GEXE01"`
 *   - bytes 8..15:  `uint64_t payloadLen` (little-endian)
 *   - bytes 16..23: first 8 bytes of SHA-256(payload)
 */
export function buildStandaloneFooter(payload: Uint8Array): Uint8Array {
  const footer = new Uint8Array(B8G_EXE_FOOTER_BYTES);
  const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);

  for (let i = 0; i < B8G_EXE_FOOTER_MAGIC.length; i += 1) {
    footer[i] = B8G_EXE_FOOTER_MAGIC.charCodeAt(i);
  }

  view.setBigUint64(8, BigInt(payload.byteLength), true);

  const sha256Digest = createHash('sha256').update(payload).digest();
  footer.set(sha256Digest.subarray(0, 8), 16);

  return footer;
}

/**
 * Parses a 24-byte `B8GEXE01` standalone footer from the tail of a binary buffer.
 * Returns `null` if the buffer is too small or the magic does not match.
 */
export function parseStandaloneFooter(binary: Uint8Array): StandaloneFooter | null {
  if (binary.byteLength < B8G_EXE_FOOTER_BYTES) {
    return null;
  }
  const offset = binary.byteLength - B8G_EXE_FOOTER_BYTES;
  const tail = binary.subarray(offset);

  let magic = '';
  for (let i = 0; i < 8; i += 1) {
    magic += String.fromCharCode(tail[i]!);
  }
  if (magic !== B8G_EXE_FOOTER_MAGIC) {
    return null;
  }

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const payloadLen = Number(view.getBigUint64(8, true));
  const sha256PrefixHex = Buffer.from(tail.subarray(16, 24)).toString('hex');

  return {
    magic,
    payloadLen,
    sha256PrefixHex,
  };
}

// ============================================================================
// C11 Native Stub Generator
// ============================================================================

interface StubTemplateParams {
  readonly mode: CompileExeMode;
  readonly appName: string;
  readonly sha512: string;
  readonly casRoot: string;
  readonly entryExt: string;
  readonly defaultRuntime: string;
}

function generateC11Stub(params: StubTemplateParams): string {
  const isStandalone = params.mode === 'standalone' ? 1 : 0;
  const appNameC = escapeCString(params.appName);
  const sha512C = escapeCString(params.sha512);
  const casRootC = escapeCString(params.casRoot);
  const entryExtC = escapeCString(params.entryExt);
  const defaultRuntimeC = escapeCString(params.defaultRuntime);

  return `/* Auto-generated by holo-compiler compile-exe.mts (C11, B8G_ABI_MAGIC_V3) */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define B8G_PATH_SEP "\\\\"
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#define B8G_PATH_SEP "/"
#endif

#define B8G_ABI_MAGIC_V3 0x33564742u
#define B8G_STANDALONE_MODE ${isStandalone}
#define B8G_FOOTER_BYTES 24

static const char B8G_APP_NAME[] = "${appNameC}";
static const char B8G_SHA512[] = "${sha512C}";
static const char B8G_CAS_ROOT[] = "${casRootC}";
static const char B8G_ENTRY_EXT[] = "${entryExtC}";
static const char B8G_DEFAULT_RUNTIME[] = "${defaultRuntimeC}";

static void print_json_str(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
      case '\\\\': fputs("\\\\\\\\", stdout); break;
      case '"':  fputs("\\\\\\"", stdout); break;
      case '\\n': fputs("\\\\n", stdout); break;
      case '\\r': fputs("\\\\r", stdout); break;
      case '\\t': fputs("\\\\t", stdout); break;
      default:
        if (*p < 0x20) {
          printf("\\\\u%04x", (unsigned int)*p);
        } else {
          putchar((int)*p);
        }
        break;
    }
  }
  putchar('"');
}

static int file_exists(const char *p) {
  FILE *f = fopen(p, "rb");
  if (!f) return 0;
  fclose(f);
  return 1;
}

static int find_runtime(char *out, size_t out_cap) {
  const char *env_bin = getenv("B8G_NODE_BIN");
  if (env_bin && env_bin[0] != '\\0' && file_exists(env_bin)) {
    snprintf(out, out_cap, "%s", env_bin);
    return 1;
  }

#ifdef _WIN32
  if (SearchPathA(NULL, "b8g-node.exe", NULL, (DWORD)out_cap, out, NULL) > 0) {
    return 1;
  }
  if (SearchPathA(NULL, "node.exe", NULL, (DWORD)out_cap, out, NULL) > 0) {
    return 1;
  }
#else
  const char *path_env = getenv("PATH");
  if (path_env && path_env[0] != '\\0') {
    const char *candidates[2] = { "b8g-node", "node" };
    for (int c = 0; c < 2; c++) {
      const char *start = path_env;
      while (*start) {
        const char *colon = strchr(start, ':');
        size_t dir_len = colon ? (size_t)(colon - start) : strlen(start);
        if (dir_len > 0 && dir_len + strlen(candidates[c]) + 2 < out_cap) {
          memcpy(out, start, dir_len);
          out[dir_len] = '/';
          strcpy(out + dir_len + 1, candidates[c]);
          if (access(out, X_OK) == 0) {
            return 1;
          }
        }
        if (!colon) break;
        start = colon + 1;
      }
    }
  }
#endif

  if (B8G_DEFAULT_RUNTIME[0] != '\\0' && file_exists(B8G_DEFAULT_RUNTIME)) {
    snprintf(out, out_cap, "%s", B8G_DEFAULT_RUNTIME);
    return 1;
  }
  return 0;
}

#ifdef _WIN32
static void append_quoted_arg(char *buf, size_t cap, size_t *len, const char *arg) {
  if (*len + 2 >= cap) return;
  if (*len > 0) {
    buf[(*len)++] = ' ';
  }
  buf[(*len)++] = '"';
  for (const char *p = arg; *p && *len + 3 < cap; p++) {
    if (*p == '"') {
      buf[(*len)++] = '\\\\';
      buf[(*len)++] = '"';
    } else {
      buf[(*len)++] = *p;
    }
  }
  buf[(*len)++] = '"';
  buf[*len] = '\\0';
}

static int run_runtime(const char *runtime, const char *script_path, int argc, char **argv) {
  char cmdline[16384];
  size_t len = 0;
  cmdline[0] = '\\0';
  append_quoted_arg(cmdline, sizeof(cmdline), &len, runtime);
  append_quoted_arg(cmdline, sizeof(cmdline), &len, script_path);
  for (int i = 1; i < argc; i++) {
    append_quoted_arg(cmdline, sizeof(cmdline), &len, argv[i]);
  }

  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si));
  memset(&pi, 0, sizeof(pi));
  si.cb = sizeof(si);

  if (!CreateProcessA(runtime, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fprintf(stderr, "holo-exe: failed to launch runtime '%s' (err=%lu)\\n",
            runtime, (unsigned long)GetLastError());
    return 127;
  }

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(pi.hProcess, &exit_code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return (int)exit_code;
}
#else
static int run_runtime(const char *runtime, const char *script_path, int argc, char **argv) {
  pid_t pid = fork();
  if (pid < 0) {
    fprintf(stderr, "holo-exe: fork failed\\n");
    return 127;
  }
  if (pid == 0) {
    char **child_argv = (char **)calloc((size_t)(argc + 3), sizeof(char *));
    if (!child_argv) _exit(127);
    child_argv[0] = (char *)runtime;
    child_argv[1] = (char *)script_path;
    for (int i = 1; i < argc; i++) {
      child_argv[i + 1] = argv[i];
    }
    child_argv[argc + 1] = NULL;
    execv(runtime, child_argv);
    fprintf(stderr, "holo-exe: execv failed for '%s'\\n", runtime);
    _exit(127);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) < 0) {
    return 1;
  }
  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  return 1;
}
#endif

#if B8G_STANDALONE_MODE
static uint64_t read_u64_le(const unsigned char *b) {
  return ((uint64_t)b[0]) |
         ((uint64_t)b[1] << 8) |
         ((uint64_t)b[2] << 16) |
         ((uint64_t)b[3] << 24) |
         ((uint64_t)b[4] << 32) |
         ((uint64_t)b[5] << 40) |
         ((uint64_t)b[6] << 48) |
         ((uint64_t)b[7] << 56);
}

static int get_self_path(char *out, size_t cap, const char *argv0) {
#ifdef _WIN32
  DWORD n = GetModuleFileNameA(NULL, out, (DWORD)cap);
  if (n > 0 && n < (DWORD)cap) return 1;
#else
  ssize_t n = readlink("/proc/self/exe", out, cap - 1);
  if (n > 0) {
    out[n] = '\\0';
    return 1;
  }
#endif
  snprintf(out, cap, "%s", argv0);
  return 1;
}

static int read_standalone_footer(const char *self_path, uint64_t *out_payload_len,
                                  uint64_t *out_payload_offset, unsigned char out_sha256_prefix[8]) {
  FILE *f = fopen(self_path, "rb");
  if (!f) return 0;
#ifdef _WIN32
  if (_fseeki64(f, 0, SEEK_END) != 0) { fclose(f); return 0; }
  int64_t file_size = _ftelli64(f);
#else
  if (fseeko(f, 0, SEEK_END) != 0) { fclose(f); return 0; }
  int64_t file_size = (int64_t)ftello(f);
#endif
  if (file_size < B8G_FOOTER_BYTES) {
    fclose(f);
    return 0;
  }
#ifdef _WIN32
  if (_fseeki64(f, file_size - B8G_FOOTER_BYTES, SEEK_SET) != 0) { fclose(f); return 0; }
#else
  if (fseeko(f, (off_t)(file_size - B8G_FOOTER_BYTES), SEEK_SET) != 0) { fclose(f); return 0; }
#endif
  unsigned char footer[B8G_FOOTER_BYTES];
  if (fread(footer, 1, B8G_FOOTER_BYTES, f) != B8G_FOOTER_BYTES) {
    fclose(f);
    return 0;
  }
  fclose(f);

  if (memcmp(footer, "B8GEXE01", 8) != 0) {
    return 0;
  }
  uint64_t payload_len = read_u64_le(footer + 8);
  if (payload_len > (uint64_t)(file_size - B8G_FOOTER_BYTES)) {
    return 0;
  }
  *out_payload_len = payload_len;
  *out_payload_offset = (uint64_t)(file_size - B8G_FOOTER_BYTES) - payload_len;
  memcpy(out_sha256_prefix, footer + 16, 8);
  return 1;
}
#endif

int main(int argc, char **argv) {
  int want_info = (argc >= 2 && strcmp(argv[1], "--holo-exe-info") == 0);

#if B8G_STANDALONE_MODE
  char self_path[4096];
  get_self_path(self_path, sizeof(self_path), argv[0]);

  uint64_t payload_len = 0;
  uint64_t payload_offset = 0;
  unsigned char sha256_prefix[8];
  if (!read_standalone_footer(self_path, &payload_len, &payload_offset, sha256_prefix)) {
    fprintf(stderr, "holo-exe: missing or corrupt B8GEXE01 standalone footer\\n");
    return 2;
  }

  if (want_info) {
    fputs("{\\"mode\\":\\"standalone\\",\\"abiMagic\\":\\"0x33564742\\",\\"appName\\":", stdout);
    print_json_str(B8G_APP_NAME);
    fputs(",\\"sha512\\":", stdout);
    print_json_str(B8G_SHA512);
    printf(",\\"embeddedBytes\\":%llu}\\n", (unsigned long long)payload_len);
    return 0;
  }

  FILE *sf = fopen(self_path, "rb");
  if (!sf) {
    fprintf(stderr, "holo-exe: failed to reopen standalone binary\\n");
    return 2;
  }
#ifdef _WIN32
  _fseeki64(sf, (int64_t)payload_offset, SEEK_SET);
#else
  fseeko(sf, (off_t)payload_offset, SEEK_SET);
#endif
  unsigned char *payload_buf = (unsigned char *)malloc((size_t)(payload_len > 0 ? payload_len : 1));
  if (!payload_buf) {
    fclose(sf);
    return 2;
  }
  if (payload_len > 0 && fread(payload_buf, 1, (size_t)payload_len, sf) != (size_t)payload_len) {
    free(payload_buf);
    fclose(sf);
    fprintf(stderr, "holo-exe: failed to read embedded payload\\n");
    return 2;
  }
  fclose(sf);

  char temp_script[4096];
  const char *ext = B8G_ENTRY_EXT[0] ? B8G_ENTRY_EXT : ".mjs";
#ifdef _WIN32
  char temp_dir[2048];
  DWORD tlen = GetTempPathA((DWORD)sizeof(temp_dir), temp_dir);
  if (tlen == 0 || tlen >= sizeof(temp_dir)) {
    snprintf(temp_dir, sizeof(temp_dir), ".");
  }
  snprintf(temp_script, sizeof(temp_script), "%sb8g-exe-%lu-%02x%02x%02x%02x%s",
           temp_dir, (unsigned long)GetCurrentProcessId(),
           sha256_prefix[0], sha256_prefix[1], sha256_prefix[2], sha256_prefix[3], ext);
#else
  snprintf(temp_script, sizeof(temp_script), "/tmp/b8g-exe-%lu-%02x%02x%02x%02x%s",
           (unsigned long)getpid(),
           sha256_prefix[0], sha256_prefix[1], sha256_prefix[2], sha256_prefix[3], ext);
#endif

  FILE *tf = fopen(temp_script, "wb");
  if (!tf) {
    free(payload_buf);
    fprintf(stderr, "holo-exe: failed to write temp script '%s'\\n", temp_script);
    return 2;
  }
  if (payload_len > 0) {
    fwrite(payload_buf, 1, (size_t)payload_len, tf);
  }
  fclose(tf);
  free(payload_buf);

  char runtime[4096];
  if (!find_runtime(runtime, sizeof(runtime))) {
    remove(temp_script);
    fprintf(stderr, "holo-exe: unable to locate node or b8g-node runtime\\n");
    return 127;
  }

  int rc = run_runtime(runtime, temp_script, argc, argv);
  remove(temp_script);
  return rc;
#else
  char shard[3];
  shard[0] = B8G_SHA512[0];
  shard[1] = B8G_SHA512[1];
  shard[2] = '\\0';

  const char *cas_root = getenv("B8G_EXE_CAS_ROOT");
  if (!cas_root || cas_root[0] == '\\0') {
    cas_root = B8G_CAS_ROOT;
  }

  char blob_path[4096];
  snprintf(blob_path, sizeof(blob_path), "%s" B8G_PATH_SEP "files" B8G_PATH_SEP "%s" B8G_PATH_SEP "%s",
           cas_root, shard, B8G_SHA512);

  if (want_info) {
    fputs("{\\"mode\\":\\"ghost\\",\\"abiMagic\\":\\"0x33564742\\",\\"appName\\":", stdout);
    print_json_str(B8G_APP_NAME);
    fputs(",\\"sha512\\":", stdout);
    print_json_str(B8G_SHA512);
    fputs(",\\"casBlobPath\\":", stdout);
    print_json_str(blob_path);
    fputs("}\\n", stdout);
    return 0;
  }

  if (!file_exists(blob_path)) {
    fprintf(stderr, "holo-exe: CAS v11 blob not found: %s\\n", blob_path);
    return 2;
  }

  char exec_path[4096];
  snprintf(exec_path, sizeof(exec_path), "%s", blob_path);

  if (B8G_ENTRY_EXT[0] != '\\0') {
    char link_path[4096];
    snprintf(link_path, sizeof(link_path), "%s" B8G_PATH_SEP "links" B8G_PATH_SEP "%s%s",
             cas_root, B8G_SHA512, B8G_ENTRY_EXT);
    if (!file_exists(link_path)) {
#ifdef _WIN32
      CreateHardLinkA(link_path, blob_path, NULL);
#else
      (void)link(blob_path, link_path);
#endif
    }
    if (file_exists(link_path)) {
      snprintf(exec_path, sizeof(exec_path), "%s", link_path);
    }
  }

  char runtime[4096];
  if (!find_runtime(runtime, sizeof(runtime))) {
    fprintf(stderr, "holo-exe: unable to locate node or b8g-node runtime\\n");
    return 127;
  }

  (void)B8G_ABI_MAGIC_V3;
  return run_runtime(runtime, exec_path, argc, argv);
#endif
}
`;
}

// ============================================================================
// Main Public API
// ============================================================================

/**
 * Compiles a JS/TS entry file into a native `ghost` (~20 KB) or `standalone`
 * executable backed by `CasV11Store` (`v11/files/XX/<sha512>`) and `bin/zig.cmd cc`.
 */
export function compileToExecutable(opts: CompileExeOptions): CompileExeResult {
  const startMs = performance.now();

  const entryPath = path.resolve(opts.entryPath);
  const outPath = path.resolve(opts.outPath);
  const appName = opts.appName.trim();
  const mode: CompileExeMode = opts.mode ?? 'ghost';
  const targetTriple = opts.targetTriple ?? 'x86_64-windows-gnu';

  if (!appName) {
    throw new Error('compileToExecutable: appName must be non-empty');
  }
  if (!fs.existsSync(entryPath)) {
    throw new Error(`compileToExecutable: entryPath does not exist: ${entryPath}`);
  }

  const payload = fs.readFileSync(entryPath);
  const entryExt = path.extname(entryPath) || '.mjs';
  const storeRoot = normalizeV11StoreRoot(opts.casStoreRoot);

  const store = new CasV11Store(storeRoot);
  let putResult;
  try {
    putResult = store.putBlob(payload, {
      kind: 'ghost',
      executable: false,
      meta: {
        appName,
        mode,
        entryExt,
        targetTriple,
        abiMagic: B8G_ABI_MAGIC_V3_HEX,
      },
    });
  } finally {
    store.close();
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const stubSource = generateC11Stub({
    mode,
    appName,
    sha512: putResult.sha512,
    casRoot: store.storeRoot,
    entryExt,
    defaultRuntime: process.execPath,
  });

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-compile-exe-'));
  const stubCPath = path.join(
    stagingDir,
    `stub-${process.pid}-${randomBytes(4).toString('hex')}.c`,
  );

  try {
    fs.writeFileSync(stubCPath, stubSource, 'utf8');

    const { command, useShell } = resolveZigCommand();
    const zigArgs = [
      'cc',
      '-Os',
      '-s',
      '-std=c11',
      '-target',
      targetTriple,
      stubCPath,
      '-o',
      outPath,
    ];

    const result = useShell
      ? spawnSync(
          `${quoteWinCmdArg(command)} ${zigArgs.map(quoteWinCmdArg).join(' ')}`,
          {
            shell: true,
            encoding: 'utf8',
            windowsHide: true,
          },
        )
      : spawnSync(command, zigArgs, {
          shell: false,
          encoding: 'utf8',
          windowsHide: true,
        });

    if (result.error) {
      throw new Error(
        `compileToExecutable: failed to invoke zig cc (${command}): ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim();
      const stdout = (result.stdout ?? '').trim();
      throw new Error(
        `compileToExecutable: zig cc exited with code ${result.status}\n${stderr || stdout}`,
      );
    }

    if (mode === 'standalone') {
      const footer = buildStandaloneFooter(payload);
      const fd = fs.openSync(outPath, 'a');
      try {
        fs.writeSync(fd, payload);
        fs.writeSync(fd, footer);
      } finally {
        fs.closeSync(fd);
      }
    }

    const binaryBytes = fs.statSync(outPath).size;
    const compileMs = Number((performance.now() - startMs).toFixed(2));

    return {
      outPath,
      mode,
      binaryBytes,
      payloadSha512: putResult.sha512,
      casBlobPath: putResult.path,
      compileMs,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
