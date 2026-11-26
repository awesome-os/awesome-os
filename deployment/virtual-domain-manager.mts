#!/usr/bin/env node
/**
 * @file virtual-domain-manager.mts
 * @description Plan 9 / Linux mount(2)-style Virtual Domain Manager for Awesome-OS.
 * Mounts repository://, workspaces://, cas://v11/, pipe://, and local assets onto
 * arbitrary domains, subdomains, and URL paths with longest-prefix resolution,
 * A/B slot atomic promote/rollback, nginx emitter, and browser OPFS route export.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MountSourceKind = 'repository' | 'workspaces' | 'cas-v11' | 'pipe' | 'local';

export interface DomainMount {
  id: string;
  host: string;       // e.g. "awesome-os.com", "ide.b8g.dev", "ai.b8g.app"
  pathPrefix: string; // normalized leading slash, e.g. "/install/"
  activeSlot: 'A' | 'B';
  slots: {
    A: string; // source URI (repository://, workspaces://, cas://v11/, pipe://, file://)
    B?: string;
  };
  kind: MountSourceKind;
  cacheControl?: string;
  description?: string;
}

export interface VirtualDomainTable {
  schema: 'awesome-os.virtual-domains.v1';
  abiMagic: '0x33564742';
  casLayout: 'v11';
  updatedAt: string;
  mounts: DomainMount[];
}

export interface ResolvedMount {
  mount: DomainMount;
  activeSource: string;
  matchedHost: string;
  matchedPrefix: string;
  relativePath: string;
}

export function normalizePathPrefix(p: string): string {
  let out = p.trim();
  if (!out.startsWith('/')) out = '/' + out;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function detectSourceKind(sourceUri: string): MountSourceKind {
  if (sourceUri.startsWith('repository://')) return 'repository';
  if (sourceUri.startsWith('workspaces://')) return 'workspaces';
  if (sourceUri.startsWith('cas://')) return 'cas-v11';
  if (sourceUri.startsWith('pipe://')) return 'pipe';
  return 'local';
}

export class VirtualDomainManager {
  #table: VirtualDomainTable;

  constructor(table?: VirtualDomainTable) {
    this.#table = table ?? {
      schema: 'awesome-os.virtual-domains.v1',
      abiMagic: '0x33564742',
      casLayout: 'v11',
      updatedAt: new Date().toISOString(),
      mounts: [],
    };
  }

  static fromFile(filePath: string): VirtualDomainManager {
    return new VirtualDomainManager(JSON.parse(readFileSync(filePath, 'utf8')) as VirtualDomainTable);
  }

  saveToFile(filePath: string): void {
    this.#table.updatedAt = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(this.#table, null, 2) + '\n', 'utf8');
  }

  list(): readonly DomainMount[] {
    return this.#table.mounts;
  }

  mount(input: {
    host: string;
    pathPrefix: string;
    sourceUri: string;
    description?: string;
    cacheControl?: string;
  }): DomainMount {
    const host = input.host.trim().toLowerCase();
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const id = `${host}${pathPrefix}`;
    const existing = this.#table.mounts.find((m) => m.id === id);
    if (existing) {
      // Stage into inactive slot and keep active slot untouched until promoted, or overwrite if identical
      const nextSlot: 'A' | 'B' = existing.activeSlot === 'A' ? 'B' : 'A';
      existing.slots[nextSlot] = input.sourceUri;
      existing.kind = detectSourceKind(input.sourceUri);
      if (input.description) existing.description = input.description;
      this.#table.updatedAt = new Date().toISOString();
      return existing;
    }

    const entry: DomainMount = {
      id,
      host,
      pathPrefix,
      activeSlot: 'A',
      slots: { A: input.sourceUri },
      kind: detectSourceKind(input.sourceUri),
      cacheControl: input.cacheControl ?? (input.sourceUri.startsWith('cas://') ? 'public, max-age=31536000, immutable' : 'public, max-age=60'),
      description: input.description,
    };
    this.#table.mounts.push(entry);
    this.#table.updatedAt = new Date().toISOString();
    return entry;
  }

  unmount(host: string, pathPrefix: string): boolean {
    const id = `${host.trim().toLowerCase()}${normalizePathPrefix(pathPrefix)}`;
    const before = this.#table.mounts.length;
    this.#table.mounts = this.#table.mounts.filter((m) => m.id !== id);
    return this.#table.mounts.length < before;
  }

  promote(host: string, pathPrefix: string): DomainMount {
    const id = `${host.trim().toLowerCase()}${normalizePathPrefix(pathPrefix)}`;
    const m = this.#table.mounts.find((x) => x.id === id);
    if (!m) throw new Error(`Mount not found: ${id}`);
    const nextSlot: 'A' | 'B' = m.activeSlot === 'A' ? 'B' : 'A';
    if (!m.slots[nextSlot]) throw new Error(`No staged source in Slot ${nextSlot} for ${id}`);
    m.activeSlot = nextSlot;
    m.kind = detectSourceKind(m.slots[nextSlot]!);
    this.#table.updatedAt = new Date().toISOString();
    return m;
  }

  rollback(host: string, pathPrefix: string): DomainMount {
    return this.promote(host, pathPrefix);
  }

  resolveUrl(urlStr: string): ResolvedMount | null {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname || '/';

    const candidates = this.#table.mounts
      .filter((m) => m.host === host)
      .filter((m) => {
        if (m.pathPrefix === '/') return true;
        return pathname === m.pathPrefix || pathname.startsWith(m.pathPrefix + '/');
      })
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);

    const best = candidates[0];
    if (!best) return null;

    const activeSource = best.slots[best.activeSlot] ?? best.slots.A;
    const relativePath =
      best.pathPrefix === '/'
        ? pathname.replace(/^\/+/, '')
        : pathname.slice(best.pathPrefix.length).replace(/^\/+/, '');

    return {
      mount: best,
      activeSource,
      matchedHost: host,
      matchedPrefix: best.pathPrefix,
      relativePath,
    };
  }

  emitNginxConfig(wwwRootBase = '/home/ubuntu/www'): string {
    const byHost = new Map<string, DomainMount[]>();
    for (const m of this.#table.mounts) {
      const list = byHost.get(m.host) ?? [];
      list.push(m);
      byHost.set(m.host, list);
    }

    const blocks: string[] = [
      '# Auto-generated by awesome-os/deployment virtual-domain-manager.mts',
      `# Schema: ${this.#table.schema} | ABI: ${this.#table.abiMagic} | CAS: ${this.#table.casLayout}`,
      '',
    ];

    for (const [host, mounts] of byHost.entries()) {
      mounts.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
      blocks.push(`server {`);
      blocks.push(`  listen 443 ssl http2;`);
      blocks.push(`  server_name ${host};`);
      blocks.push(`  root ${wwwRootBase}/${host};`);
      blocks.push(`  add_header X-Awesome-OS-ABI "${this.#table.abiMagic}" always;`);
      for (const m of mounts) {
        const src = m.slots[m.activeSlot] ?? m.slots.A;
        const loc = m.pathPrefix === '/' ? '/' : `${m.pathPrefix}/`;
        blocks.push(`  # Mount [${m.kind}] Slot ${m.activeSlot} -> ${src}`);
        blocks.push(`  location ${loc} {`);
        if (m.kind === 'pipe') {
          blocks.push(`    # Bridged via host-pipe / mTLS gateway (${src})`);
          blocks.push(`    add_header X-Awesome-OS-Mount "${src}" always;`);
        } else {
          blocks.push(`    try_files $uri $uri/ =404;`);
          if (m.cacheControl) blocks.push(`    add_header Cache-Control "${m.cacheControl}" always;`);
        }
        blocks.push(`  }`);
      }
      blocks.push(`}`);
      blocks.push('');
    }
    return blocks.join('\n');
  }

  emitServiceWorkerRoutes(): {
    schema: 'awesome-os.opfs-sw-routes.v1';
    routes: Array<{ host: string; pathPrefix: string; source: string; kind: MountSourceKind }>;
  } {
    return {
      schema: 'awesome-os.opfs-sw-routes.v1',
      routes: this.#table.mounts.map((m) => ({
        host: m.host,
        pathPrefix: m.pathPrefix,
        source: m.slots[m.activeSlot] ?? m.slots.A,
        kind: m.kind,
      })),
    };
  }
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const defaultFile = join(dirname(fileURLToPath(import.meta.url)), 'virtual-domains.json');
  const cmd = process.argv[2] ?? 'list';
  const vdm = VirtualDomainManager.fromFile(defaultFile);

  if (cmd === 'list') {
    for (const m of vdm.list()) {
      const src = m.slots[m.activeSlot] ?? m.slots.A;
      console.log(`${(m.host + m.pathPrefix).padEnd(42)} [${m.kind.padEnd(10)}] Slot ${m.activeSlot} -> ${src}`);
    }
  } else if (cmd === 'resolve' && process.argv[3]) {
    console.log(JSON.stringify(vdm.resolveUrl(process.argv[3]), null, 2));
  } else if (cmd === 'emit-nginx') {
    console.log(vdm.emitNginxConfig());
  } else if (cmd === 'emit-sw') {
    console.log(JSON.stringify(vdm.emitServiceWorkerRoutes(), null, 2));
  } else {
    console.log('Usage: virtual-domain-manager.mts [list | resolve <url> | emit-nginx | emit-sw]');
  }
}
