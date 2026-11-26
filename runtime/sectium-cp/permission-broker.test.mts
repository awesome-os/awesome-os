/**
 * @file sections/sectium-cloud-control-plane/permission-broker.test.mts
 * @description Verification suite for the Out-of-Band Sectium Permission Broker.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  SectiumPermissionBroker,
  formatB8gPermissionElement,
  renderPermissionPromptAnsi,
  type PermissionAuditEntry,
  type PermissionDecision,
  type PermissionRequest,
} from './permission-broker.mts';

function stripAnsi(input: string): string {
  return input.replaceAll(/\x1b\[[0-9;]*m/g, '');
}

describe('SectiumPermissionBroker (Out-of-Band Permission Model)', () => {
  it('1. fails closed with ERR_PERMISSION_DENIED when no out-of-band prompter is attached', async () => {
    const broker = new SectiumPermissionBroker();

    const result = await broker.requestPermission({
      peerId: 'renderer-tab-42',
      scope: 'fs.read',
      resource: '/etc/sectium/keys',
      reason: 'Headless probe without operator prompt',
    });

    assert.equal(result.granted, false);
    if (!result.granted) {
      assert.equal(result.errorCode, 'ERR_PERMISSION_DENIED');
    }

    const log = broker.getAuditLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].outcome, 'denied');
    assert.equal(log[0].decision, 'deny');
    assert.equal(log[0].peerId, 'renderer-tab-42');
  });

  it('2. allow-once grant succeeds once and requires re-prompt / denies on second use', async () => {
    let promptCalls = 0;
    const decisions: PermissionDecision[] = ['allow-once', 'deny'];

    const broker = new SectiumPermissionBroker({
      prompter: () => {
        const next = decisions[promptCalls] ?? 'deny';
        promptCalls += 1;
        return next;
      },
    });

    const first = await broker.requestPermission({
      peerId: 'peer-alpha',
      scope: 'clipboard.read',
      resource: 'host://clipboard/primary',
      reason: 'Paste one-time token',
    });

    assert.equal(first.granted, true);
    assert.equal(promptCalls, 1);
    if (first.granted) {
      assert.equal(first.grant.decision, 'allow-once');
      assert.equal(first.grant.remainingUses, 0);
      assert.equal(broker.verifyGrant(first.grant), true);
    }

    const second = await broker.requestPermission({
      peerId: 'peer-alpha',
      scope: 'clipboard.read',
      resource: 'host://clipboard/primary',
      reason: 'Second read attempt',
    });

    assert.equal(promptCalls, 2);
    assert.equal(second.granted, false);
    if (!second.granted) {
      assert.equal(second.errorCode, 'ERR_PERMISSION_DENIED');
    }
  });

  it('3. allow-session grant succeeds repeatedly, then fails after revokeGrant() OR after expiresAt passes', async () => {
    // 3a. Revocation path
    let revokePrompts = 0;
    const revokeBroker = new SectiumPermissionBroker({
      prompter: () => {
        revokePrompts += 1;
        return revokePrompts === 1 ? 'allow-session' : 'deny';
      },
    });

    const g1 = await revokeBroker.requestPermission({
      peerId: 'peer-beta',
      scope: 'usb.claim',
      resource: 'usb://0x1234:0x5678',
      reason: 'Hardware security key access',
    });
    assert.equal(g1.granted, true);
    assert.equal(revokePrompts, 1);

    const g2 = await revokeBroker.requestPermission({
      peerId: 'peer-beta',
      scope: 'usb.claim',
      resource: 'usb://0x1234:0x5678',
      reason: 'Repeat access within session',
    });
    assert.equal(g2.granted, true);
    assert.equal(revokePrompts, 1);

    assert.equal(g1.granted && revokeBroker.revokeGrant(g1.grant.grantId), true);
    assert.equal(g1.granted && revokeBroker.revokeGrant(g1.grant.grantId), false);

    const afterRevoke = await revokeBroker.requestPermission({
      peerId: 'peer-beta',
      scope: 'usb.claim',
      resource: 'usb://0x1234:0x5678',
      reason: 'Access after revocation',
    });
    assert.equal(revokePrompts, 2);
    assert.equal(afterRevoke.granted, false);
    if (!afterRevoke.granted) {
      assert.equal(afterRevoke.errorCode, 'ERR_PERMISSION_DENIED');
    }

    // 3b. Expiration path via deterministic clock
    let clockMs = 1_700_000_000_000;
    let expiryPrompts = 0;
    const expiryBroker = new SectiumPermissionBroker({
      now: () => clockMs,
      prompter: () => {
        expiryPrompts += 1;
        return expiryPrompts === 1 ? 'allow-session' : 'deny';
      },
    });

    const e1 = await expiryBroker.requestPermission({
      peerId: 'peer-gamma',
      scope: 'display.capture',
      resource: 'display://sectium-canvas-0',
      reason: 'Short-lived screen share',
      ttlMs: 5_000,
    });
    assert.equal(e1.granted, true);
    assert.equal(expiryPrompts, 1);

    clockMs += 4_999;
    const e2 = await expiryBroker.requestPermission({
      peerId: 'peer-gamma',
      scope: 'display.capture',
      resource: 'display://sectium-canvas-0',
      reason: 'Still valid before ttlMs',
    });
    assert.equal(e2.granted, true);
    assert.equal(expiryPrompts, 1);

    clockMs += 1; // exactly at expiresAt
    const afterExpiry = await expiryBroker.requestPermission({
      peerId: 'peer-gamma',
      scope: 'display.capture',
      resource: 'display://sectium-canvas-0',
      reason: 'Expired session grant',
    });
    assert.equal(expiryPrompts, 2);
    assert.equal(afterExpiry.granted, false);
    if (!afterExpiry.granted) {
      assert.equal(afterExpiry.errorCode, 'ERR_PERMISSION_DENIED');
    }
    assert.ok(
      expiryBroker.getAuditLog().some((entry) => entry.outcome === 'expired'),
      'expected expired outcome in audit log',
    );
  });

  it('4. detects Ed25519 tampering if scope, resource, or expiresAt is mutated', async () => {
    const broker = new SectiumPermissionBroker({
      prompter: () => 'allow-persistent',
    });

    const res = await broker.requestPermission({
      peerId: 'peer-delta',
      scope: 'fs.read',
      resource: '/srv/sectium/public',
      reason: 'Read public assets',
      ttlMs: 60_000,
    });

    assert.equal(res.granted, true);
    if (!res.granted) return;

    const grant = res.grant;
    assert.equal(broker.verifyGrant(grant), true);

    assert.equal(broker.verifyGrant({ ...grant, scope: 'fs.write' }), false);
    assert.equal(broker.verifyGrant({ ...grant, resource: '/etc/shadow' }), false);
    assert.equal(broker.verifyGrant({ ...grant, expiresAt: null }), false);
    assert.equal(
      broker.verifyGrant({ ...grant, expiresAt: (grant.expiresAt ?? 0) + 1 }),
      false,
    );

    const tamperedEntries = broker
      .getAuditLog()
      .filter((entry) => entry.outcome === 'tampered');
    assert.equal(tamperedEntries.length, 4);
  });

  it('5. renders <= 78-col ANSI prompt, formats <b8g-sectium-permission>, and persists JSONL audit log', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sectium-perm-audit-'));
    const auditLogPath = join(tempDir, 'permission-audit.jsonl');

    try {
      const req: PermissionRequest = {
        requestId: 'req-9001',
        peerId: 'peer-kitty-01',
        scope: 'net.connect',
        resource: 'mtls://control-plane.sectium.local:9443',
        reason: 'Attach opaque command channel for rolling release inspection and diagnostics',
        requestedAt: '2026-11-22T17:30:00.000Z',
      };

      const ansiPrompt = renderPermissionPromptAnsi(req);
      assert.ok(ansiPrompt.includes('\x1b['), 'expected ANSI escape sequences');
      const plain = stripAnsi(ansiPrompt);
      const lines = plain.split('\n');
      assert.ok(lines.length >= 8, 'expected boxed multi-line prompt');
      for (const line of lines) {
        assert.ok(
          line.length <= 78,
          `prompt line exceeded 78 columns (${line.length}): ${line}`,
        );
      }
      assert.ok(plain.includes('peer-kitty-01'));
      assert.ok(plain.includes('net.connect'));
      assert.ok(plain.includes('mtls://control-plane.sectium.local:9443'));
      assert.ok(plain.includes('[1] Allow Once  [2] Allow Session  [3] Deny'));

      const element = formatB8gPermissionElement({
        ...req,
        resource: 'mtls://cp?a=1&b="quoted"<tag>',
      });
      assert.ok(element.startsWith('<b8g-sectium-permission '));
      assert.ok(element.endsWith('></b8g-sectium-permission>'));
      assert.ok(element.includes('data-request-id="req-9001"'));
      assert.ok(element.includes('data-peer-id="peer-kitty-01"'));
      assert.ok(element.includes('data-scope="net.connect"'));
      assert.ok(
        element.includes('data-resource="mtls://cp?a=1&amp;b=&quot;quoted&quot;&lt;tag&gt;"'),
      );

      const broker = new SectiumPermissionBroker({
        auditLogPath,
        prompter: () => 'allow-session',
      });

      const granted = await broker.requestPermission({
        peerId: req.peerId,
        scope: req.scope,
        resource: req.resource,
        reason: req.reason,
      });
      assert.equal(granted.granted, true);
      if (granted.granted) {
        assert.equal(broker.revokeGrant(granted.grant.grantId), true);
      }

      const rawLines = readFileSync(auditLogPath, 'utf8').trim().split('\n');
      assert.equal(rawLines.length, 2);
      const parsed = rawLines.map((line) => JSON.parse(line) as PermissionAuditEntry);
      assert.equal(parsed[0].outcome, 'granted');
      assert.equal(parsed[0].peerId, 'peer-kitty-01');
      assert.equal(parsed[1].outcome, 'revoked');
      assert.equal(parsed[1].grantId, parsed[0].grantId);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
