/**
 * @file sectium-shell-html.mts
 * @description Unified Sectium Default Interaction Shell (`/shell` on `:7498`).
 * Brings the Antigravity-style full UI-in-UI workbench directly into Sectium:
 *   - Top Bar (Left/Right/Bottom toggles, URL bar, live ONLINE PID pill)
 *   - Collapsible Left Sidebar (Sessions + Embedded Awesome-OS Apps)
 *   - Live Center Viewport (iframe for Commander, LLM Studio, Disk, Hunt, or web)
 *   - Collapsible Right Sidebar (Always-On Persistent Agent Chat docked live via SSE)
 *   - Collapsible Bottom Bar + Quick Dock
 * Tagged with html`...` (B8G022) and HTML5 `data-*` <b8g-*> Streaming Web Components.
 */

const html = String.raw;

export function renderSectiumShellHtml(opts: { port: number; defaultProjectRoot: string }): string {
  const safeRoot = opts.defaultProjectRoot.replace(/"/g, '&quot;');
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sectium — Unified Interaction Shell</title>
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
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100vh;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    font-size: 12.5px;
  }
  b8g-section, b8g-stream, b8g-surface { display: block; }
  .shell {
    display: grid;
    grid-template-rows: 40px 1fr auto;
    height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .brand { font-weight: 800; color: var(--accent); white-space: nowrap; margin-right: 4px; }
  .btn {
    background: var(--panel2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 11.5px;
    white-space: nowrap;
  }
  .btn:hover, .btn.active { border-color: var(--accent); background: rgba(56,189,248,0.16); color: #fff; }
  .btn.primary { background: #0ea5e9; border-color: #0ea5e9; color: #fff; font-weight: 700; }
  .url-input {
    flex: 1;
    min-width: 120px;
    background: #080d16;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 9px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11.5px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(34, 197, 94, 0.14);
    border: 1px solid rgba(34, 197, 94, 0.45);
    color: #86efac;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .mid {
    display: flex;
    min-height: 0;
    overflow: hidden;
  }
  .left-sb {
    width: 215px;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: auto;
  }
  .right-sb {
    width: 370px;
    min-width: 280px;
    background: var(--panel);
    border-left: 1px solid var(--border);
    display: grid;
    grid-template-rows: auto 1fr auto;
    min-height: 0;
  }
  .hidden { display: none !important; }
  .sec-hdr {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--muted);
    margin: 6px 0 2px;
  }
  .nav-btn {
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel2);
    color: var(--text);
    cursor: pointer;
    font-size: 11.5px;
  }
  .nav-btn:hover, .nav-btn.active { border-color: var(--accent); background: rgba(56,189,248,0.16); }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: #060910;
  }
  .center iframe {
    flex: 1;
    width: 100%;
    border: none;
    background: #070b12;
  }
  .agent-hdr {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    background: #0b111e;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .agent-stream {
    overflow: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #0a101c;
    white-space: pre-wrap;
    line-height: 1.45;
  }
  .msg.user { align-self: flex-end; background: rgba(14,165,233,0.18); border-color: rgba(56,189,248,0.45); }
  .msg.thought { background: rgba(167,139,250,0.1); border-color: rgba(167,139,250,0.35); color: #ddd6fe; font-size: 11px; }
  .msg.system { color: var(--muted); font-size: 11px; }
  .msg.error { color: #fecaca; border-color: rgba(239,68,68,0.45); }
  .composer {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
    background: #0b111e;
  }
  .composer textarea {
    flex: 1;
    height: 40px;
    resize: none;
    background: #070b12;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 12px;
  }
  .bottombar {
    background: var(--panel);
    border-top: 1px solid var(--border);
    padding: 5px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .dock-drawer {
    width: 100%;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 6px 8px;
    background: #090d14;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
</style>
</head>
<body>
<b8g-section data-kind="sectium-default-shell" data-surface="html-dom" data-liveness="live" class="shell">
  <!-- TOP BAR -->
  <header class="topbar">
    <span class="brand">🌐 SECTIUM SHELL</span>
    <button class="btn active" id="btnLeft" title="Toggle Left Sidebar">◧</button>
    <button class="btn active" id="btnRight" title="Toggle Antigravity Agent Sidebar">◨ Agent</button>
    <button class="btn active" id="btnBottom" title="Toggle Bottom Bar">⬓</button>
    <button class="btn" id="btnReload" title="Reload Center Viewport">↻</button>
    <input class="url-input" id="urlInput" value="http://127.0.0.1:7490/" placeholder="http://127.0.0.1:7490/ or https://..." />
    <button class="btn primary" id="btnGo">Go</button>
    <span class="pill" id="livePill"><span class="dot"></span><span id="liveTxt">ONLINE</span></span>
  </header>

  <!-- MIDDLE WORKSPACE -->
  <div class="mid">
    <!-- LEFT SIDEBAR -->
    <aside class="left-sb" id="leftSb">
      <div class="sec-hdr">Awesome-OS Apps</div>
      <button class="nav-btn" data-url="http://127.0.0.1:7490/">📁 Sectium Commander</button>
      <button class="nav-btn" data-url="http://127.0.0.1:7497/">🧠 LLM &amp; LoRA Studio</button>
      <button class="nav-btn" data-url="http://127.0.0.1:7496/">💾 Host Disk Analyzer</button>
      <button class="nav-btn" data-url="http://127.0.0.1:7495/">🎮 Asymmetric Hunt 3D</button>
      <button class="nav-btn" data-url="http://127.0.0.1:${opts.port}/">⚡ Full Agent Host UI</button>
      <button class="nav-btn" data-url="http://127.0.0.1:7499/">📝 Sites &amp; CMS</button>

      <div class="sec-hdr">Persistent Sessions</div>
      <button class="btn primary" id="btnNewSess">+ New Session</button>
      <div id="sessList" style="display:flex;flex-direction:column;gap:4px;"></div>
    </aside>

    <!-- CENTER LIVE VIEWPORT -->
    <main class="center">
      <iframe id="viewport" src="http://127.0.0.1:7490/"></iframe>
    </main>

    <!-- RIGHT SIDEBAR: ALWAYS-ON ANTIGRAVITY AGENT CHAT -->
    <aside class="right-sb" id="rightSb">
      <div class="agent-hdr">
        <strong style="color:var(--accent);">⚡ Antigravity Host</strong>
        <span id="agentSessLabel" style="font-size:11px;color:var(--muted);">connecting...</span>
      </div>
      <b8g-stream data-kind="sse-event-stream" data-liveness="streaming" class="agent-stream" id="agentStream"></b8g-stream>
      <form class="composer" id="agentForm">
        <textarea id="agentInput" placeholder="Chat with persistent agent (survives reloads)..."></textarea>
        <button type="submit" class="btn primary">Send</button>
      </form>
    </aside>
  </div>

  <!-- BOTTOM BAR -->
  <footer class="bottombar" id="bottomBar">
    <div class="dock-drawer hidden" id="dockDrawer">
      <button class="btn" data-url="http://127.0.0.1:7490/">📁 Commander (:7490)</button>
      <button class="btn" data-url="http://127.0.0.1:7497/">🧠 LLM Studio (:7497)</button>
      <button class="btn" data-url="http://127.0.0.1:7496/">💾 Disk (:7496)</button>
      <button class="btn" data-url="http://127.0.0.1:7495/">🎮 Hunt 3D (:7495)</button>
      <button class="btn" data-url="http://127.0.0.1:7499/">📝 Sites &amp; CMS (:7499)</button>
    </div>
    <span id="statusTxt" style="font-size:11px;color:var(--muted);">Sectium Unified Interaction Shell · Persistent Agent Host :${opts.port}</span>
    <button class="btn" id="btnDock">▲ Quick Dock</button>
  </footer>
</b8g-section>

<script>
  const viewport = document.getElementById('viewport');
  const urlInput = document.getElementById('urlInput');
  const sessList = document.getElementById('sessList');
  const agentStream = document.getElementById('agentStream');
  const agentSessLabel = document.getElementById('agentSessLabel');
  const agentInput = document.getElementById('agentInput');
  const liveTxt = document.getElementById('liveTxt');
  const statusTxt = document.getElementById('statusTxt');

  let activeSessionId = localStorage.getItem('b8gAgentHost.activeSession') || '';
  let lastSeq = 0;
  let es = null;
  let activeBubble = null;

  function openInViewport(u) {
    urlInput.value = u;
    viewport.src = u;
    statusTxt.textContent = 'Viewport: ' + u;
  }

  document.getElementById('btnLeft').onclick = (e) => {
    const el = document.getElementById('leftSb');
    el.classList.toggle('hidden');
    e.currentTarget.classList.toggle('active', !el.classList.contains('hidden'));
  };
  document.getElementById('btnRight').onclick = (e) => {
    const el = document.getElementById('rightSb');
    el.classList.toggle('hidden');
    e.currentTarget.classList.toggle('active', !el.classList.contains('hidden'));
  };
  document.getElementById('btnBottom').onclick = (e) => {
    const el = document.getElementById('bottomBar');
    el.classList.toggle('hidden');
    e.currentTarget.classList.toggle('active', !el.classList.contains('hidden'));
  };
  document.getElementById('btnDock').onclick = () => document.getElementById('dockDrawer').classList.toggle('hidden');
  document.getElementById('btnReload').onclick = () => { viewport.src = viewport.src; };
  document.getElementById('btnGo').onclick = () => openInViewport(urlInput.value.trim());
  urlInput.onkeydown = (e) => { if (e.key === 'Enter') openInViewport(urlInput.value.trim()); };
  document.querySelectorAll('[data-url]').forEach((b) => {
    b.onclick = () => openInViewport(b.getAttribute('data-url'));
  });

  function pushMsg(cls, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    agentStream.appendChild(d);
    agentStream.scrollTop = agentStream.scrollHeight;
    return d;
  }

  function renderEv(ev) {
    if (ev.seq && ev.seq > lastSeq) lastSeq = ev.seq;
    if (ev.type === 'user') { activeBubble = null; pushMsg('user', ev.text || ''); }
    else if (ev.type === 'thought') pushMsg('thought', '💭 ' + (ev.text || ''));
    else if (ev.type === 'tool_call') pushMsg('thought', '🔧 ' + (ev.tool || 'tool'));
    else if (ev.type === 'token') {
      if (!activeBubble) activeBubble = pushMsg('assistant', '');
      activeBubble.textContent += ev.text || '';
      agentStream.scrollTop = agentStream.scrollHeight;
    } else if (ev.type === 'assistant_done') {
      if (!activeBubble && ev.text) pushMsg('assistant', ev.text);
      activeBubble = null;
    } else if (ev.type === 'system') pushMsg('system', ev.text || '');
    else if (ev.type === 'error') { activeBubble = null; pushMsg('error', 'Error: ' + (ev.text || '')); }
  }

  function connect(sid) {
    if (es) { es.close(); es = null; }
    agentStream.innerHTML = '';
    activeBubble = null;
    lastSeq = 0;
    activeSessionId = sid;
    localStorage.setItem('b8gAgentHost.activeSession', sid);
    es = new EventSource('/api/sessions/' + encodeURIComponent(sid) + '/stream?since=' + lastSeq);
    es.onmessage = (m) => { try { renderEv(JSON.parse(m.data)); } catch {} };
  }

  async function refresh() {
    try {
      const h = await (await fetch('/api/health')).json();
      liveTxt.textContent = 'ONLINE · PID ' + h.pid;
    } catch { liveTxt.textContent = 'OFFLINE'; }
    const data = await (await fetch('/api/sessions')).json();
    const list = data.sessions || [];
    sessList.innerHTML = '';
    if (!activeSessionId && list.length > 0) activeSessionId = list[0].id;
    for (const s of list) {
      const b = document.createElement('button');
      b.className = 'nav-btn' + (s.id === activeSessionId ? ' active' : '');
      b.textContent = '⚡ ' + s.title;
      b.onclick = () => {
        agentSessLabel.textContent = s.title;
        connect(s.id);
        refresh();
      };
      sessList.appendChild(b);
      if (s.id === activeSessionId) agentSessLabel.textContent = s.title;
    }
    if (activeSessionId && !es) connect(activeSessionId);
  }

  document.getElementById('btnNewSess').onclick = async () => {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: "${safeRoot}" }),
    });
    const d = await r.json();
    if (d.session && d.session.id) {
      connect(d.session.id);
      await refresh();
    }
  };

  async function send() {
    const text = agentInput.value.trim();
    if (!text || !activeSessionId) return;
    agentInput.value = '';
    await fetch('/api/sessions/' + encodeURIComponent(activeSessionId) + '/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }
  document.getElementById('agentForm').onsubmit = (e) => { e.preventDefault(); send(); };
  agentInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  refresh();
  setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
