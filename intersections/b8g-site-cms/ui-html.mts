/**
 * @file ui-html.mts
 * @description Dark-glass Multi-Tenant / Multi-Site Sovereign CMS, Publishing Scheduler,
 * and PHP-WASI (`@wp/env`) Sandbox UI for `intersections/b8g-site-cms`.
 * B8G022 compliant (`const html = String.raw`) + HTML5 `data-*` attributes on `<b8g-*>`.
 */

const html = String.raw;

export function renderSiteCmsHtml(opts: { port: number }): string {
  const port = opts.port;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Awesome-OS · Multi-Site Sovereign CMS &amp; Publishing Scheduler</title>
  <style>
    :root {
      --bg: #070b12;
      --panel: rgba(15, 23, 42, 0.78);
      --panel-solid: #0f172a;
      --panel-2: rgba(30, 41, 59, 0.62);
      --border: rgba(148, 163, 184, 0.18);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-2: #818cf8;
      --ok: #34d399;
      --warn: #fbbf24;
      --err: #f87171;
      --radius: 10px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: radial-gradient(circle at 18% 0%, #111c34 0%, var(--bg) 55%);
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      overflow: hidden;
    }
    b8g-section {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(14px);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.02em;
      color: #f8fafc;
      margin-right: 6px;
    }
    .badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.16);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.3);
      font-family: var(--mono);
    }
    .topbar label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    select, input, textarea, button {
      font-family: inherit;
      font-size: 12.5px;
      color: var(--text);
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 6px 9px;
      outline: none;
    }
    select:focus, input:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.16);
    }
    button {
      cursor: pointer;
      background: var(--panel-2);
      transition: background 120ms ease, border-color 120ms ease;
      font-weight: 500;
    }
    button:hover {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.45);
    }
    button.primary {
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.28), rgba(129, 140, 248, 0.28));
      border-color: rgba(56, 189, 248, 0.5);
      color: #f8fafc;
    }
    button.ok {
      background: rgba(52, 211, 153, 0.18);
      border-color: rgba(52, 211, 153, 0.45);
      color: #a7f3d0;
    }
    button.warn {
      background: rgba(251, 191, 36, 0.16);
      border-color: rgba(251, 191, 36, 0.45);
      color: #fde68a;
    }
    .spacer { flex: 1; }
    .status-toast {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--ok);
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-toast.error { color: var(--err); }
    .workspace {
      display: grid;
      grid-template-columns: 270px 1fr 410px;
      gap: 10px;
      padding: 10px;
      flex: 1;
      min-height: 0;
    }
    .col {
      display: flex;
      flex-direction: column;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      backdrop-filter: blur(12px);
      min-height: 0;
      overflow: hidden;
    }
    .col-header {
      padding: 9px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 12.5px;
      color: #f1f5f9;
      background: rgba(15, 23, 42, 0.55);
      flex-shrink: 0;
    }
    .col-body {
      padding: 10px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .pipeline-group {
      border: 1px solid rgba(148, 163, 184, 0.12);
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.45);
      overflow: hidden;
    }
    .pipeline-group-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 9px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      background: rgba(30, 41, 59, 0.45);
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    }
    .page-item {
      padding: 7px 9px;
      cursor: pointer;
      border-bottom: 1px solid rgba(148, 163, 184, 0.08);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .page-item:last-child { border-bottom: none; }
    .page-item:hover { background: rgba(56, 189, 248, 0.08); }
    .page-item.active {
      background: rgba(56, 189, 248, 0.16);
      border-left: 3px solid var(--accent);
    }
    .page-item-title {
      font-weight: 600;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .page-item-meta {
      font-size: 11px;
      color: var(--muted);
      font-family: var(--mono);
      display: flex;
      justify-content: space-between;
      gap: 6px;
    }
    .editor-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 170px;
      gap: 8px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    textarea#pageBody {
      flex: 1;
      min-height: 220px;
      resize: none;
      font-family: var(--mono);
      font-size: 12.5px;
      line-height: 1.5;
      padding: 10px;
    }
    .action-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
    .tabs {
      display: flex;
      gap: 4px;
    }
    .tab-btn {
      padding: 4px 8px;
      font-size: 11.5px;
      border-radius: 6px;
    }
    .tab-btn.active {
      background: rgba(56, 189, 248, 0.22);
      border-color: var(--accent);
      color: #f8fafc;
    }
    .preview-frame {
      width: 100%;
      flex: 1;
      min-height: 240px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #050810;
    }
    .review-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 180px;
      overflow-y: auto;
    }
    .review-card {
      padding: 7px 9px;
      border-radius: 7px;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.6);
      font-size: 12px;
    }
    .review-card .verdict-approved { color: var(--ok); font-weight: 600; }
    .review-card .verdict-changes { color: var(--warn); font-weight: 600; }
    .wp-env-panel {
      display: none;
      flex-direction: column;
      gap: 8px;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .wp-env-panel.visible { display: flex; }
    .env-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px;
      background: rgba(15, 23, 42, 0.65);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .env-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .env-status {
      font-family: var(--mono);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 999px;
    }
    .env-status.running { background: rgba(52, 211, 153, 0.2); color: var(--ok); }
    .env-status.stopped { background: rgba(148, 163, 184, 0.2); color: var(--muted); }
    pre.code-box {
      margin: 0;
      padding: 8px;
      border-radius: 7px;
      background: rgba(2, 6, 23, 0.85);
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 11px;
      color: #cbd5e1;
      overflow: auto;
      max-height: 170px;
      white-space: pre-wrap;
    }
    dialog {
      background: #0f172a;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      width: min(440px, 92vw);
    }
    dialog::backdrop { background: rgba(2, 6, 23, 0.72); backdrop-filter: blur(4px); }
    .dialog-grid { display: flex; flex-direction: column; gap: 10px; margin: 10px 0 14px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
    @media (max-width: 1080px) {
      .workspace { grid-template-columns: 220px 1fr 320px; }
    }
  </style>
</head>
<body>
  <b8g-section id="b8g.site.cms" data-kind="cms-studio" data-surface="html-dom" data-liveness="live">
    <header class="topbar">
      <div class="brand">
        <span>📝 B8G Site CMS</span>
        <span class="badge">:${port}</span>
      </div>
      <label>
        Tenant
        <select id="tenantFilter">
          <option value="">All Tenants</option>
        </select>
      </label>
      <label>
        Site
        <select id="siteSelect"></select>
      </label>
      <button id="btnNewSite" type="button">+ New Site</button>
      <button id="btnNewPage" class="primary" type="button">+ New Page</button>
      <div class="spacer"></div>
      <span id="statusToast" class="status-toast">Ready</span>
    </header>

    <main class="workspace">
      <!-- Left Column: Editorial Pipeline -->
      <section class="col" aria-label="Editorial Pipeline">
        <div class="col-header">
          <span>Editorial Pipeline</span>
          <span id="pageCountBadge" class="badge">0</span>
        </div>
        <div id="pipelineContainer" class="col-body"></div>
      </section>

      <!-- Center Column: Page Editor & Workflow Actions -->
      <section class="col" aria-label="Content Editor">
        <div class="col-header">
          <span id="editorHeaderTitle">Content Editor</span>
          <span id="editorStatusBadge" class="badge">draft</span>
        </div>
        <div class="col-body">
          <div class="editor-grid">
            <div class="field">
              <label for="pageTitle">Title</label>
              <input id="pageTitle" type="text" placeholder="Page title" />
            </div>
            <div class="field">
              <label for="pageSlug">Slug</label>
              <input id="pageSlug" type="text" placeholder="welcome" />
            </div>
            <div class="field">
              <label for="pageFormat">Format</label>
              <select id="pageFormat">
                <option value="markdown">markdown</option>
                <option value="gutenberg-blocks">gutenberg-blocks</option>
                <option value="b8g-html">b8g-html</option>
              </select>
            </div>
          </div>

          <div class="field" style="flex:1; min-height:0;">
            <label for="pageBody">Body</label>
            <textarea id="pageBody" placeholder="# Hello Awesome-OS&#10;&#10;Write Markdown, WordPress Gutenberg blocks, or B8G HTML..."></textarea>
          </div>

          <div class="action-bar">
            <button id="btnSaveDraft" type="button">Save Draft</button>
            <button id="btnSubmitReview" type="button">Submit for Review</button>
            <button id="btnApprove" class="ok" type="button">Approve</button>
            <button id="btnStagePreview" class="primary" type="button">Stage &amp; Preview</button>
            <input id="scheduleInput" type="datetime-local" title="Schedule publish time" />
            <button id="btnSchedule" class="warn" type="button">Schedule Publish</button>
            <button id="btnPublish" class="ok" type="button">Publish to GitHub Pages</button>
          </div>
        </div>
      </section>

      <!-- Right Column: Live Staging Preview, Review History & PHP-WASI Env -->
      <section class="col" aria-label="Preview and WASI Sandbox">
        <div class="col-header">
          <div class="tabs">
            <button id="tabPreview" class="tab-btn active" type="button">Staging &amp; Reviews</button>
            <button id="tabWpEnv" class="tab-btn" type="button">🐘 PHP-WASI Env (@wp/env)</button>
          </div>
          <a id="openPreviewLink" href="#" target="_blank" style="color:var(--accent);font-size:11.5px;text-decoration:none;">Open ↗</a>
        </div>

        <div id="previewPane" class="col-body">
          <iframe id="stagingFrame" class="preview-frame" title="Live Staging Preview"></iframe>
          <div>
            <div style="font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">
              Review History
            </div>
            <div id="reviewList" class="review-list"></div>
          </div>
        </div>

        <div id="wpEnvPane" class="col-body wp-env-panel">
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="wpEnvName" type="text" placeholder="new-wp-env-name" style="flex:1;" />
            <select id="wpEnvPhp">
              <option value="8.3">PHP 8.3</option>
              <option value="8.4">PHP 8.4</option>
              <option value="8.2">PHP 8.2</option>
            </select>
            <button id="btnCreateWpEnv" class="primary" type="button">+ Env</button>
          </div>
          <div id="wpEnvList" style="display:flex;flex-direction:column;gap:8px;"></div>
          <div id="wpConfigPreviewWrap" style="display:none;flex-direction:column;gap:6px;">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">Generated wp-config.php</div>
            <pre id="wpConfigCode" class="code-box"></pre>
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;">.wp-env.json</div>
            <pre id="wpEnvJsonCode" class="code-box"></pre>
          </div>
        </div>
      </section>
    </main>
  </b8g-section>

  <!-- New Site Modal -->
  <dialog id="newSiteDialog">
    <h3 style="margin:0;">Create Multi-Tenant Site</h3>
    <div class="dialog-grid">
      <div class="field">
        <label for="newSiteTenant">Tenant ID</label>
        <input id="newSiteTenant" type="text" value="awesome-os" />
      </div>
      <div class="field">
        <label for="newSiteName">Site Name</label>
        <input id="newSiteName" type="text" placeholder="My Sovereign Site" />
      </div>
      <div class="field">
        <label for="newSiteDomain">Domain / CNAME</label>
        <input id="newSiteDomain" type="text" placeholder="docs.awesome-os.com" />
      </div>
      <div class="field">
        <label for="newSiteRepo">GitHub Pages Repo</label>
        <input id="newSiteRepo" type="text" placeholder="awesome-os/docs.awesome-os.com" />
      </div>
    </div>
    <div class="dialog-actions">
      <button id="btnCancelNewSite" type="button">Cancel</button>
      <button id="btnConfirmNewSite" class="primary" type="button">Create Site</button>
    </div>
  </dialog>

  <script type="module">
    const STATUS_GROUPS = [
      { key: 'draft', label: 'Draft' },
      { key: 'in-review', label: 'In Review' },
      { key: 'approved', label: 'Approved' },
      { key: 'staging', label: 'Staging' },
      { key: 'scheduled', label: 'Scheduled' },
      { key: 'published', label: 'Published' },
    ];

    const state = {
      sites: [],
      pages: [],
      wpEnvs: [],
      tenantId: '',
      siteId: '',
      selectedPageId: '',
    };

    const $ = (id) => document.getElementById(id);

    function toast(msg, isError = false) {
      const el = $('statusToast');
      el.textContent = msg;
      el.className = isError ? 'status-toast error' : 'status-toast';
    }

    async function api(url, opts) {
      const res = await fetch(url, {
        headers: { 'content-type': 'application/json' },
        ...opts,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      return data;
    }

    function currentSite() {
      return state.sites.find((s) => s.id === state.siteId) || state.sites[0] || null;
    }

    function currentPage() {
      return state.pages.find((p) => p.id === state.selectedPageId) || null;
    }

    async function refreshSites() {
      const q = state.tenantId ? ('?tenantId=' + encodeURIComponent(state.tenantId)) : '';
      const data = await api('/api/sites' + q);
      state.sites = data.sites || [];

      // Populate tenant filter from all sites when unfiltered
      if (!state.tenantId) {
        const tenants = Array.from(new Set(state.sites.map((s) => s.tenantId))).sort();
        const tf = $('tenantFilter');
        const prev = tf.value;
        tf.innerHTML = '<option value="">All Tenants</option>' +
          tenants.map((t) => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('');
        tf.value = prev;
      }

      const sel = $('siteSelect');
      sel.innerHTML = state.sites.map((s) =>
        '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.domain) + ' (' + escapeHtml(s.tenantId) + ')</option>'
      ).join('');

      if (!state.sites.some((s) => s.id === state.siteId)) {
        state.siteId = state.sites[0] ? state.sites[0].id : '';
      }
      sel.value = state.siteId;
    }

    async function refreshPages() {
      const params = new URLSearchParams();
      if (state.tenantId) params.set('tenantId', state.tenantId);
      if (state.siteId) params.set('siteId', state.siteId);
      const q = params.toString() ? ('?' + params.toString()) : '';
      const data = await api('/api/pages' + q);
      state.pages = data.pages || [];
      $('pageCountBadge').textContent = String(state.pages.length);

      if (!state.pages.some((p) => p.id === state.selectedPageId)) {
        state.selectedPageId = state.pages[0] ? state.pages[0].id : '';
      }
      renderPipeline();
      renderEditor();
    }

    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderPipeline() {
      const root = $('pipelineContainer');
      root.innerHTML = '';
      for (const grp of STATUS_GROUPS) {
        const items = state.pages.filter((p) => p.status === grp.key);
        const wrap = document.createElement('div');
        wrap.className = 'pipeline-group';
        wrap.innerHTML =
          '<div class="pipeline-group-title"><span>' + grp.label + '</span><span>' + items.length + '</span></div>';
        for (const p of items) {
          const row = document.createElement('div');
          row.className = 'page-item' + (p.id === state.selectedPageId ? ' active' : '');
          row.innerHTML =
            '<div class="page-item-title">' + escapeHtml(p.title) + '</div>' +
            '<div class="page-item-meta"><span>/' + escapeHtml(p.slug) + '</span><span>' + escapeHtml(p.format) + '</span></div>';
          row.addEventListener('click', () => {
            state.selectedPageId = p.id;
            renderPipeline();
            renderEditor();
          });
          wrap.appendChild(row);
        }
        root.appendChild(wrap);
      }
    }

    function renderEditor() {
      const p = currentPage();
      if (!p) {
        $('editorHeaderTitle').textContent = 'No page selected';
        $('editorStatusBadge').textContent = '-';
        $('pageTitle').value = '';
        $('pageSlug').value = '';
        $('pageFormat').value = 'markdown';
        $('pageBody').value = '';
        $('reviewList').innerHTML = '<div style="color:var(--muted);">No reviews yet.</div>';
        $('stagingFrame').src = 'about:blank';
        return;
      }

      $('editorHeaderTitle').textContent = p.title + ' · ' + p.id;
      $('editorStatusBadge').textContent = p.status;
      $('pageTitle').value = p.title;
      $('pageSlug').value = p.slug;
      $('pageFormat').value = p.format;
      $('pageBody').value = p.body;
      if (p.scheduledAt) {
        $('scheduleInput').value = p.scheduledAt.slice(0, 16);
      }

      const previewUrl = '/staging/' + encodeURIComponent(p.siteId) + '/' + encodeURIComponent(p.slug);
      $('openPreviewLink').href = previewUrl;
      $('stagingFrame').src = previewUrl;

      const list = $('reviewList');
      if (!p.reviews || p.reviews.length === 0) {
        list.innerHTML = '<div style="color:var(--muted);">No editorial reviews recorded yet.</div>';
      } else {
        list.innerHTML = p.reviews.map((r) => {
          const cls = r.verdict === 'approved' ? 'verdict-approved' : 'verdict-changes';
          return '<div class="review-card">' +
            '<div><span class="' + cls + '">' + escapeHtml(r.verdict) + '</span> · <strong>' + escapeHtml(r.reviewer) + '</strong> <span style="color:var(--muted);font-size:11px;">' + escapeHtml(r.ts) + '</span></div>' +
            '<div style="margin-top:3px;color:#cbd5e1;">' + escapeHtml(r.note) + '</div>' +
            '</div>';
        }).join('');
      }
    }

    async function refreshWpEnvs() {
      const q = state.tenantId ? ('?tenantId=' + encodeURIComponent(state.tenantId)) : '';
      const data = await api('/api/wp-env' + q);
      state.wpEnvs = data.envs || [];
      const list = $('wpEnvList');
      list.innerHTML = '';
      for (const env of state.wpEnvs) {
        const card = document.createElement('div');
        card.className = 'env-card';
        const isRunning = env.status === 'running';
        card.innerHTML =
          '<div class="env-card-head">' +
            '<strong>' + escapeHtml(env.name) + '</strong>' +
            '<span class="env-status ' + (isRunning ? 'running' : 'stopped') + '">' + escapeHtml(env.status) + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' +
            'PHP ' + escapeHtml(env.envConfig.phpVersion) + ' · ' + escapeHtml(env.dbEngine) +
            ' · port ' + escapeHtml(env.envConfig.port) + (env.envConfig.multisite ? ' · multisite' : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button data-act="start" class="ok" type="button">Start</button>' +
            '<button data-act="stop" type="button">Stop</button>' +
            '<button data-act="mount" type="button">+ Mount Plugin</button>' +
            '<button data-act="config" type="button">wp-config.php</button>' +
          '</div>';
        card.querySelector('[data-act="start"]').addEventListener('click', async () => {
          try {
            await api('/api/wp-env/' + encodeURIComponent(env.id) + '/start', { method: 'POST', body: '{}' });
            toast('Started PHP-WASI env ' + env.name);
            await refreshWpEnvs();
          } catch (e) { toast(e.message, true); }
        });
        card.querySelector('[data-act="stop"]').addEventListener('click', async () => {
          try {
            await api('/api/wp-env/' + encodeURIComponent(env.id) + '/stop', { method: 'POST', body: '{}' });
            toast('Stopped PHP-WASI env ' + env.name);
            await refreshWpEnvs();
          } catch (e) { toast(e.message, true); }
        });
        card.querySelector('[data-act="mount"]').addEventListener('click', async () => {
          const src = prompt('Plugin path or slug to mount into WASI VFS:', './plugins/b8g-blocks');
          if (!src) return;
          try {
            await api('/api/wp-env/' + encodeURIComponent(env.id) + '/mount', {
              method: 'POST',
              body: JSON.stringify({ kind: 'plugin', source: src }),
            });
            toast('Mounted plugin ' + src);
            await refreshWpEnvs();
          } catch (e) { toast(e.message, true); }
        });
        card.querySelector('[data-act="config"]').addEventListener('click', async () => {
          try {
            const cfg = await api('/api/wp-env/' + encodeURIComponent(env.id) + '/wp-config');
            $('wpConfigPreviewWrap').style.display = 'flex';
            $('wpConfigCode').textContent = cfg.wpConfigPhp || '';
            $('wpEnvJsonCode').textContent = cfg.wpEnvJson || '';
            toast('Loaded wp-config.php for ' + env.name);
          } catch (e) { toast(e.message, true); }
        });
        list.appendChild(card);
      }
    }

    // Event wiring
    $('tenantFilter').addEventListener('change', async (e) => {
      state.tenantId = e.target.value;
      await refreshSites();
      await refreshPages();
      await refreshWpEnvs();
    });

    $('siteSelect').addEventListener('change', async (e) => {
      state.siteId = e.target.value;
      await refreshPages();
    });

    $('btnNewSite').addEventListener('click', () => $('newSiteDialog').showModal());
    $('btnCancelNewSite').addEventListener('click', () => $('newSiteDialog').close());
    $('btnConfirmNewSite').addEventListener('click', async () => {
      try {
        const res = await api('/api/sites', {
          method: 'POST',
          body: JSON.stringify({
            tenantId: $('newSiteTenant').value.trim() || 'awesome-os',
            name: $('newSiteName').value.trim() || 'Untitled Site',
            domain: $('newSiteDomain').value.trim(),
            githubRepo: $('newSiteRepo').value.trim(),
          }),
        });
        $('newSiteDialog').close();
        state.siteId = res.site.id;
        await refreshSites();
        await refreshPages();
        toast('Created site ' + res.site.domain);
      } catch (e) { toast(e.message, true); }
    });

    $('btnNewPage').addEventListener('click', async () => {
      const site = currentSite();
      if (!site) return toast('Create a site first', true);
      try {
        const res = await api('/api/pages', {
          method: 'POST',
          body: JSON.stringify({
            siteId: site.id,
            tenantId: site.tenantId,
            slug: 'post-' + Date.now().toString(36),
            title: 'Untitled Page',
            format: 'markdown',
            body: '# New Page\n\nDrafted in B8G Sovereign CMS.',
          }),
        });
        state.selectedPageId = res.page.id;
        await refreshPages();
        toast('Created draft ' + res.page.slug);
      } catch (e) { toast(e.message, true); }
    });

    $('btnSaveDraft').addEventListener('click', async () => {
      const p = currentPage();
      if (!p) return;
      try {
        await api('/api/pages/' + encodeURIComponent(p.id) + '/update', {
          method: 'POST',
          body: JSON.stringify({
            title: $('pageTitle').value,
            slug: $('pageSlug').value,
            format: $('pageFormat').value,
            body: $('pageBody').value,
          }),
        });
        await refreshPages();
        toast('Saved draft');
      } catch (e) { toast(e.message, true); }
    });

    $('btnSubmitReview').addEventListener('click', async () => {
      const p = currentPage();
      if (!p) return;
      try {
        await api('/api/pages/' + encodeURIComponent(p.id) + '/submit-review', { method: 'POST', body: '{}' });
        await refreshPages();
        toast('Submitted for review');
      } catch (e) { toast(e.message, true); }
    });

    $('btnApprove').addEventListener('click', async () => {
      const p = currentPage();
      if (!p) return;
      try {
        await api('/api/pages/' + encodeURIComponent(p.id) + '/review', {
          method: 'POST',
          body: JSON.stringify({ reviewer: 'editor', verdict: 'approved', note: 'Approved in CMS Studio' }),
        });
        await refreshPages();
        toast('Approved page');
      } catch (e) { toast(e.message, true); }
    });

    $('btnStagePreview').addEventListener('click', async () => {
      const p = currentPage();
      if (!p) return;
      try {
        const res = await api('/api/pages/' + encodeURIComponent(p.id) + '/stage', { method: 'POST', body: '{}' });
        await refreshPages();
        if (res.previewUrl) {
          $('stagingFrame').src = res.previewUrl + '?t=' + Date.now();
        }
        toast('Staged preview ready');
      } catch (e) { toast(e.message, true); }
    });

    $('btnSchedule').addEventListener('click', async () => {
      const p = currentPage();
      if (!p) return;
      const raw = $('scheduleInput').value;
      const iso = raw ? new Date(raw).toISOString() : new Date(Date.now() + 60_000).toISOString();
      try {
        await api('/api/pages/' + encodeURIComponent(p.id) + '/schedule', {
          method: 'POST',
          body: JSON.stringify({ scheduledAt: iso }),
        });
        await refreshPages();
        toast('Scheduled for ' + iso);
      } catch (e) { toast(e.message, true); }
    });

    $('btnPublish').addEventListener('click', async () => {
      const p = currentPage();
      if (!p) return;
      try {
        const res = await api('/api/pages/' + encodeURIComponent(p.id) + '/publish', {
          method: 'POST',
          body: JSON.stringify({ pushToGitHub: false }),
        });
        await refreshPages();
        toast('Published & staged GH Pages (' + (res.ghPages?.fileCount ?? 0) + ' files)');
      } catch (e) { toast(e.message, true); }
    });

    $('tabPreview').addEventListener('click', () => {
      $('tabPreview').classList.add('active');
      $('tabWpEnv').classList.remove('active');
      $('previewPane').style.display = 'flex';
      $('wpEnvPane').classList.remove('visible');
    });

    $('tabWpEnv').addEventListener('click', async () => {
      $('tabWpEnv').classList.add('active');
      $('tabPreview').classList.remove('active');
      $('previewPane').style.display = 'none';
      $('wpEnvPane').classList.add('visible');
      await refreshWpEnvs();
    });

    $('btnCreateWpEnv').addEventListener('click', async () => {
      const site = currentSite();
      const name = $('wpEnvName').value.trim() || ('wp-wasi-' + Date.now().toString(36));
      try {
        await api('/api/wp-env', {
          method: 'POST',
          body: JSON.stringify({
            tenantId: site ? site.tenantId : 'awesome-os',
            siteId: site ? site.id : 'awesome-os-com',
            name,
            envConfig: { phpVersion: $('wpEnvPhp').value },
          }),
        });
        $('wpEnvName').value = '';
        await refreshWpEnvs();
        toast('Created PHP-WASI env ' + name);
      } catch (e) { toast(e.message, true); }
    });

    // Boot
    (async () => {
      try {
        await refreshSites();
        await refreshPages();
        await refreshWpEnvs();
      } catch (e) {
        toast('Boot error: ' + e.message, true);
      }
    })();
  </script>
</body>
</html>
`;
}
