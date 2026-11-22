/**
 * @file server.test.mts
 * @description Integration tests for B8G Multi-Site Sovereign CMS HTTP server,
 * editorial review/staging/scheduling/publishing pipeline, and PHP-WASI `@wp/env` API.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startSiteCmsServer } from './server.mts';

test('b8g-site-cms HTTP server full workflow + staging preview + PHP-WASI @wp/env', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-site-cms-srv-'));
  const dataDir = path.join(tmpDir, 'data');
  const stagingDir = path.join(tmpDir, 'staging');

  const srv = await startSiteCmsServer({
    port: 0,
    dataDir,
    stagingDir,
    enableScheduler: false,
  });

  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.service, 'b8g-site-cms');
    assert.ok(Number(health.sites) >= 3);

    // 2. Root HTML UI with <b8g-section data-kind="cms-studio">
    const uiRes = await fetch(`${srv.url}/`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.match(uiHtml, /<b8g-section[^>]*data-kind="cms-studio"/);
    assert.match(uiHtml, /PHP-WASI Env/);

    // 3. List seeded sites & create a page
    const sitesRes = await fetch(`${srv.url}/api/sites`);
    const sitesData = (await sitesRes.json()) as { sites: Array<{ id: string; tenantId: string }> };
    assert.ok(sitesData.sites.length >= 3);
    const targetSite = sitesData.sites[0]!;

    const createRes = await fetch(`${srv.url}/api/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        siteId: targetSite.id,
        tenantId: targetSite.tenantId,
        slug: 'launch-notes',
        title: 'Launch Notes',
        format: 'markdown',
        body: '# Launch Notes\n\nSovereign publishing pipeline.',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { page: { id: string; status: string } };
    assert.equal(created.page.status, 'draft');
    const pageId = created.page.id;

    // 4. Submit for review -> Approve
    const submitRes = await fetch(`${srv.url}/api/pages/${encodeURIComponent(pageId)}/submit-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(submitRes.status, 200);
    const submitted = (await submitRes.json()) as { page: { status: string } };
    assert.equal(submitted.page.status, 'in-review');

    const reviewRes = await fetch(`${srv.url}/api/pages/${encodeURIComponent(pageId)}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: 'frank', verdict: 'approved', note: 'LGTM' }),
    });
    assert.equal(reviewRes.status, 200);
    const reviewed = (await reviewRes.json()) as { page: { status: string; reviews: unknown[] } };
    assert.equal(reviewed.page.status, 'approved');
    assert.equal(reviewed.page.reviews.length, 1);

    // 5. Stage & verify live HTML preview at GET /staging/:siteId/:slug
    const stageRes = await fetch(`${srv.url}/api/pages/${encodeURIComponent(pageId)}/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(stageRes.status, 200);
    const staged = (await stageRes.json()) as { page: { status: string }; previewUrl: string };
    assert.equal(staged.page.status, 'staging');
    assert.ok(staged.previewUrl.startsWith('/staging/'));

    const previewRes = await fetch(`${srv.url}${staged.previewUrl}`);
    assert.equal(previewRes.status, 200);
    const previewHtml = await previewRes.text();
    assert.match(previewHtml, /Launch Notes/);
    assert.match(previewHtml, /<b8g-section[^>]*data-kind="cms-page"/);

    // 6. Schedule -> Publish (dry-run GH Pages stage)
    const schedRes = await fetch(`${srv.url}/api/pages/${encodeURIComponent(pageId)}/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    assert.equal(schedRes.status, 200);
    const scheduled = (await schedRes.json()) as { page: { status: string } };
    assert.equal(scheduled.page.status, 'scheduled');

    const pubRes = await fetch(`${srv.url}/api/pages/${encodeURIComponent(pageId)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToGitHub: false }),
    });
    assert.equal(pubRes.status, 200);
    const published = (await pubRes.json()) as {
      page: { status: string; publishedAt?: string };
      ghPages: { outDir: string; fileCount: number };
    };
    assert.equal(published.page.status, 'published');
    assert.ok(published.page.publishedAt);
    assert.ok(published.ghPages.fileCount >= 1);
    assert.equal(fs.existsSync(path.join(published.ghPages.outDir, 'pages-manifest.json')), true);

    // 7. PHP-WASI Env (@wp/env) API check
    const envListRes = await fetch(`${srv.url}/api/wp-env`);
    assert.equal(envListRes.status, 200);
    const envList = (await envListRes.json()) as { envs: Array<{ id: string }> };
    assert.ok(envList.envs.length >= 1);
    const envId = envList.envs[0]!.id;

    const startEnvRes = await fetch(`${srv.url}/api/wp-env/${encodeURIComponent(envId)}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(startEnvRes.status, 200);
    const startedEnv = (await startEnvRes.json()) as { env: { status: string } };
    assert.equal(startedEnv.env.status, 'running');

    const cfgRes = await fetch(`${srv.url}/api/wp-env/${encodeURIComponent(envId)}/wp-config`);
    assert.equal(cfgRes.status, 200);
    const cfg = (await cfgRes.json()) as { wpConfigPhp: string; wpEnvJson: string };
    assert.match(cfg.wpConfigPhp, /WP_DEBUG/);
    assert.match(cfg.wpEnvJson, /phpVersion/);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
