/**
 * @file site/publish-gh-pages.test.mts
 * @description Tests for the GitHub Pages-as-Repos pipeline (`stageGhPagesRepo`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageGhPagesRepo } from './publish-gh-pages.host.mts';

test('stageGhPagesRepo produces complete GitHub Pages repo with .nojekyll, CNAME, 404.html, workflow & SHA-256 manifest', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-gh-pages-test-'));
  try {
    const siteDir = path.join(tmpRoot, 'site-src');
    const outDir = path.join(tmpRoot, 'repo-out');
    fs.mkdirSync(path.join(siteDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<!DOCTYPE html><html><body><h1>Sectium</h1></body></html>', 'utf8');
    fs.writeFileSync(path.join(siteDir, 'assets', 'app.js'), 'console.log("ok");', 'utf8');

    const res = stageGhPagesRepo({
      siteDir,
      repo: 'awesome-os/awesome-os.github.io',
      outDir,
      cname: 'awesome-os.com',
    });

    assert.equal(res.fileCount, 2);
    assert.equal(res.skippedLargeFiles.length, 0);
    assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')), 'Must emit .nojekyll');
    assert.equal(fs.readFileSync(path.join(outDir, 'CNAME'), 'utf8').trim(), 'awesome-os.com');
    assert.ok(fs.existsSync(path.join(outDir, '404.html')), 'Must emit fallback 404.html');
    assert.ok(fs.existsSync(path.join(outDir, '.github', 'workflows', 'pages.yml')), 'Must emit GitHub Pages workflow');
    assert.ok(fs.existsSync(path.join(outDir, 'pages-manifest.json')), 'Must emit SHA-256 manifest');
    assert.ok(fs.existsSync(path.join(outDir, 'README.md')), 'Must emit repo README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
