import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type WpPhpVersion = '8.2' | '8.3' | '8.4';

export interface WpEnvConfig {
  phpVersion: WpPhpVersion;
  core: string | null;
  multisite: boolean;
  port: number;
  plugins: string[];
  themes: string[];
  mappings: Record<string, string>;
  config: Record<string, string | number | boolean>;
}

export interface WpEnvInstance {
  id: string;
  tenantId: string;
  siteId: string;
  name: string;
  runtime: 'php-wasi';
  status: 'stopped' | 'running' | 'provisioning';
  dbEngine: 'sqlite-wasi';
  wasiMemoryMb: number;
  envConfig: WpEnvConfig;
  createdAt: string;
  updatedAt: string;
  lastStartedAt?: string;
}

export interface CreateWpEnvInput {
  tenantId: string;
  siteId: string;
  name: string;
  envConfig?: Partial<WpEnvConfig>;
  wasiMemoryMb?: number;
}

const VALID_PHP_VERSIONS = new Set<WpPhpVersion>(['8.2', '8.3', '8.4']);

const DEFAULT_WP_ENV_CONFIG: WpEnvConfig = {
  phpVersion: '8.3',
  core: null,
  multisite: false,
  port: 8888,
  plugins: [],
  themes: [],
  mappings: {},
  config: {
    WP_DEBUG: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizePhpVersion(value: unknown, fallback: WpPhpVersion): WpPhpVersion {
  if (typeof value === 'string' && VALID_PHP_VERSIONS.has(value as WpPhpVersion)) {
    return value as WpPhpVersion;
  }
  return fallback;
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0 && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function sanitizeMappings(
  value: unknown,
  base: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  if (isRecord(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string' && key.trim().length > 0 && val.trim().length > 0) {
        out[key] = val;
      }
    }
  }
  return out;
}

function sanitizeConfigMap(
  value: unknown,
  base: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { ...base };
  if (isRecord(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (
        key.trim().length > 0 &&
        (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')
      ) {
        out[key] = val;
      }
    }
  }
  return out;
}

function mergeWpEnvPartial(base: WpEnvConfig, patch: Record<string, unknown>): WpEnvConfig {
  const core =
    'core' in patch
      ? patch.core === null
        ? null
        : typeof patch.core === 'string'
          ? patch.core
          : base.core
      : base.core;

  const port =
    typeof patch.port === 'number' && Number.isInteger(patch.port) && patch.port > 0 && patch.port <= 65535
      ? patch.port
      : base.port;

  const multisite =
    typeof patch.multisite === 'boolean' ? patch.multisite : base.multisite;

  return {
    phpVersion: sanitizePhpVersion(patch.phpVersion, base.phpVersion),
    core,
    multisite,
    port,
    plugins: 'plugins' in patch ? sanitizeStringArray(patch.plugins, base.plugins) : [...base.plugins],
    themes: 'themes' in patch ? sanitizeStringArray(patch.themes, base.themes) : [...base.themes],
    mappings: sanitizeMappings(patch.mappings, base.mappings),
    config: sanitizeConfigMap(patch.config, base.config),
  };
}

function cloneConfig(cfg: WpEnvConfig): WpEnvConfig {
  return {
    phpVersion: cfg.phpVersion,
    core: cfg.core,
    multisite: cfg.multisite,
    port: cfg.port,
    plugins: [...cfg.plugins],
    themes: [...cfg.themes],
    mappings: { ...cfg.mappings },
    config: { ...cfg.config },
  };
}

function cloneInstance(env: WpEnvInstance): WpEnvInstance {
  return {
    ...env,
    envConfig: cloneConfig(env.envConfig),
  };
}

function escapePhpSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatPhpLiteral(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0';
  }
  return `'${escapePhpSingleQuoted(value)}'`;
}

function sanitizeEnvIdForPath(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid WpEnv id: ${id}`);
  }
  return cleaned;
}

function deriveArtifactSlug(source: string): string {
  const normalized = source.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? 'artifact';
  const stripped = base.replace(/\.(zip|tar\.gz|tgz|php)$/i, '');
  const slug = stripped.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'artifact';
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Parse and merge `.wp-env.json` with an optional `.wp-env.override.json`,
 * applying safe WASI-friendly defaults.
 */
export function parseWpEnvJson(rawJson: string, overrideJson?: string): WpEnvConfig {
  const parsedRaw: unknown = rawJson.trim().length > 0 ? JSON.parse(rawJson) : {};
  if (!isRecord(parsedRaw)) {
    throw new Error('Invalid .wp-env.json: root must be a JSON object');
  }

  let merged = mergeWpEnvPartial(cloneConfig(DEFAULT_WP_ENV_CONFIG), parsedRaw);

  if (overrideJson !== undefined && overrideJson.trim().length > 0) {
    const parsedOverride: unknown = JSON.parse(overrideJson);
    if (!isRecord(parsedOverride)) {
      throw new Error('Invalid .wp-env.override.json: root must be a JSON object');
    }
    merged = mergeWpEnvPartial(merged, parsedOverride);
  }

  return merged;
}

/**
 * Emit a clean `wp-config.php` for a php-wasi + sqlite-wasi WordPress instance.
 */
export function generateWpConfigPhp(env: WpEnvInstance): string {
  const lines: string[] = [
    '<?php',
    '/**',
    ` * Generated by B8G WpEnvWasiManager`,
    ` * Environment: ${env.name} (${env.id})`,
    ` * Runtime: ${env.runtime} (PHP ${env.envConfig.phpVersion}) | DB: ${env.dbEngine}`,
    ' */',
    '',
    '// SQLite WASI drop-in database configuration (zero Docker / MySQL dependency)',
    "define( 'DB_ENGINE', 'sqlite' );",
    `define( 'DB_DIR', '/wasi/wp-envs/${escapePhpSingleQuoted(env.id)}/db/' );`,
    "define( 'DB_FILE', 'wp.sqlite' );",
    "define( 'USE_MYSQL', false );",
    "define( 'DB_NAME', 'wp_wasi_sqlite' );",
    "define( 'DB_USER', 'wasi' );",
    "define( 'DB_PASSWORD', '' );",
    "define( 'DB_HOST', 'localhost' );",
    "define( 'DB_CHARSET', 'utf8mb4' );",
    "define( 'DB_COLLATE', '' );",
    '',
  ];

  const definedKeys = new Set<string>([
    'DB_ENGINE',
    'DB_DIR',
    'DB_FILE',
    'USE_MYSQL',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'DB_HOST',
    'DB_CHARSET',
    'DB_COLLATE',
  ]);

  const configEntries = Object.entries(env.envConfig.config);
  if (configEntries.length > 0) {
    lines.push('// Environment constants');
    for (const [key, value] of configEntries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        continue;
      }
      if (definedKeys.has(key)) {
        continue;
      }
      definedKeys.add(key);
      lines.push(`define( '${key}', ${formatPhpLiteral(value)} );`);
    }
    lines.push('');
  }

  if (env.envConfig.multisite) {
    lines.push('// WordPress Multisite configuration');
    if (!definedKeys.has('WP_ALLOW_MULTISITE')) {
      lines.push("define( 'WP_ALLOW_MULTISITE', true );");
    }
    if (!definedKeys.has('MULTISITE')) {
      lines.push("define( 'MULTISITE', true );");
    }
    if (!definedKeys.has('SUBDOMAIN_INSTALL')) {
      lines.push("define( 'SUBDOMAIN_INSTALL', false );");
    }
    if (!definedKeys.has('DOMAIN_CURRENT_SITE')) {
      lines.push(`define( 'DOMAIN_CURRENT_SITE', 'localhost:${env.envConfig.port}' );`);
    }
    if (!definedKeys.has('PATH_CURRENT_SITE')) {
      lines.push("define( 'PATH_CURRENT_SITE', '/' );");
    }
    if (!definedKeys.has('SITE_ID_CURRENT_SITE')) {
      lines.push("define( 'SITE_ID_CURRENT_SITE', 1 );");
    }
    if (!definedKeys.has('BLOG_ID_CURRENT_SITE')) {
      lines.push("define( 'BLOG_ID_CURRENT_SITE', 1 );");
    }
    lines.push('');
  }

  lines.push("$table_prefix = 'wp_';");
  lines.push('');
  lines.push("if ( ! defined( 'ABSPATH' ) ) {");
  lines.push("    define( 'ABSPATH', __DIR__ . '/' );");
  lines.push('}');
  lines.push('');
  lines.push("require_once ABSPATH . 'wp-settings.php';");
  lines.push('');

  return lines.join('\n');
}

interface PersistedWpEnvsStore {
  version: 1;
  envs: WpEnvInstance[];
}

export class WpEnvWasiManager {
  private readonly dataDir: string;
  private readonly storePath: string;
  private readonly envs: Map<string, WpEnvInstance>;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.storePath = path.join(this.dataDir, 'wp-envs.json');
    this.envs = new Map<string, WpEnvInstance>();
    this.loadOrSeed();
  }

  private loadOrSeed(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });

    if (fs.existsSync(this.storePath)) {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && Array.isArray(parsed.envs)) {
        for (const item of parsed.envs) {
          if (isRecord(item) && typeof item.id === 'string') {
            this.envs.set(item.id, cloneInstance(item as unknown as WpEnvInstance));
          }
        }
      }
    }

    if (this.envs.size === 0) {
      const now = new Date().toISOString();
      const seeded: WpEnvInstance = {
        id: 'awesome-os-wp-wasi',
        tenantId: 'default',
        siteId: 'awesome-os-site',
        name: 'awesome-os-wp-wasi',
        runtime: 'php-wasi',
        status: 'stopped',
        dbEngine: 'sqlite-wasi',
        wasiMemoryMb: 256,
        envConfig: {
          phpVersion: '8.3',
          core: 'latest',
          multisite: true,
          port: 8888,
          plugins: [],
          themes: [],
          mappings: {},
          config: {
            WP_DEBUG: true,
          },
        },
        createdAt: now,
        updatedAt: now,
      };
      this.envs.set(seeded.id, seeded);
      this.persist();
    }
  }

  private persist(): void {
    const payload: PersistedWpEnvsStore = {
      version: 1,
      envs: Array.from(this.envs.values()),
    };
    atomicWriteFileSync(this.storePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private requireEnv(id: string): WpEnvInstance {
    const env = this.envs.get(id);
    if (!env) {
      throw new Error(`WpEnv instance not found: ${id}`);
    }
    return env;
  }

  public getEnvDir(id: string): string {
    return path.join(this.dataDir, 'wp-envs', sanitizeEnvIdForPath(id));
  }

  private materializeEnvFiles(env: WpEnvInstance): void {
    const envDir = this.getEnvDir(env.id);
    const dbDir = path.join(envDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });

    const wpConfigPhp = generateWpConfigPhp(env);
    atomicWriteFileSync(path.join(envDir, 'wp-config.php'), wpConfigPhp);
    atomicWriteFileSync(
      path.join(envDir, '.wp-env.json'),
      `${JSON.stringify(env.envConfig, null, 2)}\n`,
    );

    const dbFile = path.join(dbDir, 'wp.sqlite');
    if (!fs.existsSync(dbFile)) {
      atomicWriteFileSync(dbFile, '');
    }
  }

  public listEnvs(tenantId?: string): WpEnvInstance[] {
    const all = Array.from(this.envs.values());
    const filtered = tenantId !== undefined ? all.filter((e) => e.tenantId === tenantId) : all;
    return filtered.map(cloneInstance);
  }

  public getEnv(id: string): WpEnvInstance | undefined {
    const found = this.envs.get(id);
    return found ? cloneInstance(found) : undefined;
  }

  public createEnv(input: CreateWpEnvInput): WpEnvInstance {
    const now = new Date().toISOString();
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const id = `${slug || 'wp-env'}-${crypto.randomBytes(4).toString('hex')}`;

    const envConfig = mergeWpEnvPartial(
      cloneConfig(DEFAULT_WP_ENV_CONFIG),
      (input.envConfig ?? {}) as Record<string, unknown>,
    );

    const instance: WpEnvInstance = {
      id,
      tenantId: input.tenantId,
      siteId: input.siteId,
      name: input.name,
      runtime: 'php-wasi',
      status: 'stopped',
      dbEngine: 'sqlite-wasi',
      wasiMemoryMb:
        typeof input.wasiMemoryMb === 'number' && input.wasiMemoryMb > 0
          ? Math.floor(input.wasiMemoryMb)
          : 256,
      envConfig,
      createdAt: now,
      updatedAt: now,
    };

    this.envs.set(id, instance);
    this.persist();
    return cloneInstance(instance);
  }

  public startEnv(id: string): WpEnvInstance {
    const env = this.requireEnv(id);
    const now = new Date().toISOString();
    env.status = 'running';
    env.lastStartedAt = now;
    env.updatedAt = now;
    this.materializeEnvFiles(env);
    this.persist();
    return cloneInstance(env);
  }

  public stopEnv(id: string): WpEnvInstance {
    const env = this.requireEnv(id);
    env.status = 'stopped';
    env.updatedAt = new Date().toISOString();
    this.persist();
    return cloneInstance(env);
  }

  public updateEnvConfig(id: string, patch: Partial<WpEnvConfig>): WpEnvInstance {
    const env = this.requireEnv(id);
    env.envConfig = mergeWpEnvPartial(env.envConfig, patch as Record<string, unknown>);
    env.updatedAt = new Date().toISOString();
    if (env.status === 'running') {
      this.materializeEnvFiles(env);
    }
    this.persist();
    return cloneInstance(env);
  }

  public mountArtifact(id: string, kind: 'plugin' | 'theme', source: string): WpEnvInstance {
    const env = this.requireEnv(id);
    const trimmed = source.trim();
    if (!trimmed) {
      throw new Error('Artifact source must be a non-empty string');
    }

    const list = kind === 'plugin' ? env.envConfig.plugins : env.envConfig.themes;
    if (!list.includes(trimmed)) {
      list.push(trimmed);
    }

    const vfsSubdir = kind === 'plugin' ? 'wp-content/plugins' : 'wp-content/themes';
    const slug = deriveArtifactSlug(trimmed);
    if (!(trimmed in env.envConfig.mappings)) {
      env.envConfig.mappings[trimmed] = `${vfsSubdir}/${slug}`;
    }

    env.updatedAt = new Date().toISOString();
    if (env.status === 'running') {
      this.materializeEnvFiles(env);
    }
    this.persist();
    return cloneInstance(env);
  }

  public resetDatabase(id: string): { ok: true; id: string; resetAt: string } {
    const env = this.requireEnv(id);
    const resetAt = new Date().toISOString();
    const dbDir = path.join(this.getEnvDir(env.id), 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    atomicWriteFileSync(path.join(dbDir, 'wp.sqlite'), '');
    atomicWriteFileSync(
      path.join(dbDir, 'reset-meta.json'),
      `${JSON.stringify({ id: env.id, dbEngine: env.dbEngine, resetAt }, null, 2)}\n`,
    );

    env.updatedAt = resetAt;
    this.persist();
    return { ok: true, id: env.id, resetAt };
  }

  public exportWpEnvJson(id: string): string {
    const env = this.requireEnv(id);
    return `${JSON.stringify(env.envConfig, null, 2)}\n`;
  }
}
