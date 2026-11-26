/**
 * @file sections/sectium-maintenance/cyclic-builder.mts
 * @description Micro-Cycle Resumable Chromium/Sectium Shard Builder + .b8p CAS Packer.
 * Breaks monolithic multi-hour builds into small, crash-resilient buckets (e.g. zlib,
 * boringssl, icu, base, mojo, v8, net, skia, viz, blink, content, chrome) that compile
 * in short micro-cycles, pack outputs into SHA-256 .b8p archives immediately, and
 * resume cleanly across crashes or restarts with zero lost progress.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = resolve(__dirname, '..', '..');

export interface CyclicBucketSpec {
  readonly id: string;
  readonly ninjaTarget: string;
  readonly outputGlobDir: string;
  readonly order: number;
}

export interface CyclicBucketState {
  readonly id: string;
  readonly ninjaTarget: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  b8pPath?: string;
  sha256?: string;
  packedFiles?: number;
  packedBytes?: number;
  elapsedMs?: number;
  updatedAt?: string;
  error?: string;
}

export interface CyclicStateFile {
  readonly schema: 'b8g-cyclic-build-v1';
  readonly outDir: string;
  readonly casDir: string;
  readonly updatedAt: string;
  readonly buckets: CyclicBucketState[];
}

export const SECTIUM_CYCLIC_BUCKETS: readonly CyclicBucketSpec[] = [
  { id: '01-zlib',           ninjaTarget: 'third_party/zlib:zlib',              outputGlobDir: 'obj/third_party/zlib',        order: 1 },
  { id: '02-boringssl',      ninjaTarget: 'third_party/boringssl:boringssl',    outputGlobDir: 'obj/third_party/boringssl',   order: 2 },
  { id: '03-icu',            ninjaTarget: 'third_party/icu:icu',                outputGlobDir: 'obj/third_party/icu',         order: 3 },
  { id: '04-base',           ninjaTarget: 'base:base',                          outputGlobDir: 'obj/base',                    order: 4 },
  { id: '05-mojo',           ninjaTarget: 'mojo/public/cpp/bindings:bindings',  outputGlobDir: 'obj/mojo',                    order: 5 },
  { id: '06-net',            ninjaTarget: 'net:net',                            outputGlobDir: 'obj/net',                     order: 6 },
  { id: '07-v8',             ninjaTarget: 'v8:v8',                              outputGlobDir: 'obj/v8',                      order: 7 },
  { id: '08-skia',           ninjaTarget: 'skia:skia',                          outputGlobDir: 'obj/skia',                    order: 8 },
  { id: '09-cc-viz',         ninjaTarget: 'cc:cc',                              outputGlobDir: 'obj/cc',                      order: 9 },
  { id: '10-blink-platform', ninjaTarget: 'third_party/blink/renderer/platform:platform', outputGlobDir: 'obj/third_party/blink/renderer/platform', order: 10 },
  { id: '11-blink-core',     ninjaTarget: 'third_party/blink/renderer/core:core',         outputGlobDir: 'obj/third_party/blink/renderer/core',     order: 11 },
  { id: '12-content',        ninjaTarget: 'content/public/browser:browser',     outputGlobDir: 'obj/content',                 order: 12 },
  { id: '13-chrome-dll',     ninjaTarget: 'chrome:chrome_dll',                  outputGlobDir: 'obj/chrome',                  order: 13 },
  { id: '14-sectium-exe',    ninjaTarget: 'chrome:chrome',                      outputGlobDir: '.',                           order: 14 },
];

interface PackedEntry {
  readonly relPath: string;
  readonly base64: string;
}

interface B8pBucketArchive {
  readonly magic: 'B8PB';
  readonly version: 1;
  readonly bucketId: string;
  readonly ninjaTarget: string;
  readonly entries: PackedEntry[];
}

const PACKABLE_EXTS = new Set(['.obj', '.o', '.lib', '.a', '.dll', '.so', '.pak', '.bin']);

function collectPackableFiles(dirPath: string, rootDir: string, out: string[], maxFiles: number = 500): void {
  if (!existsSync(dirPath) || out.length >= maxFiles) return;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (out.length >= maxFiles) return;
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (dirPath === rootDir && entry.name !== 'obj') continue;
      collectPackableFiles(full, rootDir, out, maxFiles);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : '';
      if (PACKABLE_EXTS.has(ext)) {
        out.push(full);
      }
    }
  }
}

export function packBucketToB8p(
  bucket: CyclicBucketSpec,
  outDir: string,
  casDir: string,
): { b8pPath: string; sha256: string; packedFiles: number; packedBytes: number } {
  mkdirSync(casDir, { recursive: true });
  const scanDir = join(outDir, bucket.outputGlobDir);
  const files: string[] = [];
  const maxFiles = bucket.outputGlobDir === '.' ? 20 : 250;
  collectPackableFiles(scanDir, outDir, files, maxFiles);

  // True raw binary framing (zero base64, zero V8 string-length limit):
  // [4B "B8PB"][4B version=2][4B count] + per entry: [4B pathLen][pathBytes][4B dataLen][rawBytes]
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('B8PB', 0, 4, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(files.length, 8);
  chunks.push(header);

  for (const abs of files) {
    const rel = relative(outDir, abs).replaceAll('\\', '/');
    const pathBuf = Buffer.from(rel, 'utf8');
    const dataBuf = readFileSync(abs);
    const meta = Buffer.alloc(8);
    meta.writeUInt32LE(pathBuf.length, 0);
    meta.writeUInt32LE(dataBuf.length, 4);
    chunks.push(meta, pathBuf, dataBuf);
  }

  const raw = Buffer.concat(chunks);
  const gz = gzipSync(raw, { level: 1 });
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const b8pPath = join(casDir, `${bucket.id}-${sha256.slice(0, 12)}.b8p`);
  writeFileSync(b8pPath, gz);

  return {
    b8pPath,
    sha256,
    packedFiles: files.length,
    packedBytes: statSync(b8pPath).size,
  };
}

export function restoreBucketFromB8p(b8pPath: string, expectedSha256: string, outDir: string): number {
  const gz = readFileSync(b8pPath);
  const actualSha = createHash('sha256').update(gz).digest('hex');
  if (actualSha !== expectedSha256) {
    throw new Error(`[cyclic-builder] SHA-256 mismatch for ${b8pPath}: expected ${expectedSha256}, got ${actualSha}`);
  }
  const raw = gunzipSync(gz);
  if (raw.length < 12 || raw.subarray(0, 4).toString('ascii') !== 'B8PB' || raw.readUInt32LE(4) !== 2) {
    throw new Error(`[cyclic-builder] Invalid binary .b8p bucket archive header in ${b8pPath}`);
  }
  const count = raw.readUInt32LE(8);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const pathLen = raw.readUInt32LE(pos);
    const dataLen = raw.readUInt32LE(pos + 4);
    pos += 8;
    const relPath = raw.subarray(pos, pos + pathLen).toString('utf8');
    pos += pathLen;
    const data = raw.subarray(pos, pos + dataLen);
    pos += dataLen;

    const dst = resolve(outDir, relPath);
    if (!dst.startsWith(resolve(outDir))) {
      throw new Error(`[cyclic-builder] Path traversal blocked in .b8p archive: ${relPath}`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, data);
  }
  return count;
}

/**
 * Adaptively splits an oversized bucket (exceeding `maxShardBytes` or `maxCycleMs`)
 * into N smaller sub-shards so every runner micro-cycle stays fast and cache-friendly.
 */
export function splitOversizedBucket(
  bucket: CyclicBucketSpec,
  subDirNames: readonly string[],
): CyclicBucketSpec[] {
  if (subDirNames.length <= 1) return [bucket];
  return subDirNames.map((sub, idx) => ({
    id: `${bucket.id}-${String.fromCharCode(97 + (idx % 26))}-${sub}`,
    ninjaTarget: `${bucket.ninjaTarget}_${sub}`,
    outputGlobDir: `${bucket.outputGlobDir}/${sub}`,
    order: bucket.order + (idx + 1) / (subDirNames.length + 1),
  }));
}

export function loadOrInitCyclicState(
  statePath: string,
  outDir: string,
  casDir: string,
  buckets: readonly CyclicBucketSpec[] = SECTIUM_CYCLIC_BUCKETS,
): CyclicStateFile {
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf8')) as CyclicStateFile;
  }
  const state: CyclicStateFile = {
    schema: 'b8g-cyclic-build-v1',
    outDir,
    casDir,
    updatedAt: new Date().toISOString(),
    buckets: buckets.map((b) => ({
      id: b.id,
      ninjaTarget: b.ninjaTarget,
      status: 'PENDING',
    })),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function saveCyclicState(statePath: string, state: CyclicStateFile): void {
  const next: CyclicStateFile = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export interface StepOptions {
  readonly statePath: string;
  readonly outDir: string;
  readonly casDir: string;
  readonly buckets?: readonly CyclicBucketSpec[];
  readonly maxBucketsPerCycle?: number;
  readonly dryRun?: boolean;
  readonly runner?: (bucket: CyclicBucketSpec, outDir: string) => { ok: boolean; error?: string };
}

export interface StepReport {
  readonly completedThisCycle: string[];
  readonly totalDone: number;
  readonly totalBuckets: number;
  readonly allDone: boolean;
}

export interface GravityBounceDecision {
  readonly shouldBounce: boolean;
  readonly heightPct: number;
  readonly bounceNum: number;
  readonly nextBounce: number;
  readonly reason: 'GROUNDED_ALL_DONE' | 'BOUNCE_NEXT_CYCLE' | 'STOPPED_NO_PROGRESS' | 'STOPPED_MAX_BOUNCES';
}

/**
 * Damped Gravity Scheduler: computes whether the cyclic build ball should bounce
 * into another runner micro-cycle or come to rest on the ground.
 * Strictly convergent: stops immediately on allDone, zero progress, or maxBounces.
 */
export function computeGravityBounce(
  report: StepReport,
  bounceNum: number,
  maxBounces: number = 20,
): GravityBounceDecision {
  const remaining = Math.max(0, report.totalBuckets - report.totalDone);
  const heightPct = report.totalBuckets > 0 ? Math.round((remaining / report.totalBuckets) * 100) : 0;

  if (report.allDone || remaining === 0) {
    return { shouldBounce: false, heightPct: 0, bounceNum, nextBounce: bounceNum, reason: 'GROUNDED_ALL_DONE' };
  }
  if (report.completedThisCycle.length === 0) {
    return { shouldBounce: false, heightPct, bounceNum, nextBounce: bounceNum, reason: 'STOPPED_NO_PROGRESS' };
  }
  if (bounceNum >= maxBounces) {
    return { shouldBounce: false, heightPct, bounceNum, nextBounce: bounceNum, reason: 'STOPPED_MAX_BOUNCES' };
  }
  return {
    shouldBounce: true,
    heightPct,
    bounceNum,
    nextBounce: bounceNum + 1,
    reason: 'BOUNCE_NEXT_CYCLE',
  };
}

export function runCyclicStep(opts: StepOptions): StepReport {
  const specs = opts.buckets ?? SECTIUM_CYCLIC_BUCKETS;
  const maxPerCycle = opts.maxBucketsPerCycle ?? 1;
  const state = loadOrInitCyclicState(opts.statePath, opts.outDir, opts.casDir, specs);
  const completedThisCycle: string[] = [];

  for (const bucketState of state.buckets) {
    if (completedThisCycle.length >= maxPerCycle) break;
    if (bucketState.status === 'DONE') continue;

    const spec = specs.find((s) => s.id === bucketState.id);
    if (!spec) continue;

    const t0 = performance.now();
    let ok = true;
    let errMsg = '';

    if (opts.dryRun) {
      ok = true;
    } else if (opts.runner) {
      const res = opts.runner(spec, opts.outDir);
      ok = res.ok;
      errMsg = res.error ?? '';
    } else {
      const ninjaBin = process.platform === 'win32' ? 'ninja.exe' : 'ninja';
      const res = spawnSync(ninjaBin, ['-C', opts.outDir, spec.ninjaTarget], {
        stdio: 'inherit',
        shell: false,
      });
      ok = (res.status ?? 1) === 0;
      if (!ok) errMsg = res.error ? res.error.message : `ninja exited with code ${String(res.status)}`;
    }

    const elapsedMs = Math.round(performance.now() - t0);
    if (ok) {
      const packed = packBucketToB8p(spec, opts.outDir, opts.casDir);
      bucketState.status = 'DONE';
      bucketState.b8pPath = packed.b8pPath;
      bucketState.sha256 = packed.sha256;
      bucketState.packedFiles = packed.packedFiles;
      bucketState.packedBytes = packed.packedBytes;
      bucketState.elapsedMs = elapsedMs;
      bucketState.updatedAt = new Date().toISOString();
      delete bucketState.error;
      completedThisCycle.push(bucketState.id);
    } else {
      bucketState.status = 'FAILED';
      bucketState.elapsedMs = elapsedMs;
      bucketState.error = errMsg;
      bucketState.updatedAt = new Date().toISOString();
      saveCyclicState(opts.statePath, state);
      break;
    }

    saveCyclicState(opts.statePath, state);
  }

  const totalDone = state.buckets.filter((b) => b.status === 'DONE').length;
  return {
    completedThisCycle,
    totalDone,
    totalBuckets: state.buckets.length,
    allDone: totalDone === state.buckets.length,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] ?? 'status';
  const outDir = process.env.SECTIUM_OUT_DIR ?? 'E:\\b8g-chromium-real\\src\\out\\B8gRelease';
  const casDir = join(WORKSPACE_ROOT, '.b8g-cas', 'sectium-cyclic');
  const statePath = join(__dirname, 'dist', 'cyclic-state.json');

  if (cmd === 'status') {
    const state = loadOrInitCyclicState(statePath, outDir, casDir);
    const done = state.buckets.filter((b) => b.status === 'DONE').length;
    console.log(`[cyclic-builder] Progress: ${done}/${state.buckets.length} buckets DONE (outDir=${state.outDir})\n`);
    for (const b of state.buckets) {
      const extra = b.status === 'DONE'
        ? `files=${b.packedFiles ?? 0} size=${((b.packedBytes ?? 0) / 1024).toFixed(1)} KB`
        : b.error ?? '';
      console.log(`  [${b.status.padEnd(7)}] ${b.id.padEnd(18)} ${b.ninjaTarget.padEnd(46)} ${extra}`);
    }
  } else if (cmd === 'step') {
    const dryRun = process.argv.includes('--dry-run');
    const countIdx = process.argv.indexOf('--buckets');
    const maxBucketsPerCycle = countIdx >= 0 ? Math.max(1, Number(process.argv[countIdx + 1] ?? 1)) : 1;
    const bounceIdx = process.argv.indexOf('--bounce');
    const bounceNum = bounceIdx >= 0 ? Math.max(1, Number(process.argv[bounceIdx + 1] ?? 1)) : 1;
    const maxBounceIdx = process.argv.indexOf('--max-bounces');
    const maxBounces = maxBounceIdx >= 0 ? Math.max(1, Number(process.argv[maxBounceIdx + 1] ?? 14)) : 14;
    const report = runCyclicStep({ statePath, outDir, casDir, maxBucketsPerCycle, dryRun });
    const decision = computeGravityBounce(report, bounceNum, maxBounces);
    console.log(
      `[cyclic-builder] Drop #${bounceNum} (${dryRun ? 'dry-run' : 'live'}): +${report.completedThisCycle.length} [${report.completedThisCycle.join(', ')}] -> ${report.totalDone}/${report.totalBuckets} DONE | height=${decision.heightPct}% | ${decision.reason}`,
    );
    if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
      const lines = [
        `should_bounce=${decision.shouldBounce}`,
        `next_bounce=${decision.nextBounce}`,
        `height_pct=${decision.heightPct}`,
        `reason=${decision.reason}`,
      ].join('\n') + '\n';
      writeFileSync(process.env.GITHUB_OUTPUT, lines, { flag: 'a' });
    }
  } else {
    console.log('Usage: cyclic-builder.mts <status | step [--dry-run] [--buckets N]>');
  }
}
