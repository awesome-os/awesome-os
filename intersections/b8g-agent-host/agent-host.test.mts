/**
 * @file agent-host.test.mts
 * @description Tests for B8G Persistent Agent Host: disk survival across reloads,
 * multi-client SSE fan-out & replay (`since=seq`), and HTTP API + HTML UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSessionStore } from './session-store.mts';
import { startAgentHostServer } from './server.mts';

test('AgentSessionStore persists sessions & events across store restarts (reload-proof)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-agent-host-'));
  try {
    const store1 = new AgentSessionStore(tmpDir);
    const s = store1.createSession({
      title: 'Reload Test',
      projectRoot: 'e:\\awesome-os',
      backend: 'echo-local',
    });
    store1.appendEvent(s.id, 'user', { text: 'stay alive' });
    store1.appendEvent(s.id, 'token', { text: 'always online' });

    // Simulate full daemon/IDE restart with a fresh store instance reading the same dir.
    const store2 = new AgentSessionStore(tmpDir);
    const reloaded = store2.getSession(s.id);
    assert.ok(reloaded, 'Session must survive restart');
    assert.equal(reloaded.title, 'Reload Test');
    const events = store2.getEvents(s.id);
    assert.equal(events.length, 3); // system + user + token
    assert.equal(events[2]?.text, 'always online');

    // Replay with sinceSeq skips earlier events cleanly.
    const delta = store2.getEvents(s.id, 2);
    assert.equal(delta.length, 1);
    assert.equal(delta[0]?.seq, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AgentHostServer streams live echo-local turns to multiple connected clients & serves B8G UI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-agent-srv-'));
  const srv = await startAgentHostServer({ port: 0, dataDir: tmpDir, defaultProjectRoot: tmpDir });
  try {
    const healthRes = await fetch(`${srv.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { ok: boolean; service: string; sessions: number };
    assert.equal(health.ok, true);
    assert.equal(health.service, 'b8g-agent-host');
    assert.ok(health.sessions >= 1);

    const uiRes = await fetch(`${srv.url}/`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.ok(uiHtml.includes('<b8g-section data-kind="intersection-ui"'), 'UI must use <b8g-section> with data-*');
    assert.ok(uiHtml.includes('<b8g-stream data-kind="sse-event-stream"'), 'UI must use <b8g-stream> with data-*');

    const shellRes = await fetch(`${srv.url}/shell`);
    assert.equal(shellRes.status, 200);
    const shellHtml = await shellRes.text();
    assert.ok(shellHtml.includes('<b8g-section data-kind="sectium-default-shell"'), 'Sectium shell must use <b8g-section> with data-*');
    assert.ok(shellHtml.includes('SECTIUM SHELL'), 'Sectium default shell header must be present');

    // Create echo-local session
    const createRes = await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Multi-UI', backend: 'echo-local', projectRoot: tmpDir }),
    });
    assert.equal(createRes.status, 201);
    const { session } = (await createRes.json()) as { session: { id: string } };

    // Post message and verify events land in persistent log
    const msgRes = await fetch(`${srv.url}/api/sessions/${session.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from vscode' }),
    });
    assert.equal(msgRes.status, 202);

    // Wait briefly for async echo turn
    await new Promise((r) => setTimeout(r, 80));
    const evRes = await fetch(`${srv.url}/api/sessions/${session.id}/events`);
    const evData = (await evRes.json()) as { events: Array<{ type: string; text?: string }> };
    const doneEv = evData.events.find((e) => e.type === 'assistant_done');
    assert.ok(doneEv, 'Should emit assistant_done event');
    assert.ok(doneEv.text?.includes('hello from vscode'));
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
