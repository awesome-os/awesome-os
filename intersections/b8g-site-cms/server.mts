/**
 * @file server.mts
 * @description HTTP server & publishing scheduler for B8G Multi-Site Sovereign CMS (`:7499`).
 */

import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CmsStore, type ContentStatus, type CmsPage, type CmsSite } from './cms-store.mts';
import { compilePageToHtml, writeStagingPreview } from './wp-block-compiler.mts';
import { WpEnvWasiManager, parseWpEnvJson, generateWpConfigPhp, type WpEnvConfig } from './wp-env-wasi.mts';
import { stageGhPagesRepo, publishGhPagesRepo } from '../../site/publish-gh-pages.host.mts';
import { renderSiteCmsHtml } from './ui-html.mts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');

export interface StartSiteCmsServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  stagingDir?: string;
  workspaceRoot?: string;
  enableScheduler?: boolean;
}

export interface SiteCmsServerHandle {
  port: number;
  url: string;
  store: CmsStore;
  wpEnv: WpEnvWasiManager;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sanitizeSegment(seg: string): string {
  return seg.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveStagedHtmlPath(stagingDir: string, siteId: string, slug: string): string | null {
  const cleanSlug = slug.replace(/\.html$/i, '');
  const candidates = [
    path.join(stagingDir, siteId, `${cleanSlug}.html`),
    path.join(stagingDir, sanitizeSegment(siteId), `${sanitizeSegment(cleanSlug)}.html`),
    path.join(stagingDir, siteId, cleanSlug, 'index.html'),
    path.join(stagingDir, sanitizeSegment(siteId), sanitizeSegment(cleanSlug), 'index.html'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  return null;
}

function publishPageArtifact(
  site: CmsSite,
  page: CmsPage,
  stagingDir: string,
  workspaceRoot: string,
  opts: { pushToGitHub?: boolean; createRepo?: boolean; writeToSiteDir?: boolean },
) {
  const compiledHtml = compilePageToHtml({
    title: page.title,
    slug: page.slug,
    format: page.format,
    body: page.body,
    domain: site.domain,
  });

  writeStagingPreview(site, page, stagingDir);

  const safeSlug = sanitizeSegment(page.slug.replace(/^\/+|\/+$/g, '') || 'index');
  const publishSrcDir = path.join(stagingDir, 'publish-src', sanitizeSegment(site.id));
  fs.mkdirSync(publishSrcDir, { recursive: true });

  const fileName = safeSlug === 'index' ? 'index.html' : `${safeSlug}.html`;
  fs.writeFileSync(path.join(publishSrcDir, fileName), compiledHtml, 'utf8');
  if (fileName !== 'index.html' && !fs.existsSync(path.join(publishSrcDir, 'index.html'))) {
    fs.writeFileSync(path.join(publishSrcDir, 'index.html'), compiledHtml, 'utf8');
  }

  if (opts.writeToSiteDir && site.siteDir) {
    const absSiteDir = path.isAbsolute(site.siteDir)
      ? site.siteDir
      : path.resolve(workspaceRoot, site.siteDir);
    fs.mkdirSync(absSiteDir, { recursive: true });
    fs.writeFileSync(path.join(absSiteDir, fileName), compiledHtml, 'utf8');
  }

  const safeRepo = sanitizeSegment(site.githubRepo || site.id);
  const ghOutDir = path.join(stagingDir, 'gh-pages', safeRepo);
  const ghOpts = {
    siteDir: publishSrcDir,
    repo: site.githubRepo,
    outDir: ghOutDir,
    cname: site.domain,
    createRepo: Boolean(opts.createRepo),
  };

  const ghPages = opts.pushToGitHub ? publishGhPagesRepo(ghOpts) : stageGhPagesRepo(ghOpts);
  return { ghPages, previewUrl: `/staging/${encodeURIComponent(site.id)}/${encodeURIComponent(page.slug)}` };
}

export async function startSiteCmsServer(
  opts?: StartSiteCmsServerOptions,
): Promise<SiteCmsServerHandle> {
  const host = opts?.host ?? '127.0.0.1';
  const requestedPort = opts?.port ?? 7499;
  const workspaceRoot = opts?.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const dataDir = opts?.dataDir ?? path.join(workspaceRoot, '.b8g-cas', 'site-cms');
  const stagingDir = opts?.stagingDir ?? path.join(dataDir, 'staging');
  const enableScheduler = opts?.enableScheduler !== false;

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const store = new CmsStore(dataDir);
  const wpEnv = new WpEnvWasiManager(dataDir);
  let activePort = requestedPort;

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${host}:${activePort}`);
      const pathname = urlObj.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (method === 'GET' && pathname === '/') {
        sendHtml(res, 200, renderSiteCmsHtml({ port: activePort }));
        return;
      }

      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'b8g-site-cms',
          pid: process.pid,
          port: activePort,
          sites: store.listSites().length,
          pages: store.listPages().length,
          wpEnvs: wpEnv.listEnvs().length,
        });
        return;
      }

      // Sites
      if (method === 'GET' && pathname === '/api/sites') {
        const tenantId = urlObj.searchParams.get('tenantId') || undefined;
        sendJson(res, 200, { ok: true, sites: store.listSites(tenantId) });
        return;
      }

      if (method === 'POST' && pathname === '/api/sites') {
        const body = await readJsonBody(req);
        const site = store.createSite({
          tenantId: String(body.tenantId || 'default'),
          name: String(body.name || 'Untitled Site'),
          domain: String(body.domain || ''),
          githubRepo: String(body.githubRepo || ''),
          siteDir: typeof body.siteDir === 'string' ? body.siteDir : undefined,
        });
        sendJson(res, 201, { ok: true, site });
        return;
      }

      // Pages
      if (method === 'GET' && pathname === '/api/pages') {
        const tenantId = urlObj.searchParams.get('tenantId') || undefined;
        const siteId = urlObj.searchParams.get('siteId') || undefined;
        const statusParam = urlObj.searchParams.get('status') || undefined;
        const pages = store.listPages({
          tenantId,
          siteId,
          status: statusParam as ContentStatus | undefined,
        });
        sendJson(res, 200, { ok: true, pages });
        return;
      }

      if (method === 'POST' && pathname === '/api/pages') {
        const body = await readJsonBody(req);
        const page = store.createPage({
          siteId: String(body.siteId || ''),
          tenantId: String(body.tenantId || 'default'),
          slug: String(body.slug || ''),
          title: String(body.title || 'Untitled'),
          format: (body.format as CmsPage['format']) || 'markdown',
          body: String(body.body ?? ''),
        });
        sendJson(res, 201, { ok: true, page });
        return;
      }

      // Page actions: /api/pages/:id/:action
      const pageActionMatch = pathname.match(/^\/api\/pages\/([^/]+)\/([a-z-]+)$/);
      if (method === 'POST' && pageActionMatch) {
        const pageId = decodeURIComponent(pageActionMatch[1]!);
        const action = pageActionMatch[2]!;
        const body = await readJsonBody(req);

        if (action === 'update') {
          const page = store.updatePage(pageId, {
            title: typeof body.title === 'string' ? body.title : undefined,
            slug: typeof body.slug === 'string' ? body.slug : undefined,
            body: typeof body.body === 'string' ? body.body : undefined,
            format: body.format as CmsPage['format'] | undefined,
            status: body.status as ContentStatus | undefined,
            scheduledAt: typeof body.scheduledAt === 'string' ? body.scheduledAt : undefined,
          });
          sendJson(res, 200, { ok: true, page });
          return;
        }

        if (action === 'submit-review') {
          const page = store.submitForReview(pageId);
          sendJson(res, 200, { ok: true, page });
          return;
        }

        if (action === 'review') {
          const verdict = body.verdict === 'changes-requested' ? 'changes-requested' : 'approved';
          const page = store.addReview(pageId, {
            reviewer: String(body.reviewer || 'reviewer'),
            verdict,
            note: String(body.note || ''),
          });
          sendJson(res, 200, { ok: true, page });
          return;
        }

        if (action === 'stage') {
          const page = store.stagePage(pageId);
          const site = store.getSite(page.siteId);
          if (!site) {
            sendJson(res, 404, { ok: false, error: `Site not found for page: ${page.siteId}` });
            return;
          }
          const preview = writeStagingPreview(site, page, stagingDir);
          const previewUrl = `/staging/${encodeURIComponent(site.id)}/${encodeURIComponent(page.slug)}`;
          sendJson(res, 200, {
            ok: true,
            page,
            previewUrl,
            filePath: preview.filePath,
            relPath: preview.relPath,
          });
          return;
        }

        if (action === 'schedule') {
          const scheduledAt = String(body.scheduledAt || '');
          if (!scheduledAt) {
            sendJson(res, 400, { ok: false, error: 'scheduledAt ISO timestamp is required' });
            return;
          }
          const page = store.schedulePage(pageId, scheduledAt);
          sendJson(res, 200, { ok: true, page });
          return;
        }

        if (action === 'publish') {
          const existing = store.getPage(pageId);
          if (!existing) {
            sendJson(res, 404, { ok: false, error: `Page not found: ${pageId}` });
            return;
          }
          const site = store.getSite(existing.siteId);
          if (!site) {
            sendJson(res, 404, { ok: false, error: `Site not found: ${existing.siteId}` });
            return;
          }
          const result = publishPageArtifact(site, existing, stagingDir, workspaceRoot, {
            pushToGitHub: Boolean(body.pushToGitHub),
            createRepo: Boolean(body.createRepo),
            writeToSiteDir: Boolean(body.writeToSiteDir),
          });
          const page = store.markPublished(pageId);
          sendJson(res, 200, {
            ok: true,
            page,
            previewUrl: result.previewUrl,
            ghPages: result.ghPages,
            pushed: Boolean(body.pushToGitHub),
          });
          return;
        }
      }

      // Live Staging Preview: GET /staging/:siteId/:slug
      const stagingMatch = pathname.match(/^\/staging\/([^/]+)\/(.+)$/);
      if (method === 'GET' && stagingMatch) {
        const siteId = decodeURIComponent(stagingMatch[1]!);
        const slug = decodeURIComponent(stagingMatch[2]!).replace(/\.html$/i, '');
        const stagedPath = resolveStagedHtmlPath(stagingDir, siteId, slug);
        if (stagedPath) {
          sendHtml(res, 200, fs.readFileSync(stagedPath, 'utf8'));
          return;
        }
        const site = store.getSite(siteId);
        const page = store.listPages({ siteId }).find((p) => p.slug === slug);
        if (page) {
          const compiled = compilePageToHtml({
            title: page.title,
            slug: page.slug,
            format: page.format,
            body: page.body,
            domain: site?.domain,
          });
          sendHtml(res, 200, compiled);
          return;
        }
        sendHtml(res, 404, '<!DOCTYPE html><html><body><h1>404 Staging Preview Not Found</h1></body></html>');
        return;
      }

      // PHP-WASI Env (@wp/env) routes
      if (method === 'GET' && pathname === '/api/wp-env') {
        const tenantId = urlObj.searchParams.get('tenantId') || undefined;
        sendJson(res, 200, { ok: true, envs: wpEnv.listEnvs(tenantId) });
        return;
      }

      if (method === 'POST' && pathname === '/api/wp-env') {
        const body = await readJsonBody(req);
        const env = wpEnv.createEnv({
          tenantId: String(body.tenantId || 'awesome-os'),
          siteId: String(body.siteId || 'awesome-os-com'),
          name: String(body.name || 'wp-wasi-env'),
          envConfig: (body.envConfig as Partial<WpEnvConfig>) || undefined,
          wasiMemoryMb: typeof body.wasiMemoryMb === 'number' ? body.wasiMemoryMb : undefined,
        });
        sendJson(res, 201, { ok: true, env });
        return;
      }

      const wpEnvActionMatch = pathname.match(/^\/api\/wp-env\/([^/]+)\/([a-z-]+)$/);
      if (wpEnvActionMatch) {
        const envId = decodeURIComponent(wpEnvActionMatch[1]!);
        const action = wpEnvActionMatch[2]!;

        if (method === 'GET' && action === 'wp-config') {
          const env = wpEnv.getEnv(envId);
          if (!env) {
            sendJson(res, 404, { ok: false, error: `WP-Env not found: ${envId}` });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            id: env.id,
            wpConfigPhp: generateWpConfigPhp(env),
            wpEnvJson: wpEnv.exportWpEnvJson(env.id),
          });
          return;
        }

        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (action === 'start') {
            sendJson(res, 200, { ok: true, env: wpEnv.startEnv(envId) });
            return;
          }
          if (action === 'stop') {
            sendJson(res, 200, { ok: true, env: wpEnv.stopEnv(envId) });
            return;
          }
          if (action === 'config') {
            let patch: Partial<WpEnvConfig>;
            if (typeof body.rawJson === 'string') {
              patch = parseWpEnvJson(
                body.rawJson,
                typeof body.overrideJson === 'string' ? body.overrideJson : undefined,
              );
            } else {
              patch = (body.envConfig as Partial<WpEnvConfig>) ?? (body as Partial<WpEnvConfig>);
            }
            sendJson(res, 200, { ok: true, env: wpEnv.updateEnvConfig(envId, patch) });
            return;
          }
          if (action === 'mount') {
            const kind = body.kind === 'theme' ? 'theme' : 'plugin';
            const source = String(body.source || '');
            if (!source) {
              sendJson(res, 400, { ok: false, error: 'source is required' });
              return;
            }
            sendJson(res, 200, { ok: true, env: wpEnv.mountArtifact(envId, kind, source) });
            return;
          }
          if (action === 'reset-db') {
            sendJson(res, 200, { ok: true, result: wpEnv.resetDatabase(envId) });
            return;
          }
        }
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(msg) ? 404 : 400;
      sendJson(res, status, { ok: false, error: msg });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        activePort = addr.port;
      }
      resolve();
    });
  });

  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  if (enableScheduler) {
    schedulerTimer = setInterval(() => {
      try {
        const due = store.collectDueScheduledPages();
        for (const page of due) {
          const site = store.getSite(page.siteId);
          if (site) {
            writeStagingPreview(site, page, stagingDir);
          }
          store.markPublished(page.id);
        }
      } catch {
        // Keep background scheduler resilient
      }
    }, 15_000);
    schedulerTimer.unref();
  }

  return {
    port: activePort,
    url: `http://${host}:${activePort}`,
    store,
    wpEnv,
    async close(): Promise<void> {
      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
