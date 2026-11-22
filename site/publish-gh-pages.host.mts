#!/usr/bin/env node
/**
 * @file site/publish-gh-pages.host.mts
 * @description GitHub Pages-as-Repos Pipeline for Awesome-OS (`.\bin\b8g-gh-pages`).
 * Transforms any built static site directory (`site/awesome-os.com`, `site/b8g.app`,
 * `site/lemanschik.com`, or custom) into a self-contained, verified GitHub Pages
 * repository complete with `.nojekyll`, optional `CNAME`, `404.html`,
 * `.github/workflows/pages.yml`, `pages-manifest.json` (SHA-256), and `README.md`.
 *
 * Usage:
 *   b8g-gh-pages plan-all
 *   b8g-gh-pages stage   --site site/awesome-os.com --repo awesome-os/awesome-os.github.io [--cname awesome-os.com] [--out <dir>]
 *   b8g-gh-pages publish --site site/awesome-os.com --repo awesome-os/awesome-os.github.io [--cname awesome-os.com] [--create-repo]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(fileURLToPath(import.meta.url), '..');
const WORKSPACE_ROOT = path.resolve(__dirname, '..');

export interface GhPagesTargetSpec {
  readonly id: string;
  readonly siteDir: string;
  readonly repo: string;
  readonly cname?: string;
  readonly description: string;
}

export const DEFAULT_GH_PAGES_TARGETS: readonly GhPagesTargetSpec[] = [
  {
    id: 'awesome-os',
    siteDir: 'site/awesome-os.com',
    repo: 'awesome-os/awesome-os.github.io',
    cname: 'awesome-os.com',
    description: 'Awesome-OS & Sectium — Official static site (GitHub Pages repo)',
  },
  {
    id: 'b8g-app',
    siteDir: 'site/b8g.app',
    repo: 'awesome-os/b8g.app',
    cname: 'b8g.app',
    description: 'B8G App & Builder — Official static site (GitHub Pages repo)',
  },
  {
    id: 'lemanschik',
    siteDir: 'site/lemanschik.com',
    repo: 'lemanschik/lemanschik.github.io',
    cname: 'lemanschik.com',
    description: 'Frank Lemanschik — Sovereign engineering portal (GitHub Pages repo)',
  },
];

export interface StageGhPagesOptions {
  siteDir: string;
  repo: string;
  outDir: string;
  cname?: string;
  branch?: string;
  maxFileBytes?: number;
}

export interface StageGhPagesResult {
  readonly outDir: string;
  readonly repo: string;
  readonly cname?: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly skippedLargeFiles: string[];
  readonly manifestSha256: string;
}

const PAGES_WORKFLOW_YAML = `name: Deploy Static Site to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: "."
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;

function walkFiles(rootDir: string, relBase = ''): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(rootDir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

export function stageGhPagesRepo(opts: StageGhPagesOptions): StageGhPagesResult {
  const srcRoot = path.resolve(opts.siteDir);
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`Site source directory does not exist: ${srcRoot}`);
  }
  const outDir = path.resolve(opts.outDir);
  const maxBytes = opts.maxFileBytes ?? 95 * 1024 * 1024; // GitHub 100 MB hard file limit safety margin

  fs.mkdirSync(outDir, { recursive: true });

  // Clean previous non-.git content in staging dir
  for (const entry of fs.readdirSync(outDir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }

  const relFiles = walkFiles(srcRoot);
  const manifestEntries: Array<{ path: string; bytes: number; sha256: string }> = [];
  const skippedLargeFiles: string[] = [];
  let totalBytes = 0;

  for (const rel of relFiles) {
    const srcPath = path.join(srcRoot, rel);
    const st = fs.statSync(srcPath);
    if (st.size > maxBytes) {
      skippedLargeFiles.push(rel);
      continue;
    }
    const dstPath = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    const buf = fs.readFileSync(srcPath);
    fs.writeFileSync(dstPath, buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    manifestEntries.push({ path: rel, bytes: buf.length, sha256 });
    totalBytes += buf.length;
  }

  // 1. .nojekyll so GitHub Pages serves raw ESM/underscore assets untouched
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf8');

  // 2. Optional CNAME for custom domain
  if (opts.cname && opts.cname.trim()) {
    fs.writeFileSync(path.join(outDir, 'CNAME'), `${opts.cname.trim()}\n`, 'utf8');
  }

  // 3. Fallback 404.html if site didn't provide one
  const notFoundPath = path.join(outDir, '404.html');
  if (!fs.existsSync(notFoundPath)) {
    const fallback404 =
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>404 — Page Not Found</title></head>' +
      '<body style="background:#070b12;color:#e6eefb;font-family:system-ui,sans-serif;padding:48px;">' +
      '<h1>404 — Page Not Found</h1><p><a href="/" style="color:#38bdf8;">Return to home</a></p></body></html>\n';
    fs.writeFileSync(notFoundPath, fallback404, 'utf8');
  }

  // 4. GitHub Actions official Pages workflow
  const wfDir = path.join(outDir, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'pages.yml'), PAGES_WORKFLOW_YAML, 'utf8');

  // 5. Deterministic SHA-256 manifest
  const manifestObj = {
    schema: 'b8g.gh-pages-manifest.v1',
    repo: opts.repo,
    cname: opts.cname || null,
    fileCount: manifestEntries.length,
    totalBytes,
    skippedLargeFiles,
    files: manifestEntries,
  };
  const manifestJson = `${JSON.stringify(manifestObj, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, 'pages-manifest.json'), manifestJson, 'utf8');
  const manifestSha256 = crypto.createHash('sha256').update(manifestJson).digest('hex');

  // 6. Clean repo README.md if not already present in site output
  const readmePath = path.join(outDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const liveUrl = opts.cname
      ? `https://${opts.cname}/`
      : `https://${opts.repo.split('/')[0]}.github.io/${opts.repo.split('/')[1] || ''}`;
    const readme = [
      `# ${opts.repo}`,
      '',
      `Generated automatically by the **Awesome-OS GitHub Pages Repo Pipeline** (\`b8g-gh-pages\`).`,
      '',
      `- **Live URL:** ${liveUrl}`,
      `- **Files Published:** ${manifestEntries.length} (${(totalBytes / 1024).toFixed(1)} KiB)`,
      `- **Manifest SHA-256:** \`${manifestSha256}\``,
      '',
      `Source & architecture: https://github.com/awesome-os/awesome-os`,
      '',
    ].join('\n');
    fs.writeFileSync(readmePath, readme, 'utf8');
  }

  return {
    outDir,
    repo: opts.repo,
    cname: opts.cname,
    fileCount: manifestEntries.length,
    totalBytes,
    skippedLargeFiles,
    manifestSha256,
  };
}

function runBin(tool: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const isWin = process.platform === 'win32';
  const binPath = path.join(WORKSPACE_ROOT, 'bin', isWin ? `${tool}.ps1` : tool);
  const res = isWin
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', binPath, ...args], {
        cwd,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      })
    : spawnSync(binPath, args, {
        cwd,
        encoding: 'utf8',
        shell: false,
      });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

export function publishGhPagesRepo(opts: StageGhPagesOptions & { createRepo?: boolean }): StageGhPagesResult {
  const branch = opts.branch || 'main';
  const remoteUrl = `https://github.com/${opts.repo}.git`;
  const outDir = path.resolve(opts.outDir);

  const view = runBin('gh', ['repo', 'view', opts.repo], WORKSPACE_ROOT);
  const repoExists = view.status === 0;

  if (!repoExists && opts.createRepo) {
    const created = runBin(
      'gh',
      ['repo', 'create', opts.repo, '--public', '--description', `GitHub Pages site for ${opts.cname || opts.repo}`],
      WORKSPACE_ROOT,
    );
    if (created.status !== 0) {
      throw new Error(`Failed to create GitHub repo ${opts.repo}: ${created.stderr || created.stdout}`);
    }
  } else if (repoExists) {
    // Clone existing remote history first so we always commit cleanly on top (zero force-push, full history preserved).
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    const cloned = runBin('git', ['clone', '--depth', '1', remoteUrl, outDir], WORKSPACE_ROOT);
    if (cloned.status !== 0) {
      // Empty remote repo: fall back to fresh init below
      fs.mkdirSync(outDir, { recursive: true });
    }
  }

  const staged = stageGhPagesRepo(opts);

  if (!fs.existsSync(path.join(staged.outDir, '.git'))) {
    runBin('git', ['init', '-b', branch], staged.outDir);
    runBin('git', ['remote', 'add', 'origin', remoteUrl], staged.outDir);
  }
  runBin('git', ['add', '-A'], staged.outDir);
  const diff = runBin('git', ['status', '--porcelain'], staged.outDir);
  if (diff.stdout.trim()) {
    runBin('git', ['commit', '-m', `chore(pages): publish ${opts.repo} (${staged.manifestSha256.slice(0, 12)})`], staged.outDir);
    const push = runBin('git', ['push', '-u', 'origin', branch], staged.outDir);
    if (push.status !== 0) {
      throw new Error(`git push failed for ${opts.repo}: ${push.stderr || push.stdout}`);
    }
  }

  // Enable GitHub Pages via workflow build_type (idempotent; ignores 409 if already enabled)
  runBin(
    'gh',
    ['api', `repos/${opts.repo}/pages`, '-X', 'POST', '-f', 'build_type=workflow'],
    WORKSPACE_ROOT,
  );

  return staged;
}

function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = { _: argv[0] || 'plan-all' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseCliArgs(process.argv.slice(2));
  const cmd = String(args._);

  if (cmd === 'plan-all') {
    console.log('Awesome-OS GitHub Pages-as-Repos Pipeline Plan:');
    for (const t of DEFAULT_GH_PAGES_TARGETS) {
      const exists = fs.existsSync(path.join(WORKSPACE_ROOT, t.siteDir));
      console.log(`  - ${t.id.padEnd(12)} | ${t.siteDir.padEnd(22)} -> ${t.repo.padEnd(32)} | CNAME=${t.cname || '-'} | built=${exists}`);
    }
  } else if (cmd === 'stage' || cmd === 'publish') {
    const siteDir = String(args.site || 'site/awesome-os.com');
    const repo = String(args.repo || 'awesome-os/awesome-os.github.io');
    const cname = typeof args.cname === 'string' ? args.cname : undefined;
    const safeSlug = repo.replace(/[^a-zA-Z0-9._-]/g, '_');
    const outDir = String(args.out || path.join(WORKSPACE_ROOT, '.b8g-cas', 'gh-pages-staging', safeSlug));
    const opts = { siteDir, repo, outDir, cname, createRepo: Boolean(args['create-repo']) };
    const res = cmd === 'publish' ? publishGhPagesRepo(opts) : stageGhPagesRepo(opts);
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.error(`Unknown command: ${cmd}. Use plan-all | stage | publish.`);
    process.exit(1);
  }
}
