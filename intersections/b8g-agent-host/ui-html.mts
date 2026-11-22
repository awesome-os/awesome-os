/**
 * @file ui-html.mts
 * @description Dark-glass, always-on B8G Agent Host UI using tagged html`...` templates (B8G022)
 * and standard HTML5 `data-*` <b8g-*> Streaming Web Components.
 * Embeds cleanly inside VS Code Sectium Workbench, Hyperscaler Desktop, or any browser tab,
 * and auto-reconnects via SSE (`EventSource`) with `since=lastSeq` replay across IDE reloads.
 */

const html = String.raw;

export function renderAgentHostHtml(opts: { port: number; defaultProjectRoot: string }): string {
  const safeRoot = opts.defaultProjectRoot.replace(/"/g, '&quot;');
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>B8G Persistent Agent Host</title>
<style>
  :root {
    --bg: #070b12;
    --panel: #0e1523;
    --panel2: #152035;
    --border: #22324d;
    --text: #e6eefb;
    --muted: #8ea2c2;
    --accent: #38bdf8;
    --ok: #22c55e;
    --warn: #f59e0b;
    --err: #ef4444;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100vh;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    font-size: 13px;
  }
  b8g-section, b8g-intersection, b8g-stream, b8g-surface {
    display: block;
  }
  .app {
    display: grid;
    grid-template-rows: 44px 1fr;
    height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    gap: 10px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
    color: var(--accent);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(34, 197, 94, 0.14);
    border: 1px solid rgba(34, 197, 94, 0.45);
    color: #86efac;
    font-size: 11px;
    font-weight: 700;
  }
  .pill.offline {
    background: rgba(239, 68, 68, 0.14);
    border-color: rgba(239, 68, 68, 0.45);
    color: #fca5a5;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
  }
  .pill.offline .dot { background: var(--err); box-shadow: none; }
  .layout {
    display: grid;
    grid-template-columns: 236px 1fr;
    min-height: 0;
  }
  .sidebar {
    background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 10px;
    gap: 8px;
    min-height: 0;
  }
  .session-list {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sess-item {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--panel2);
    border: 1px solid var(--border);
    cursor: pointer;
    text-align: left;
    color: var(--text);
  }
  .sess-item:hover, .sess-item.active {
    border-color: var(--accent);
    background: rgba(56, 189, 248, 0.14);
  }
  .sess-meta {
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .main {
    display: grid;
    grid-template-rows: auto 1fr auto;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #0b111e;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  input, select, textarea, button {
    font-family: inherit;
    font-size: 12px;
  }
  .field {
    background: #080d16;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
  }
  .btn {
    background: var(--panel2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
    font-weight: 600;
  }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: #0ea5e9; border-color: #0ea5e9; color: #fff; }
  .stream {
    overflow: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg {
    max-width: 880px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--panel);
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .msg.user {
    align-self: flex-end;
    background: rgba(14, 165, 233, 0.16);
    border-color: rgba(56, 189, 248, 0.45);
  }
  .msg.system {
    background: rgba(148, 163, 184, 0.08);
    color: var(--muted);
    font-size: 11.5px;
  }
  .msg.thought {
    background: rgba(167, 139, 250, 0.1);
    border-color: rgba(167, 139, 250, 0.35);
    color: #ddd6fe;
    font-size: 11.5px;
  }
  .msg.error {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.45);
    color: #fecaca;
  }
  .composer {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  .composer textarea {
    flex: 1;
    resize: none;
    height: 44px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #080d16;
    color: var(--text);
    border: 1px solid var(--border);
  }
</style>
</head>
<body>
<b8g-section data-kind="intersection-ui" data-surface="html-dom" data-liveness="live" class="app">
  <header class="topbar">
    <div class="brand">
      <span>⚡ B8G Persistent Agent Host</span>
      <span class="pill" id="livePill"><span class="dot"></span><span id="liveTxt">ONLINE · PID —</span></span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;font-size:11.5px;color:var(--muted);">
      <span id="metaStats">Clients: 1 · Port ${opts.port}</span>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <button class="btn primary" id="btnNewSession">+ New Persistent Session</button>
      <input class="field" id="newProjectRoot" value="${safeRoot}" placeholder="Project root path..." />
      <select class="field" id="newBackend">
        <option value="antigravity-sdk">Antigravity SDK (google-antigravity)</option>
        <option value="b8g-llm-studio">Sovereign LLM Studio (:7497)</option>
        <option value="echo-local">Local Health Echo</option>
      </select>
      <div style="font-size:10.5px;text-transform:uppercase;color:var(--muted);letter-spacing:0.6px;margin-top:4px;">
        Survives VS Code Reloads
      </div>
      <div class="session-list" id="sessionList"></div>
    </aside>

    <main class="main">
      <div class="toolbar">
        <strong id="activeTitle">Connecting...</strong>
        <span id="activeMeta" style="color:var(--muted);font-size:11.5px;"></span>
      </div>
      <b8g-stream data-kind="sse-event-stream" data-liveness="streaming" class="stream" id="streamBox"></b8g-stream>
      <form class="composer" id="composerForm">
        <textarea id="promptInput" placeholder="Message persistent agent (Shift+Enter for newline, Enter to send)..."></textarea>
        <button type="submit" class="btn primary" id="btnSend">Send</button>
      </form>
    </main>
  </div>
</b8g-section>

<script>
  const sessionListEl = document.getElementById('sessionList');
  const streamBox = document.getElementById('streamBox');
  const activeTitle = document.getElementById('activeTitle');
  const activeMeta = document.getElementById('activeMeta');
  const livePill = document.getElementById('livePill');
  const liveTxt = document.getElementById('liveTxt');
  const metaStats = document.getElementById('metaStats');
  const promptInput = document.getElementById('promptInput');

  let activeSessionId = localStorage.getItem('b8gAgentHost.activeSession') || '';
  let lastSeq = 0;
  let es = null;
  let activeAssistantBubble = null;

  function appendBubble(cls, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    streamBox.appendChild(div);
    streamBox.scrollTop = streamBox.scrollHeight;
    return div;
  }

  function renderEvent(ev) {
    if (ev.seq && ev.seq > lastSeq) lastSeq = ev.seq;
    if (ev.type === 'user') {
      activeAssistantBubble = null;
      appendBubble('user', ev.text || '');
    } else if (ev.type === 'thought') {
      appendBubble('thought', '💭 ' + (ev.text || ''));
    } else if (ev.type === 'tool_call') {
      appendBubble('thought', '🔧 ' + (ev.tool || 'tool') + ' ' + JSON.stringify(ev.args || {}));
    } else if (ev.type === 'token') {
      if (!activeAssistantBubble) activeAssistantBubble = appendBubble('assistant', '');
      activeAssistantBubble.textContent += ev.text || '';
      streamBox.scrollTop = streamBox.scrollHeight;
    } else if (ev.type === 'assistant_done') {
      if (!activeAssistantBubble && ev.text) appendBubble('assistant', ev.text);
      activeAssistantBubble = null;
    } else if (ev.type === 'system') {
      appendBubble('system', ev.text || '');
    } else if (ev.type === 'error') {
      activeAssistantBubble = null;
      appendBubble('error', 'Error: ' + (ev.text || ''));
    }
  }

  function connectStream(sessionId) {
    if (es) { es.close(); es = null; }
    streamBox.innerHTML = '';
    activeAssistantBubble = null;
    lastSeq = 0;
    activeSessionId = sessionId;
    localStorage.setItem('b8gAgentHost.activeSession', sessionId);

    const openEs = () => {
      es = new EventSource('/api/sessions/' + encodeURIComponent(sessionId) + '/stream?since=' + lastSeq);
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          renderEvent(ev);
        } catch {}
      };
      es.onerror = () => {
        livePill.classList.add('offline');
        liveTxt.textContent = 'RECONNECTING...';
      };
      es.onopen = () => {
        refreshHealth();
      };
    };
    openEs();
  }

  async function refreshHealth() {
    try {
      const r = await fetch('/api/health');
      const h = await r.json();
      livePill.classList.remove('offline');
      liveTxt.textContent = 'ONLINE · PID ' + h.pid + ' · ' + h.uptimeSec + 's';
      metaStats.textContent = 'Clients: ' + h.activeClients + ' · Sessions: ' + h.sessions + ' · Port ' + h.port;
    } catch {
      livePill.classList.add('offline');
      liveTxt.textContent = 'OFFLINE';
    }
  }

  async function loadSessions() {
    const r = await fetch('/api/sessions');
    const data = await r.json();
    const list = data.sessions || [];
    sessionListEl.innerHTML = '';
    if (!activeSessionId && list.length > 0) activeSessionId = list[0].id;
    for (const s of list) {
      const btn = document.createElement('button');
      btn.className = 'sess-item' + (s.id === activeSessionId ? ' active' : '');
      btn.innerHTML =
        '<div><strong>' + s.title.replace(/</g, '&lt;') + '</strong></div>' +
        '<div class="sess-meta">' + s.backend + ' · ' + s.projectRoot.replace(/</g, '&lt;') + '</div>';
      btn.onclick = () => {
        activeTitle.textContent = s.title;
        activeMeta.textContent = s.id + ' · ' + s.backend + ' · ' + s.projectRoot;
        connectStream(s.id);
        loadSessions();
      };
      sessionListEl.appendChild(btn);
      if (s.id === activeSessionId) {
        activeTitle.textContent = s.title;
        activeMeta.textContent = s.id + ' · ' + s.backend + ' · ' + s.projectRoot;
      }
    }
    if (activeSessionId && !es) connectStream(activeSessionId);
  }

  document.getElementById('btnNewSession').onclick = async () => {
    const projectRoot = document.getElementById('newProjectRoot').value.trim();
    const backend = document.getElementById('newBackend').value;
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot, backend }),
    });
    const d = await r.json();
    if (d.session && d.session.id) {
      activeSessionId = d.session.id;
      connectStream(activeSessionId);
      await loadSessions();
    }
  };

  async function sendPrompt() {
    const text = promptInput.value.trim();
    if (!text || !activeSessionId) return;
    promptInput.value = '';
    await fetch('/api/sessions/' + encodeURIComponent(activeSessionId) + '/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  document.getElementById('composerForm').onsubmit = (e) => {
    e.preventDefault();
    sendPrompt();
  };
  promptInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  };

  refreshHealth();
  loadSessions();
  setInterval(refreshHealth, 8000);
</script>
</body>
</html>`;
}
