/**
 * @file cms-core.test.mts
 * @description Unit tests for CmsStore and wp-block-compiler.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CmsStore } from './cms-store.mts';
import {
  compilePageToHtml,
  parseGutenbergCommentBlocks,
  writeStagingPreview,
} from './wp-block-compiler.mts';

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe('CmsStore', () => {
  it('seeds 3 default sites with 1 welcome post each and survives disk reload', () => {
    const dir = makeTempDir('b8g-cms-seed-');
    try {
      const store1 = new CmsStore(dir);
      const sites = store1.listSites();
      assert.equal(sites.length, 3);

      const domains = sites.map((s) => s.domain).sort();
      assert.deepEqual(domains, ['awesome-os.com', 'b8g.app', 'lemanschik.com']);

      const repos = new Map(sites.map((s) => [s.domain, s.githubRepo]));
      assert.equal(repos.get('awesome-os.com'), 'awesome-os/awesome-os.github.io');
      assert.equal(repos.get('b8g.app'), 'awesome-os/b8g.app');
      assert.equal(repos.get('lemanschik.com'), 'lemanschik/lemanschik.github.io');

      const pages = store1.listPages();
      assert.equal(pages.length, 3);
      for (const site of sites) {
        const sitePages = store1.listPages({ siteId: site.id });
        assert.equal(sitePages.length, 1);
        assert.equal(sitePages[0].slug, 'welcome');
        assert.equal(sitePages[0].status, 'published');
      }

      // Mutate and verify reload survival from cms-state.json
      const customSite = store1.createSite({
        tenantId: 'acme',
        name: 'Acme Sovereign',
        domain: 'acme.example',
        githubRepo: 'acme/acme.github.io',
      });
      const customPage = store1.createPage({
        siteId: customSite.id,
        tenantId: 'acme',
        slug: 'launch-notes',
        title: 'Launch Notes',
        body: '# Launch\n\nReady.',
      });

      const store2 = new CmsStore(dir);
      assert.equal(store2.listSites().length, 4);
      assert.equal(store2.getSite(customSite.id)?.domain, 'acme.example');
      assert.equal(store2.getPage(customPage.id)?.title, 'Launch Notes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces multi-tenant isolation across sites and pages', () => {
    const dir = makeTempDir('b8g-cms-tenant-');
    try {
      const store = new CmsStore(dir);
      const awesomeSites = store.listSites('awesome-os');
      const lemanschikSites = store.listSites('lemanschik');
      assert.equal(awesomeSites.length, 2);
      assert.equal(lemanschikSites.length, 1);
      assert.equal(lemanschikSites[0].domain, 'lemanschik.com');

      const awesomePages = store.listPages({ tenantId: 'awesome-os' });
      const lemanschikPages = store.listPages({ tenantId: 'lemanschik' });
      assert.equal(awesomePages.length, 2);
      assert.equal(lemanschikPages.length, 1);
      assert.ok(awesomePages.every((p) => p.tenantId === 'awesome-os'));
      assert.ok(lemanschikPages.every((p) => p.tenantId === 'lemanschik'));

      // Cross-tenant page creation must throw
      assert.throws(() => {
        store.createPage({
          siteId: lemanschikSites[0].id,
          tenantId: 'awesome-os',
          slug: 'intrusion',
          title: 'Should Fail',
          body: 'nope',
        });
      }, /Tenant mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs full editorial workflow draft -> in-review -> approved -> staging -> scheduled -> due -> published', () => {
    const dir = makeTempDir('b8g-cms-workflow-');
    try {
      const store = new CmsStore(dir);
      const site = store.listSites('awesome-os')[0];

      const draft = store.createPage({
        siteId: site.id,
        tenantId: site.tenantId,
        slug: '/roadmap/2026/',
        title: '2026 Sovereign Roadmap',
        format: 'markdown',
        body: '# Roadmap\n\nInitial draft.',
      });
      assert.equal(draft.status, 'draft');
      assert.equal(draft.slug, 'roadmap/2026');

      // Cannot stage or schedule before approval
      assert.throws(() => store.stagePage(draft.id), /must be 'approved' or 'staging'/);
      assert.throws(
        () => store.schedulePage(draft.id, '2026-12-01T10:00:00.000Z'),
        /must be 'approved' or 'staging'/,
      );

      const inReview = store.submitForReview(draft.id);
      assert.equal(inReview.status, 'in-review');

      const changesRequested = store.addReview(draft.id, {
        reviewer: 'alice',
        verdict: 'changes-requested',
        note: 'Add architecture section',
      });
      assert.equal(changesRequested.status, 'draft');
      assert.equal(changesRequested.reviews.length, 1);

      store.updatePage(draft.id, { body: '# Roadmap\n\n## Architecture\n\nAdded.' });
      store.submitForReview(draft.id);

      const approved = store.addReview(draft.id, {
        reviewer: 'bob',
        verdict: 'approved',
        note: 'LGTM',
      });
      assert.equal(approved.status, 'approved');
      assert.equal(approved.reviews.length, 2);

      const staged = store.stagePage(draft.id);
      assert.equal(staged.status, 'staging');

      const scheduled = store.schedulePage(draft.id, '2026-12-01T12:00:00Z');
      assert.equal(scheduled.status, 'scheduled');
      assert.equal(scheduled.scheduledAt, '2026-12-01T12:00:00.000Z');

      // Before due time -> not due
      assert.equal(store.collectDueScheduledPages('2026-12-01T11:59:59Z').length, 0);
      // At due time -> due
      const due = store.collectDueScheduledPages('2026-12-01T12:00:00Z');
      assert.equal(due.length, 1);
      assert.equal(due[0].id, draft.id);

      const published = store.markPublished(draft.id);
      assert.equal(published.status, 'published');
      assert.ok(typeof published.publishedAt === 'string' && published.publishedAt.length > 0);
      assert.equal(store.collectDueScheduledPages('2026-12-02T00:00:00Z').length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wp-block-compiler', () => {
  it('parses Gutenberg comment blocks and JSON WpBlock arrays', () => {
    const rawComments = [
      '<!-- wp:heading {"level":2} -->',
      '<h2>Sovereign Runtime</h2>',
      '<!-- /wp:heading -->',
      '<!-- wp:paragraph -->',
      '<p>Zero bloat, direct execution.</p>',
      '<!-- /wp:paragraph -->',
      '<!-- wp:code -->',
      'const x = 42;',
      '<!-- /wp:code -->',
      '<!-- wp:quote -->',
      '<p>Build once, run everywhere.</p>',
      '<!-- /wp:quote -->',
      '<!-- wp:list {"ordered":true} -->',
      '<li>First</li><li>Second</li>',
      '<!-- /wp:list -->',
    ].join('\n');

    const blocks = parseGutenbergCommentBlocks(rawComments);
    assert.equal(blocks.length, 5);
    assert.equal(blocks[0].name, 'heading');
    assert.equal(blocks[0].attributes?.level, 2);
    assert.equal(blocks[1].name, 'paragraph');
    assert.equal(blocks[2].name, 'code');
    assert.equal(blocks[3].name, 'quote');
    assert.equal(blocks[4].name, 'list');
    assert.equal(blocks[4].attributes?.ordered, true);

    const fromJson = parseGutenbergCommentBlocks(
      JSON.stringify([{ name: 'core/paragraph', innerHTML: 'Hello JSON' }]),
    );
    assert.equal(fromJson.length, 1);
    assert.equal(fromJson[0].name, 'core/paragraph');
    assert.equal(fromJson[0].innerHTML, 'Hello JSON');
  });

  it('compiles Gutenberg, Markdown, and B8G-HTML into dark-glass HTML5 with b8g-section', () => {
    const mdHtml = compilePageToHtml({
      title: 'Markdown Post',
      slug: 'md-post',
      format: 'markdown',
      domain: 'awesome-os.com',
      body: '# Hello\n\nA **bold** line with `code`.\n\n- Item A\n- Item B\n\n> Quoted',
    });
    assert.match(mdHtml, /^<!DOCTYPE html>/);
    assert.ok(
      mdHtml.includes(
        '<b8g-section data-kind="cms-page" data-surface="html-dom" data-liveness="static">',
      ),
    );
    assert.ok(mdHtml.includes('<h1>Hello</h1>'));
    assert.ok(mdHtml.includes('<strong>bold</strong>'));
    assert.ok(mdHtml.includes('<code>code</code>'));
    assert.ok(mdHtml.includes('<li>Item A</li>'));
    assert.ok(mdHtml.includes('<blockquote><p>Quoted</p></blockquote>'));

    const wpHtml = compilePageToHtml({
      title: 'Gutenberg Post',
      slug: 'wp-post',
      format: 'gutenberg-blocks',
      domain: 'b8g.app',
      body: '<!-- wp:heading {"level":3} -->Heading 3<!-- /wp:heading --><!-- wp:paragraph -->Body text<!-- /wp:paragraph -->',
    });
    assert.ok(
      wpHtml.includes(
        '<b8g-section data-kind="cms-page" data-surface="html-dom" data-liveness="static">',
      ),
    );
    assert.ok(wpHtml.includes('<h3>Heading 3</h3>'));
    assert.ok(wpHtml.includes('<p>Body text</p>'));

    const b8gHtml = compilePageToHtml({
      title: 'Raw B8G',
      slug: 'raw-b8g',
      format: 'b8g-html',
      body: '<div class="custom-widget">Live</div>',
    });
    assert.ok(b8gHtml.includes('<div class="custom-widget">Live</div>'));
  });

  it('writes staging preview file to disk and returns filePath + relPath', () => {
    const dir = makeTempDir('b8g-cms-stage-');
    try {
      const result = writeStagingPreview(
        { id: 'site_b8g_app', domain: 'b8g.app' },
        {
          slug: 'releases/v1',
          title: 'Release v1',
          format: 'markdown',
          body: '# Release v1\n\nStaged preview.',
        },
        dir,
      );
      assert.equal(result.relPath, 'b8g.app/releases/v1.html');
      const written = readFileSync(result.filePath, 'utf8');
      assert.ok(written.includes('<title>Release v1 — b8g.app</title>'));
      assert.ok(
        written.includes(
          '<b8g-section data-kind="cms-page" data-surface="html-dom" data-liveness="static">',
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
