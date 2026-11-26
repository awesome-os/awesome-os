/**
 * @file intersections/holo-compiler/cas-v11-store.mts
 * @description Universal pnpm-v12-compatible `v11` Content-Addressed Store (CAS).
 *
 * Unifies artifact storage across `holo-compiler`, `pnpm`, `cargo`, `b8g-rust`,
 * and `holo-ffi` under one canonical directory layout:
 *
 *   <storeRoot>/
 *     files/00..ff/<sha512>[-exec]   # exact pnpm v12 store-dir parity
 *     tmp/                           # atomic write staging area
 *     links/                         # hardlink projection staging
 *     projects/                      # project-scoped manifests/links
 *     index.db                       # WAL-mode SQLite metadata index (node:sqlite)
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

export const CAS_V11_VERSION = 'v11' as const;

export type CasV11BlobKind =
  | 'b8p'
  | 'npm'
  | 'cargo'
  | 'ghost'
  | 'object'
  | 'sidecar';

export interface PutBlobOptions {
  readonly kind?: CasV11BlobKind;
  readonly executable?: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface PutBlobResult {
  readonly sha512: string;
  readonly path: string;
  readonly size: number;
  readonly executable: boolean;
  readonly kind: CasV11BlobKind;
  readonly deduplicated: boolean;
}

export interface BlobRecord {
  readonly digest: string;
  readonly kind: CasV11BlobKind;
  readonly size: number;
  readonly executable: boolean;
  readonly createdAt: number;
  readonly meta: Record<string, unknown> | null;
}

export interface ProjectRecord {
  readonly path: string;
  readonly lastSeen: number;
}

export interface LinkBlobResult {
  readonly src: string;
  readonly dest: string;
  readonly method: 'hardlink' | 'copy';
}

export interface CasV11KindStats {
  readonly count: number;
  readonly bytes: number;
}

export interface CasV11Stats {
  readonly storeRoot: string;
  readonly version: typeof CAS_V11_VERSION;
  readonly backend: 'sqlite' | 'jsonl';
  readonly blobCount: number;
  readonly totalBytes: number;
  readonly executableCount: number;
  readonly projectCount: number;
  readonly byKind: Readonly<Record<string, CasV11KindStats>>;
}

export interface CasV11StoreOptions {
  /** Force JSON-line index fallback even when `node:sqlite` is available (primarily for tests). */
  readonly forceJsonlFallback?: boolean;
}

// ============================================================================
// Minimal `node:sqlite` structural types (zero external dependencies)
// ============================================================================

interface SqliteStatementSync {
  run(...params: ReadonlyArray<string | number | bigint | Uint8Array | null>): unknown;
  get(...params: ReadonlyArray<string | number | bigint | Uint8Array | null>): Record<string, unknown> | undefined;
  all(...params: ReadonlyArray<string | number | bigint | Uint8Array | null>): Array<Record<string, unknown>>;
}

interface SqliteDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementSync;
  close(): void;
}

interface SqliteModuleLike {
  DatabaseSync: new (location: string) => SqliteDatabaseSync;
}

const requireFn = createRequire(import.meta.url);

function loadNodeSqlite(): SqliteModuleLike | null {
  try {
    const mod = requireFn('node:sqlite') as Partial<SqliteModuleLike>;
    if (typeof mod?.DatabaseSync === 'function') {
      return mod as SqliteModuleLike;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Pure Path & Digest Helpers
// ============================================================================

function stripTrailingSeparators(dirPath: string): string {
  const parsed = path.parse(dirPath);
  if (dirPath === parsed.root) {
    return dirPath;
  }
  return dirPath.replace(/[\\/]+$/, '');
}

function appendV11WithoutDoubling(baseDir: string): string {
  const trimmed = stripTrailingSeparators(baseDir);
  if (path.basename(trimmed) === CAS_V11_VERSION) {
    return trimmed;
  }
  return path.join(trimmed, CAS_V11_VERSION);
}

/**
 * Resolves the canonical unified CAS `v11` store root directory:
 *   1. `HOLO_CAS_DIR`        -> `<HOLO_CAS_DIR>/v11`
 *   2. `B8G_CAS_DIR` -> `<B8G_CAS_DIR>/v11`
 *   3. `PNPM_HOME`           -> `<PNPM_HOME>/store/v11`
 *   4. Fallback              -> `~/.b8g/cas/v11`
 *
 * Ensures the `/v11` suffix is never doubled.
 */
export function resolveUnifiedCasRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const holoCasDir = env.HOLO_CAS_DIR?.trim();
  if (holoCasDir) {
    return appendV11WithoutDoubling(holoCasDir);
  }

  const ghostCacheDir = env.B8G_CAS_DIR?.trim();
  if (ghostCacheDir) {
    return appendV11WithoutDoubling(ghostCacheDir);
  }

  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) {
    const trimmed = stripTrailingSeparators(pnpmHome);
    const base = path.basename(trimmed);
    if (base === CAS_V11_VERSION) {
      return trimmed;
    }
    if (base === 'store') {
      return path.join(trimmed, CAS_V11_VERSION);
    }
    return path.join(trimmed, 'store', CAS_V11_VERSION);
  }

  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(stripTrailingSeparators(homeDir), '.b8g', 'cas', CAS_V11_VERSION);
}

/**
 * Computes the lowercase hexadecimal SHA-512 digest of a byte array or UTF-8 string.
 */
export function sha512Hex(data: Uint8Array | string): string {
  return createHash('sha512').update(data).digest('hex');
}

function normalizeSha512Digest(sha512: string): string {
  const normalized = sha512.trim().toLowerCase();
  if (!/^[0-9a-f]{2,}$/.test(normalized)) {
    throw new Error(`Invalid SHA-512 hex digest: "${sha512}"`);
  }
  return normalized;
}

/**
 * Computes the exact pnpm v12 `store-dir` blob path:
 * `<storeRoot>/files/<first2hex>/<sha512><executable ? '-exec' : ''>`
 */
export function casBlobPath(
  storeRoot: string,
  sha512: string,
  executable = false,
): string {
  const normalized = normalizeSha512Digest(sha512);
  const shard = normalized.slice(0, 2);
  const filename = executable ? `${normalized}-exec` : normalized;
  return path.join(storeRoot, 'files', shard, filename);
}

// ============================================================================
// JSON-Line Fallback Entry Types
// ============================================================================

interface JsonlBlobEntry {
  readonly type: 'blob';
  readonly digest: string;
  readonly kind: CasV11BlobKind;
  readonly size: number;
  readonly executable: number;
  readonly created_at: number;
  readonly meta_json: string | null;
}

interface JsonlProjectEntry {
  readonly type: 'project';
  readonly path: string;
  readonly last_seen: number;
}

type JsonlIndexEntry = JsonlBlobEntry | JsonlProjectEntry;

// ============================================================================
// CasV11Store
// ============================================================================

export class CasV11Store {
  readonly storeRoot: string;
  readonly filesDir: string;
  readonly tmpDir: string;
  readonly linksDir: string;
  readonly projectsDir: string;
  readonly indexDbPath: string;
  readonly fallbackIndexPath: string;

  private readonly forceJsonlFallback: boolean;
  private initialized: boolean;
  private backend: 'sqlite' | 'jsonl';
  private db: SqliteDatabaseSync | null;
  private readonly jsonlBlobs: Map<string, BlobRecord>;
  private readonly jsonlProjects: Map<string, ProjectRecord>;

  constructor(
    storeRoot: string = resolveUnifiedCasRoot(),
    options?: CasV11StoreOptions,
  ) {
    this.storeRoot = path.resolve(storeRoot);
    this.filesDir = path.join(this.storeRoot, 'files');
    this.tmpDir = path.join(this.storeRoot, 'tmp');
    this.linksDir = path.join(this.storeRoot, 'links');
    this.projectsDir = path.join(this.storeRoot, 'projects');
    this.indexDbPath = path.join(this.storeRoot, 'index.db');
    this.fallbackIndexPath = path.join(this.storeRoot, 'index.jsonl');

    this.forceJsonlFallback = options?.forceJsonlFallback === true;
    this.initialized = false;
    this.backend = 'jsonl';
    this.db = null;
    this.jsonlBlobs = new Map<string, BlobRecord>();
    this.jsonlProjects = new Map<string, ProjectRecord>();
  }

  /**
   * Ensures `<storeRoot>/{files,tmp,links,projects}` exist and opens the
   * WAL-mode SQLite `index.db` (or gracefully falls back to `index.jsonl`).
   */
  ensureLayout(): void {
    if (this.initialized) {
      return;
    }

    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(this.linksDir, { recursive: true });
    fs.mkdirSync(this.projectsDir, { recursive: true });

    const sqliteMod = this.forceJsonlFallback ? null : loadNodeSqlite();
    if (sqliteMod !== null) {
      try {
        const db = new sqliteMod.DatabaseSync(this.indexDbPath);
        db.exec('PRAGMA journal_mode=WAL;');
        db.exec('PRAGMA synchronous=NORMAL;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS blobs (
            digest TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            size INTEGER NOT NULL,
            executable INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            meta_json TEXT
          );
          CREATE TABLE IF NOT EXISTS projects (
            path TEXT PRIMARY KEY,
            last_seen INTEGER NOT NULL
          );
        `);
        this.db = db;
        this.backend = 'sqlite';
        this.initialized = true;
        return;
      } catch {
        // Fall through to JSON-line fallback if SQLite initialization fails.
        this.db = null;
      }
    }

    this.backend = 'jsonl';
    this.loadJsonlFallback();
    this.initialized = true;
  }

  private loadJsonlFallback(): void {
    this.jsonlBlobs.clear();
    this.jsonlProjects.clear();

    if (!fs.existsSync(this.fallbackIndexPath)) {
      return;
    }

    const content = fs.readFileSync(this.fallbackIndexPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as JsonlIndexEntry;
        if (entry.type === 'blob') {
          const existing = this.jsonlBlobs.get(entry.digest);
          const parsedMeta = entry.meta_json
            ? (JSON.parse(entry.meta_json) as Record<string, unknown>)
            : null;
          this.jsonlBlobs.set(entry.digest, {
            digest: entry.digest,
            kind: entry.kind,
            size: entry.size,
            executable: Boolean(entry.executable) || (existing?.executable ?? false),
            createdAt: existing?.createdAt ?? entry.created_at,
            meta: parsedMeta ?? existing?.meta ?? null,
          });
        } else if (entry.type === 'project') {
          this.jsonlProjects.set(entry.path, {
            path: entry.path,
            lastSeen: entry.last_seen,
          });
        }
      } catch {
        // Ignore truncated/corrupt trailing JSONL lines.
      }
    }
  }

  private appendJsonlEntry(entry: JsonlIndexEntry): void {
    fs.appendFileSync(this.fallbackIndexPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private recordBlobMeta(
    digest: string,
    kind: CasV11BlobKind,
    size: number,
    executable: boolean,
    meta: Record<string, unknown> | undefined,
  ): void {
    const createdAt = Date.now();
    const execInt = executable ? 1 : 0;
    const metaJson = meta !== undefined ? JSON.stringify(meta) : null;

    if (this.backend === 'sqlite' && this.db !== null) {
      const stmt = this.db.prepare(`
        INSERT INTO blobs (digest, kind, size, executable, created_at, meta_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(digest) DO UPDATE SET
          kind = excluded.kind,
          size = excluded.size,
          executable = MAX(blobs.executable, excluded.executable),
          meta_json = COALESCE(excluded.meta_json, blobs.meta_json)
      `);
      stmt.run(digest, kind, size, execInt, createdAt, metaJson);
      return;
    }

    const existing = this.jsonlBlobs.get(digest);
    const record: BlobRecord = {
      digest,
      kind,
      size,
      executable: executable || (existing?.executable ?? false),
      createdAt: existing?.createdAt ?? createdAt,
      meta: meta ?? existing?.meta ?? null,
    };
    this.jsonlBlobs.set(digest, record);
    this.appendJsonlEntry({
      type: 'blob',
      digest,
      kind,
      size,
      executable: execInt,
      created_at: record.createdAt,
      meta_json: metaJson,
    });
  }

  /**
   * Hashes `data` with SHA-512, stages to `tmp/<pid>-<rand>`, atomically renames
   * into `files/XX/<sha512>[-exec]` (idempotent deduplication if target already
   * exists), and records metadata in `index.db`.
   */
  putBlob(data: Uint8Array | string, opts?: PutBlobOptions): PutBlobResult {
    this.ensureLayout();

    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const kind: CasV11BlobKind = opts?.kind ?? 'object';
    const executable = opts?.executable === true;
    const digest = sha512Hex(bytes);
    const targetPath = casBlobPath(this.storeRoot, digest, executable);
    const shardDir = path.dirname(targetPath);

    fs.mkdirSync(shardDir, { recursive: true });

    const tmpName = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const tmpPath = path.join(this.tmpDir, tmpName);
    fs.writeFileSync(tmpPath, bytes);

    if (executable && process.platform !== 'win32') {
      fs.chmodSync(tmpPath, 0o755);
    }

    let deduplicated = false;
    if (fs.existsSync(targetPath)) {
      fs.rmSync(tmpPath, { force: true });
      deduplicated = true;
    } else {
      try {
        fs.renameSync(tmpPath, targetPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') && fs.existsSync(targetPath)) {
          fs.rmSync(tmpPath, { force: true });
          deduplicated = true;
        } else {
          fs.rmSync(tmpPath, { force: true });
          throw err;
        }
      }
    }

    this.recordBlobMeta(digest, kind, bytes.byteLength, executable, opts?.meta);

    return {
      sha512: digest,
      path: targetPath,
      size: bytes.byteLength,
      executable,
      kind,
      deduplicated,
    };
  }

  /**
   * Returns `true` if the content-addressed blob exists on disk.
   */
  hasBlob(sha512: string, executable = false): boolean {
    return fs.existsSync(casBlobPath(this.storeRoot, sha512, executable));
  }

  /**
   * Reads a content-addressed blob from disk, or returns `null` if absent.
   */
  getBlob(sha512: string, executable = false): Uint8Array | null {
    const blobPath = casBlobPath(this.storeRoot, sha512, executable);
    if (!fs.existsSync(blobPath)) {
      return null;
    }
    return fs.readFileSync(blobPath);
  }

  /**
   * Retrieves the indexed metadata record for a blob digest, or `null` if not indexed.
   */
  getBlobMeta(sha512: string): BlobRecord | null {
    this.ensureLayout();
    const digest = normalizeSha512Digest(sha512);

    if (this.backend === 'sqlite' && this.db !== null) {
      const row = this.db
        .prepare('SELECT digest, kind, size, executable, created_at, meta_json FROM blobs WHERE digest = ?')
        .get(digest);
      if (!row) {
        return null;
      }
      const metaJson = typeof row.meta_json === 'string' ? row.meta_json : null;
      return {
        digest: String(row.digest),
        kind: String(row.kind) as CasV11BlobKind,
        size: Number(row.size),
        executable: Number(row.executable) !== 0,
        createdAt: Number(row.created_at),
        meta: metaJson ? (JSON.parse(metaJson) as Record<string, unknown>) : null,
      };
    }

    return this.jsonlBlobs.get(digest) ?? null;
  }

  /**
   * Projects a blob from `files/XX/<sha512>[-exec]` to `destPath` using a hardlink
   * (`fs.linkSync`), automatically creating parent directories and falling back to
   * `fs.copyFileSync` when crossing filesystem boundaries (`EXDEV`).
   */
  linkBlobTo(sha512: string, destPath: string, executable = false): LinkBlobResult {
    const src = casBlobPath(this.storeRoot, sha512, executable);
    if (!fs.existsSync(src)) {
      throw new Error(`CAS blob not found: ${src}`);
    }

    const resolvedDest = path.resolve(destPath);
    fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });

    if (fs.existsSync(resolvedDest)) {
      const srcStat = fs.statSync(src);
      const destStat = fs.statSync(resolvedDest);
      if (srcStat.ino !== 0 && srcStat.ino === destStat.ino && srcStat.dev === destStat.dev) {
        return { src, dest: resolvedDest, method: 'hardlink' };
      }
      fs.rmSync(resolvedDest, { force: true });
    }

    try {
      fs.linkSync(src, resolvedDest);
      return { src, dest: resolvedDest, method: 'hardlink' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        fs.copyFileSync(src, resolvedDest);
        return { src, dest: resolvedDest, method: 'copy' };
      }
      throw err;
    }
  }

  /**
   * Records or updates a project directory in the `projects` table for GC reachability.
   */
  registerProject(projectDir: string): ProjectRecord {
    this.ensureLayout();
    const resolvedProject = path.resolve(projectDir);
    const lastSeen = Date.now();

    if (this.backend === 'sqlite' && this.db !== null) {
      this.db
        .prepare(`
          INSERT INTO projects (path, last_seen)
          VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET last_seen = excluded.last_seen
        `)
        .run(resolvedProject, lastSeen);
    } else {
      this.jsonlProjects.set(resolvedProject, {
        path: resolvedProject,
        lastSeen,
      });
      this.appendJsonlEntry({
        type: 'project',
        path: resolvedProject,
        last_seen: lastSeen,
      });
    }

    return { path: resolvedProject, lastSeen };
  }

  /**
   * Lists all registered projects ordered by most recently seen first.
   */
  listProjects(): ReadonlyArray<ProjectRecord> {
    this.ensureLayout();

    if (this.backend === 'sqlite' && this.db !== null) {
      const rows = this.db
        .prepare('SELECT path, last_seen FROM projects ORDER BY last_seen DESC')
        .all();
      return rows.map((row) => ({
        path: String(row.path),
        lastSeen: Number(row.last_seen),
      }));
    }

    return Array.from(this.jsonlProjects.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Returns aggregate statistics for the CAS store.
   */
  stats(): CasV11Stats {
    this.ensureLayout();

    const byKind: Record<string, CasV11KindStats> = {};
    let blobCount = 0;
    let totalBytes = 0;
    let executableCount = 0;
    let projectCount = 0;

    if (this.backend === 'sqlite' && this.db !== null) {
      const totals = this.db
        .prepare(`
          SELECT
            COUNT(*) AS blob_count,
            COALESCE(SUM(size), 0) AS total_bytes,
            COALESCE(SUM(CASE WHEN executable != 0 THEN 1 ELSE 0 END), 0) AS exec_count
          FROM blobs
        `)
        .get();
      blobCount = Number(totals?.blob_count ?? 0);
      totalBytes = Number(totals?.total_bytes ?? 0);
      executableCount = Number(totals?.exec_count ?? 0);

      const kindRows = this.db
        .prepare('SELECT kind, COUNT(*) AS cnt, COALESCE(SUM(size), 0) AS bytes FROM blobs GROUP BY kind')
        .all();
      for (const row of kindRows) {
        byKind[String(row.kind)] = {
          count: Number(row.cnt),
          bytes: Number(row.bytes),
        };
      }

      const projRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM projects').get();
      projectCount = Number(projRow?.cnt ?? 0);
    } else {
      for (const record of this.jsonlBlobs.values()) {
        blobCount += 1;
        totalBytes += record.size;
        if (record.executable) {
          executableCount += 1;
        }
        const prev = byKind[record.kind];
        byKind[record.kind] = {
          count: (prev?.count ?? 0) + 1,
          bytes: (prev?.bytes ?? 0) + record.size,
        };
      }
      projectCount = this.jsonlProjects.size;
    }

    return {
      storeRoot: this.storeRoot,
      version: CAS_V11_VERSION,
      backend: this.backend,
      blobCount,
      totalBytes,
      executableCount,
      projectCount,
      byKind,
    };
  }

  /**
   * Closes the underlying SQLite database handle if open.
   */
  close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }
}
