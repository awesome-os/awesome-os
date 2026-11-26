/**
 * @file sections/sectium-device/devtools-plane.test.mts
 * @description Verification suite for the Sectium DevTools Backend &
 * Cross-Tab IDE Plane on top of `channel: 'command'`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SectiumDeviceClient } from './device-client.mts';
import { SectiumDeviceHost } from './device-host.mts';
import {
  formatB8gSectiumCommandElement,
  formatB8gSectiumDevToolsElement,
  formatB8gSectiumDisplayElement,
  SectiumDevToolsPlane,
  type SectiumDevToolsEvent,
} from './devtools-plane.mts';

function makeTestPipePath(suffix: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sectium-devtools-test-${process.pid}-${suffix}`
    : `/tmp/sectium-devtools-test-${process.pid}-${suffix}.sock`;
}

describe('SectiumDevToolsPlane (DevTools Backend & Cross-Tab IDE Plane)', () => {
  it('registers, updates, lists, and unregisters tabs with cross-tab context aggregation', () => {
    const plane = new SectiumDevToolsPlane({ planeId: 'devtools-main' });
    assert.equal(plane.channel, 'command');
    assert.equal(plane.planeId, 'devtools-main');

    const tab1 = plane.registerTab({
      tabId: 'tab-1',
      url: 'https://docs.awesome-os.local/arch',
      title: 'Architecture Spec',
      origin: 'https://docs.awesome-os.local',
      active: true,
      metadata: { workspace: 'awesome-os' },
    });
    const tab2 = plane.registerTab({
      tabId: 'tab-2',
      url: 'https://forge.awesome-os.local/issues/42',
      title: 'Issue #42',
      origin: 'https://forge.awesome-os.local',
    });
    const tab3 = plane.registerTab({
      tabId: 'tab-3',
      url: 'https://docs.awesome-os.local/api',
      title: 'API Reference',
      origin: 'https://docs.awesome-os.local',
    });

    assert.equal(tab1.active, true);
    assert.equal(tab2.active, false);
    assert.equal(tab3.active, false);
    assert.equal(plane.listTabs().length, 3);

    // Update tab-2 context and make it active
    const updatedTab2 = plane.updateTabContext('tab-2', {
      title: 'Issue #42 — Resolved',
      active: true,
      selection: 'SectiumDevToolsPlane',
      focusedElement: 'textarea#comment',
      metadata: { severity: 'high' },
    });
    assert.equal(updatedTab2.title, 'Issue #42 — Resolved');
    assert.equal(updatedTab2.active, true);
    assert.equal(updatedTab2.selection, 'SectiumDevToolsPlane');
    assert.equal(updatedTab2.focusedElement, 'textarea#comment');
    assert.equal(updatedTab2.metadata.severity, 'high');

    const snapshot = plane.getCrossTabContext();
    assert.equal(snapshot.channel, 'command');
    assert.equal(snapshot.tabCount, 3);
    assert.equal(snapshot.activeTabId, 'tab-2');
    assert.deepEqual(snapshot.origins, [
      'https://docs.awesome-os.local',
      'https://forge.awesome-os.local',
    ]);
    assert.equal(
      snapshot.tabs.find((t) => t.tabId === 'tab-1')?.active,
      false,
    );
    assert.equal(
      snapshot.tabs.find((t) => t.tabId === 'tab-2')?.active,
      true,
    );

    // Unregister tab-3 and verify snapshot shrinks
    assert.equal(plane.unregisterTab('tab-3'), true);
    assert.equal(plane.unregisterTab('tab-missing'), false);
    assert.equal(plane.listTabs().length, 2);
    assert.equal(plane.getCrossTabContext().tabCount, 2);

    // Updating an unregistered tab throws explicitly
    assert.throws(
      () => plane.updateTabContext('tab-3', { title: 'Ghost' }),
      /not registered/,
    );
  });

  it('attaches and detaches VS Code, Antigravity, agent, and CLI DevTools clients', () => {
    const plane = new SectiumDevToolsPlane();

    const vscode = plane.attachDevToolsClient('vscode-oss-1', 'vscode', {
      cdpEndpoint: 'pipe://sectium-dev/cdp',
      capabilities: ['dom', 'console', 'cross-tab-context'],
    });
    const antigravity = plane.attachDevToolsClient(
      'antigravity-ide',
      'antigravity',
    );
    const agent = plane.attachDevToolsClient('device-agent-1', 'agent');
    const cli = plane.attachDevToolsClient('b8g-cli', 'cli');

    assert.equal(vscode.channel, 'command');
    assert.equal(vscode.kind, 'vscode');
    assert.equal(antigravity.kind, 'antigravity');
    assert.equal(agent.kind, 'agent');
    assert.equal(cli.kind, 'cli');

    const clients = plane.listDevToolsClients();
    assert.equal(clients.length, 4);

    const snapshot = plane.getCrossTabContext();
    assert.equal(snapshot.devtoolsClients.length, 4);
    assert.deepEqual(
      snapshot.devtoolsClients.map((c) => c.clientId),
      ['vscode-oss-1', 'antigravity-ide', 'device-agent-1', 'b8g-cli'],
    );

    assert.equal(plane.detachDevToolsClient('vscode-oss-1'), true);
    assert.equal(plane.detachDevToolsClient('vscode-oss-1'), false);
    assert.equal(plane.listDevToolsClients().length, 3);
  });

  it('emits structured typed events via onEvent() and supports clean unsubscribe', () => {
    const plane = new SectiumDevToolsPlane();
    const events: SectiumDevToolsEvent[] = [];

    const unsubscribe = plane.onEvent((event) => {
      events.push(event);
    });

    plane.registerTab({
      tabId: 'tab-art',
      url: 'https://art.sectium.local/canvas',
      title: 'Pure Art Canvas',
      origin: 'https://art.sectium.local',
    });

    plane.updateTabContext('tab-art', {
      title: 'Pure Art Canvas — Frame 2',
      selection: 'shader-main',
    });

    plane.attachDevToolsClient('vscode-debug', 'vscode');
    plane.detachDevToolsClient('vscode-debug');

    unsubscribe();

    // Post-unsubscribe mutations must not deliver to unsubscribed listener
    plane.attachDevToolsClient('late-cli', 'cli');

    assert.deepEqual(
      events.map((e) => e.type),
      [
        'tab-registered',
        'tab-context-updated',
        'devtools-attached',
        'devtools-detached',
      ],
    );

    for (const evt of events) {
      assert.equal(evt.channel, 'command');
      assert.equal(typeof evt.timestamp, 'number');
    }

    const updatedEvt = events[1];
    assert.equal(updatedEvt?.type, 'tab-context-updated');
    if (updatedEvt?.type === 'tab-context-updated') {
      assert.equal(updatedEvt.tabId, 'tab-art');
      assert.equal(updatedEvt.patch.selection, 'shader-main');
      assert.equal(updatedEvt.tab.title, 'Pure Art Canvas — Frame 2');
    }

    const attachedEvt = events[2];
    assert.equal(attachedEvt?.type, 'devtools-attached');
    if (attachedEvt?.type === 'devtools-attached') {
      assert.equal(attachedEvt.client.clientId, 'vscode-debug');
      assert.equal(attachedEvt.client.kind, 'vscode');
    }

    const detachedEvt = events[3];
    assert.equal(detachedEvt?.type, 'devtools-detached');
    if (detachedEvt?.type === 'devtools-detached') {
      assert.equal(detachedEvt.clientId, 'vscode-debug');
    }
  });

  it('attaches to live SectiumDeviceHost channel: "command" while keeping channel: "display" untouched', async () => {
    const pipePath = makeTestPipePath('live-command');
    const host = new SectiumDeviceHost({ pipePath });
    const deviceClient = new SectiumDeviceClient({ pipePath, timeoutMs: 1000 });
    const plane = new SectiumDevToolsPlane({
      planeId: 'devtools-backend-1',
      deviceClient,
    });

    await host.start();
    try {
      const attachment = await plane.attachToCommandChannel();
      assert.equal(attachment.channel, 'command');
      assert.equal(attachment.clientId, 'devtools-backend-1');
      assert.equal(attachment.sink, 'devtools-plane');

      plane.registerTab({
        tabId: 'tab-live',
        url: 'https://sectium.local/workbench',
        title: 'Workbench',
        origin: 'https://sectium.local',
        active: true,
      });
      plane.attachDevToolsClient('antigravity-1', 'antigravity');

      const channels = await deviceClient.listChannels();
      assert.equal(channels.channels.command.length, 1);
      assert.equal(channels.channels.display.length, 0);

      const snapshot = plane.getCrossTabContext();
      assert.equal(
        snapshot.attachedCommandChannel?.attachmentId,
        attachment.attachmentId,
      );
      assert.equal(snapshot.tabCount, 1);
      assert.equal(snapshot.devtoolsClients.length, 1);

      const detached = await plane.detachFromCommandChannel();
      assert.equal(detached, true);
      assert.equal(plane.channelAttachment, null);

      const channelsAfter = await deviceClient.listChannels();
      assert.equal(channelsAfter.channels.command.length, 0);
      assert.equal(channelsAfter.channels.display.length, 0);
    } finally {
      await host.stop();
    }
  });

  it('streams cross-tab events over standard Web Streams with .tee(), TransformStream, and WritableStream fan-out', async () => {
    const plane = new SectiumDevToolsPlane({ planeId: 'devtools-webstreams' });
    const sourceStream = plane.createEventStream();

    // Fan-out via standard ReadableStream.tee() to two independent consumers (VS Code + Agent)
    const [vscodeStream, agentStream] = sourceStream.tee();

    const vscodeEventTypes: string[] = [];
    const agentHtmlChunks: string[] = [];

    const vscodeSink = vscodeStream.pipeTo(
      new WritableStream<SectiumDevToolsEvent>({
        write(event) {
          vscodeEventTypes.push(event.type);
        },
      }),
    );

    const agentSink = agentStream
      .pipeThrough(
        new TransformStream<SectiumDevToolsEvent, string>({
          transform(event, controller) {
            controller.enqueue(
              `<b8g-sectium-devtools data-channel="${event.channel}" data-cross-tab="true" data-event-type="${event.type}"></b8g-sectium-devtools>`,
            );
          },
        }),
      )
      .pipeTo(
        new WritableStream<string>({
          write(chunk) {
            agentHtmlChunks.push(chunk);
          },
        }),
      );

    plane.registerTab({
      tabId: 'tab-stream-1',
      url: 'https://sectium.local/stream',
      title: 'Web Streams Tab',
      origin: 'https://sectium.local',
      active: true,
    });
    plane.updateTabContext('tab-stream-1', { title: 'Web Streams Tab (Updated)' });
    plane.attachDevToolsClient('vscode-stream-client', 'vscode');
    plane.detachDevToolsClient('vscode-stream-client');

    plane.closeEventStreams();
    await Promise.all([vscodeSink, agentSink]);

    assert.deepEqual(vscodeEventTypes, [
      'tab-registered',
      'tab-context-updated',
      'devtools-attached',
      'devtools-detached',
    ]);
    assert.equal(agentHtmlChunks.length, 4);
    assert.ok(agentHtmlChunks[0]?.includes('data-channel="command"'));
    assert.ok(agentHtmlChunks[0]?.includes('data-cross-tab="true"'));
    assert.ok(agentHtmlChunks[0]?.includes('data-event-type="tab-registered"'));
  });

  it('formats strictly HTML5 data-* <b8g-*> Streaming Web Component elements', () => {
    const cmdEl = formatB8gSectiumCommandElement('\\\\.\\pipe\\sectium-dev');
    assert.equal(
      cmdEl,
      '<b8g-sectium-command data-pipe="\\\\.\\pipe\\sectium-dev" data-channel="command"></b8g-sectium-command>',
    );

    const dispEl = formatB8gSectiumDisplayElement(
      '\\\\.\\pipe\\sectium-dev',
      'canvas',
    );
    assert.equal(
      dispEl,
      '<b8g-sectium-display data-pipe="\\\\.\\pipe\\sectium-dev" data-channel="display" data-surface="canvas"></b8g-sectium-display>',
    );

    const devEl = formatB8gSectiumDevToolsElement({ crossTab: true });
    assert.equal(
      devEl,
      '<b8g-sectium-devtools data-channel="command" data-cross-tab="true"></b8g-sectium-devtools>',
    );

    const plane = new SectiumDevToolsPlane({ planeId: 'ide-plane-1' });
    plane.registerTab({
      tabId: 'tab-1',
      url: 'https://sectium.local/',
      title: 'Home',
      origin: 'https://sectium.local',
      active: true,
    });
    plane.attachDevToolsClient('vscode-1', 'vscode');

    const serialized = plane.toHtml5Element();
    assert.ok(serialized.startsWith('<b8g-sectium-devtools '));
    assert.ok(serialized.includes('data-channel="command"'));
    assert.ok(serialized.includes('data-cross-tab="true"'));
    assert.ok(serialized.includes('data-plane-id="ide-plane-1"'));
    assert.ok(serialized.includes('data-tab-count="1"'));
    assert.ok(serialized.includes('data-client-count="1"'));
    assert.ok(serialized.includes('data-active-tab-id="tab-1"'));
  });
});
