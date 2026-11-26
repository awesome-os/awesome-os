/**
 * @file sections/sectium-cloud-control-plane/permission-broker.mts
 * @description Out-of-Band Sectium Permission Broker (`xdg-desktop-portal` / Qubes `qrexec` model).
 *
 * Security invariants:
 *   - Permission prompts live strictly outside the untrusted browser renderer (serial console,
 *     Kitty-Ink TUI over `channel: 'command'`, or host `<b8g-sectium-permission>` shell).
 *   - Fail-closed when no out-of-band prompter is attached (`ERR_PERMISSION_DENIED`).
 *   - Every granted capability is cryptographically signed with Ed25519 over its canonical fields
 *     so renderer/peer tampering is detected deterministically.
 *   - Every grant, denial, revocation, expiration, and tamper event is appended to an in-memory
 *     and optional JSONL audit log.
 *
 * Strictly `erasableSyntaxOnly: true` & zero external dependencies (`node:crypto` + `node:fs` only).
 */
import {
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { appendFileSync } from 'node:fs';

export type PermissionDecision = 'allow-once' | 'allow-session' | 'allow-persistent' | 'deny';

export interface PermissionRequest {
  readonly requestId: string;
  readonly peerId: string;
  readonly scope: string;
  readonly resource: string;
  readonly reason: string;
  readonly requestedAt: string;
}

export interface PermissionGrant {
  readonly grantId: string;
  readonly peerId: string;
  readonly scope: string;
  readonly resource: string;
  readonly decision: Exclude<PermissionDecision, 'deny'>;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
  remainingUses: number | null;
  readonly signatureBase64: string;
}

export interface PermissionAuditEntry {
  readonly timestamp: string;
  readonly peerId: string;
  readonly scope: string;
  readonly resource: string;
  readonly outcome: 'granted' | 'denied' | 'revoked' | 'expired' | 'tampered';
  readonly decision?: PermissionDecision;
  readonly grantId?: string;
}

export type PermissionPrompter = (
  req: PermissionRequest,
) => Promise<PermissionDecision> | PermissionDecision;

export interface PermissionBrokerOptions {
  readonly keyPair?: {
    readonly publicKey: KeyObject;
    readonly privateKey: KeyObject;
  };
  readonly prompter?: PermissionPrompter;
  readonly auditLogPath?: string;
  readonly now?: () => number;
  readonly defaultSessionTtlMs?: number;
}

export interface PermissionRequestInput {
  readonly peerId: string;
  readonly scope: string;
  readonly resource: string;
  readonly reason: string;
  readonly ttlMs?: number;
}

export type PermissionResult =
  | { readonly granted: true; readonly grant: PermissionGrant }
  | { readonly granted: false; readonly errorCode: 'ERR_PERMISSION_DENIED' };

interface CanonicalGrantPayload {
  readonly grantId: string;
  readonly peerId: string;
  readonly scope: string;
  readonly resource: string;
  readonly decision: Exclude<PermissionDecision, 'deny'>;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
}

function canonicalGrantBytes(grant: CanonicalGrantPayload): Buffer {
  const canonical: CanonicalGrantPayload = {
    grantId: grant.grantId,
    peerId: grant.peerId,
    scope: grant.scope,
    resource: grant.resource,
    decision: grant.decision,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

function grantLookupKey(peerId: string, scope: string, resource: string): string {
  return `${peerId}\u0000${scope}\u0000${resource}`;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function fitText(text: string, maxLen: number): string {
  const singleLine = text.replaceAll(/[\r\n\t]+/g, ' ');
  if (singleLine.length <= maxLen) {
    return singleLine.padEnd(maxLen, ' ');
  }
  if (maxLen <= 1) {
    return singleLine.slice(0, Math.max(0, maxLen));
  }
  return `${singleLine.slice(0, maxLen - 1)}…`;
}

/**
 * Renders a crisp `<= 78`-column Kitty-Ink / serial console box-drawing permission prompt
 * strictly outside the untrusted renderer.
 */
export function renderPermissionPromptAnsi(req: PermissionRequest): string {
  const width = 76;
  const inner = width - 4;
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const sep = `├${'─'.repeat(width - 2)}┤`;
  const bottom = `└${'─'.repeat(width - 2)}┘`;
  const row = (text: string): string => `│ ${fitText(text, inner)} │`;

  const headerText = fitText('SECTIUM PERMISSION BROKER (OUT-OF-BAND)', inner);
  const actionsText = fitText('[1] Allow Once  [2] Allow Session  [3] Deny', inner);

  const lines = [
    `\x1b[36m${top}\x1b[0m`,
    `\x1b[36m│\x1b[0m \x1b[1;33m${headerText}\x1b[0m \x1b[36m│\x1b[0m`,
    `\x1b[36m${sep}\x1b[0m`,
    row(`Request  : ${req.requestId}`),
    row(`Peer     : ${req.peerId}`),
    row(`Scope    : ${req.scope}`),
    row(`Resource : ${req.resource}`),
    row(`Reason   : ${req.reason}`),
    `\x1b[36m${sep}\x1b[0m`,
    `\x1b[36m│\x1b[0m \x1b[1;32m${actionsText}\x1b[0m \x1b[36m│\x1b[0m`,
    `\x1b[36m${bottom}\x1b[0m`,
  ];
  return lines.join('\n');
}

/**
 * Formats an HTML5 `<b8g-sectium-permission>` custom element with escaped `data-*` attributes
 * for out-of-band Hyperscaler Desktop / host shell rendering.
 */
export function formatB8gPermissionElement(req: PermissionRequest): string {
  return (
    `<b8g-sectium-permission` +
    ` data-request-id="${escapeHtmlAttr(req.requestId)}"` +
    ` data-peer-id="${escapeHtmlAttr(req.peerId)}"` +
    ` data-scope="${escapeHtmlAttr(req.scope)}"` +
    ` data-resource="${escapeHtmlAttr(req.resource)}"` +
    ` data-reason="${escapeHtmlAttr(req.reason)}"` +
    ` data-requested-at="${escapeHtmlAttr(req.requestedAt)}"` +
    `></b8g-sectium-permission>`
  );
}

/**
 * Out-of-Band Sectium Permission Broker managing Ed25519-signed capability grants,
 * fail-closed headless enforcement, revocation, expiration, and JSONL audit logging.
 */
export class SectiumPermissionBroker {
  readonly #publicKey: KeyObject;
  readonly #privateKey: KeyObject;
  readonly #prompter: PermissionPrompter | undefined;
  readonly #auditLogPath: string | undefined;
  readonly #now: () => number;
  readonly #defaultSessionTtlMs: number | undefined;
  readonly #grantsByKey = new Map<string, PermissionGrant>();
  readonly #grantsById = new Map<string, { key: string; grant: PermissionGrant }>();
  readonly #revokedGrantIds = new Set<string>();
  readonly #auditLog: PermissionAuditEntry[] = [];

  constructor(options: PermissionBrokerOptions = {}) {
    if (options.keyPair) {
      this.#publicKey = options.keyPair.publicKey;
      this.#privateKey = options.keyPair.privateKey;
    } else {
      const generated = generateKeyPairSync('ed25519');
      this.#publicKey = generated.publicKey;
      this.#privateKey = generated.privateKey;
    }
    this.#prompter = options.prompter;
    this.#auditLogPath = options.auditLogPath;
    this.#now = options.now ?? (() => Date.now());
    this.#defaultSessionTtlMs = options.defaultSessionTtlMs;
  }

  #recordAudit(entry: PermissionAuditEntry): void {
    this.#auditLog.push(entry);
    if (this.#auditLogPath) {
      appendFileSync(this.#auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
    }
  }

  #removeActiveGrant(key: string, grantId: string): void {
    this.#grantsByKey.delete(key);
    this.#grantsById.delete(grantId);
  }

  /**
   * Verifies the Ed25519 signature over canonical grant fields:
   * `(grantId, peerId, scope, resource, decision, issuedAt, expiresAt)`.
   */
  verifyGrant(grant: PermissionGrant): boolean {
    try {
      const payload = canonicalGrantBytes(grant);
      const signature = Buffer.from(grant.signatureBase64, 'base64');
      if (signature.length === 0) {
        return false;
      }
      const valid = verify(null, payload, this.#publicKey, signature);
      if (!valid) {
        this.#recordAudit({
          timestamp: new Date(this.#now()).toISOString(),
          peerId: grant.peerId,
          scope: grant.scope,
          resource: grant.resource,
          outcome: 'tampered',
          decision: grant.decision,
          grantId: grant.grantId,
        });
      }
      return valid;
    } catch {
      this.#recordAudit({
        timestamp: new Date(this.#now()).toISOString(),
        peerId: grant.peerId,
        scope: grant.scope,
        resource: grant.resource,
        outcome: 'tampered',
        decision: grant.decision,
        grantId: grant.grantId,
      });
      return false;
    }
  }

  /**
   * Requests permission for `(peerId, scope, resource)`.
   * Checks any existing valid, non-expired, non-revoked, signature-verified grant first.
   * Fails closed (`ERR_PERMISSION_DENIED`) when no valid grant exists and no prompter is attached.
   */
  async requestPermission(input: PermissionRequestInput): Promise<PermissionResult> {
    const nowMs = this.#now();
    const nowIso = new Date(nowMs).toISOString();
    const key = grantLookupKey(input.peerId, input.scope, input.resource);
    const existing = this.#grantsByKey.get(key);

    if (existing) {
      if (this.#revokedGrantIds.has(existing.grantId)) {
        this.#removeActiveGrant(key, existing.grantId);
      } else if (!this.verifyGrant(existing)) {
        this.#removeActiveGrant(key, existing.grantId);
      } else if (existing.expiresAt !== null && nowMs >= existing.expiresAt) {
        this.#removeActiveGrant(key, existing.grantId);
        this.#recordAudit({
          timestamp: nowIso,
          peerId: existing.peerId,
          scope: existing.scope,
          resource: existing.resource,
          outcome: 'expired',
          decision: existing.decision,
          grantId: existing.grantId,
        });
      } else if (existing.remainingUses !== null) {
        if (existing.remainingUses > 0) {
          existing.remainingUses -= 1;
          if (existing.remainingUses === 0) {
            this.#removeActiveGrant(key, existing.grantId);
          }
          this.#recordAudit({
            timestamp: nowIso,
            peerId: existing.peerId,
            scope: existing.scope,
            resource: existing.resource,
            outcome: 'granted',
            decision: existing.decision,
            grantId: existing.grantId,
          });
          return { granted: true, grant: existing };
        }
        this.#removeActiveGrant(key, existing.grantId);
      } else {
        this.#recordAudit({
          timestamp: nowIso,
          peerId: existing.peerId,
          scope: existing.scope,
          resource: existing.resource,
          outcome: 'granted',
          decision: existing.decision,
          grantId: existing.grantId,
        });
        return { granted: true, grant: existing };
      }
    }

    if (!this.#prompter) {
      this.#recordAudit({
        timestamp: nowIso,
        peerId: input.peerId,
        scope: input.scope,
        resource: input.resource,
        outcome: 'denied',
        decision: 'deny',
      });
      return { granted: false, errorCode: 'ERR_PERMISSION_DENIED' };
    }

    const request: PermissionRequest = {
      requestId: randomUUID(),
      peerId: input.peerId,
      scope: input.scope,
      resource: input.resource,
      reason: input.reason,
      requestedAt: nowIso,
    };

    const decision = await this.#prompter(request);
    if (decision === 'deny') {
      this.#recordAudit({
        timestamp: new Date(this.#now()).toISOString(),
        peerId: input.peerId,
        scope: input.scope,
        resource: input.resource,
        outcome: 'denied',
        decision: 'deny',
      });
      return { granted: false, errorCode: 'ERR_PERMISSION_DENIED' };
    }

    const issuedAt = this.#now();
    const effectiveTtlMs =
      input.ttlMs !== undefined
        ? input.ttlMs
        : decision === 'allow-session'
          ? this.#defaultSessionTtlMs
          : undefined;
    const expiresAt = effectiveTtlMs !== undefined ? issuedAt + effectiveTtlMs : null;
    const grantId = randomUUID();

    const payload = canonicalGrantBytes({
      grantId,
      peerId: input.peerId,
      scope: input.scope,
      resource: input.resource,
      decision,
      issuedAt,
      expiresAt,
    });
    const signatureBase64 = sign(null, payload, this.#privateKey).toString('base64');

    const grant: PermissionGrant = {
      grantId,
      peerId: input.peerId,
      scope: input.scope,
      resource: input.resource,
      decision,
      issuedAt,
      expiresAt,
      remainingUses: decision === 'allow-once' ? 1 : null,
      signatureBase64,
    };

    if (decision === 'allow-once') {
      // Consume the single permitted use immediately for this request (1 -> 0).
      grant.remainingUses = 0;
    } else {
      this.#grantsByKey.set(key, grant);
      this.#grantsById.set(grantId, { key, grant });
    }

    this.#recordAudit({
      timestamp: new Date(issuedAt).toISOString(),
      peerId: grant.peerId,
      scope: grant.scope,
      resource: grant.resource,
      outcome: 'granted',
      decision: grant.decision,
      grantId: grant.grantId,
    });

    return { granted: true, grant };
  }

  /**
   * Revokes an active grant by `grantId`. Returns `true` if an active grant was revoked.
   */
  revokeGrant(grantId: string): boolean {
    const entry = this.#grantsById.get(grantId);
    if (!entry) {
      return false;
    }
    this.#removeActiveGrant(entry.key, grantId);
    this.#revokedGrantIds.add(grantId);
    this.#recordAudit({
      timestamp: new Date(this.#now()).toISOString(),
      peerId: entry.grant.peerId,
      scope: entry.grant.scope,
      resource: entry.grant.resource,
      outcome: 'revoked',
      decision: entry.grant.decision,
      grantId,
    });
    return true;
  }

  /**
   * Returns an immutable snapshot of the permission audit log.
   */
  getAuditLog(): readonly PermissionAuditEntry[] {
    return [...this.#auditLog];
  }
}
