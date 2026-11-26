#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SiteMapping {
  readonly source: string;
  readonly target: string;
}

interface SiteSpec {
  readonly domain: string;
  readonly audience: string;
  readonly description: string;
  readonly remoteRoot: string;
  readonly mappings: readonly SiteMapping[];
  readonly healthChecks: readonly string[];
}

interface DeploymentManifest {
  readonly schema: 'awesome-os.deployment-manifest.v1';
  readonly sshHost: string;
  readonly sites: readonly SiteSpec[];
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'deployment-manifest.json'), 'utf8')) as DeploymentManifest;

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
}

async function verifyAll(): Promise<void> {
  let ok = 0;
  let fail = 0;
  for (const site of manifest.sites) {
    for (const url of site.healthChecks) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        const status = res.status;
        if (status >= 200 && status < 400) {
          console.log(`[PASS] ${status} ${url}`);
          ok++;
        } else {
          console.error(`[FAIL] ${status} ${url}`);
          fail++;
        }
      } catch (err) {
        console.error(`[FAIL] ${url} -> ${err instanceof Error ? err.message : String(err)}`);
        fail++;
      }
    }
  }
  console.log(`\n[DEPLOYMENT] Health check complete: ${ok} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

function applyAll(dryRun: boolean): void {
  for (const site of manifest.sites) {
    console.log(`\n=== ${site.domain} (${site.audience}) ===`);
    for (const m of site.mappings) {
      const src = resolve(ROOT, m.source);
      if (!existsSync(src)) {
        throw new Error(`Missing source file: ${src}`);
      }
      const hash = sha256File(src);
      const remote = `${manifest.sshHost}:${site.remoteRoot}/${m.target}`;
      console.log(`  ${dryRun ? '[DRY-RUN]' : '[DEPLOY] '} ${m.source} (sha256:${hash}) -> ${remote}`);
      if (!dryRun) {
        execFileSync('scp', [src, remote], { stdio: 'inherit' });
      }
    }
  }
}

const arg = process.argv[2] ?? '--verify';
if (arg === '--verify') {
  await verifyAll();
} else if (arg === '--dry-run') {
  applyAll(true);
} else if (arg === '--apply') {
  applyAll(false);
  await verifyAll();
} else {
  console.log('Usage: node deploy.mts [--verify | --dry-run | --apply]');
}
