/**
 * system-uri.mts — Canonical `system://` Protocol Resolver (3rd Pillar of Holo Stack)
 *
 * Completes the 3-protocol symmetry:
 *   1. repository://  — Immutable v11 source of truth (SHA-512 blobs & trees)
 *   2. project://     — 0-byte hardlink workspace & build projection
 *   3. system://      — Live addressable resources, devices, monitors, keyboards,
 *                       appliances, OCI containers, browser/terminal apps & remote nodes
 *
 * Grammar:
 *   system://<locality>/<scope>/<id>[?kvm=<ch>&from=<repository://...>&tag=<...>]
 *
 * Examples:
 *   system://local/monitor/desktop-omarchy?kvm=2
 *   system://local/keyboard/holo-kvm-switch
 *   system://remote/appliance/mail.dspeed.eu
 *   system://local/oci-container/gitlab-runner
 *   system://local/browser-app/gitlab
 *   system://local/terminal-app/coreutils
 *   system://local/folder-structure/holo-v11
 */

export const SYSTEM_SCOPES = [
  'appliance',
  'device',
  'monitor',
  'keyboard',
  'oci-container',
  'browser-app',
  'terminal-app',
  'folder-structure',
] as const;

export type SystemScope = (typeof SYSTEM_SCOPES)[number];
export type SystemLocality = 'local' | 'remote';

export interface ParsedSystemUri {
  raw: string;
  scheme: 'system';
  locality: SystemLocality;
  scope: SystemScope;
  id: string;
  params: Record<string, string>;
  abiMagic: '0x33564742';
}

export function parseSystemUri(uri: string): ParsedSystemUri {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('system://')) {
    throw new Error(`Invalid system:// URI (must start with system://): "${uri}"`);
  }
  const rest = trimmed.slice('system://'.length);
  const [pathPart, queryPart] = rest.split('?', 2);
  const segs = pathPart.split('/').filter(Boolean);
  if (segs.length < 3) {
    throw new Error(`Invalid system:// URI (expected system://<local|remote>/<scope>/<id>): "${uri}"`);
  }
  const [loc, scope, ...idParts] = segs;
  if (loc !== 'local' && loc !== 'remote') {
    throw new Error(`Invalid system:// locality "${loc}" (expected "local" or "remote")`);
  }
  if (!(SYSTEM_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`Unknown system:// scope "${scope}" (valid: ${SYSTEM_SCOPES.join(', ')})`);
  }
  const params: Record<string, string> = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const [k, v = ''] = pair.split('=', 2);
      params[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  return {
    raw: trimmed,
    scheme: 'system',
    locality: loc,
    scope: scope as SystemScope,
    id: idParts.join('/'),
    params,
    abiMagic: '0x33564742',
  };
}

export function formatSystemUri(
  locality: SystemLocality,
  scope: SystemScope,
  id: string,
  params?: Record<string, string>,
): string {
  const base = `system://${locality}/${scope}/${id}`;
  if (!params || Object.keys(params).length === 0) return base;
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}
