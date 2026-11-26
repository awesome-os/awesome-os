#!/usr/bin/env node
/**
 * @file intersections/holo-compiler/git-remote-repository.mts
 * @description Git remote-helper for the canonical `repository://` URI scheme.
 *
 * When `e:\awesome-os\bin` is on `PATH`, stock `git` automatically invokes
 * `git-remote-repository` for any remote URL starting with `repository://`:
 *
 *   git clone repository://local/awesome-os/models
 *   git ls-remote repository://local/awesome-os/models
 *   git remote add v11 repository://github.com/awesome-os/go-lang@main
 *
 * Implements Git's native `connect` remote-helper protocol for 100% 1:1 legacy
 * Git wire compatibility while bridging local/mirror repos directly into the
 * unified `v11/files/00..ff/<sha512>` CAS (`B8G_ABI_MAGIC_V3 = 0x33564742`).
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CasV11Store, resolveUnifiedCasRoot } from './cas-v11-store.mts';
import { parseGitForgeUri, resolveGitForgeToCasV11 } from './git-forge.mts';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export interface ResolvedRemoteTarget {
  readonly scheme: 'repository://';
  readonly host: string;
  readonly org: string;
  readonly repo: string;
  readonly ref: string;
  readonly mode: 'local-path' | 'https-fallback';
  readonly target: string;
}

/**
 * Resolves a `repository://<host>/<org>/<repo>[@ref]` (or `repository://local/<abs-or-rel>`)
 * URL to either a local bare/mirror repository path or an HTTPS upstream URL.
 */
export function resolveRepositoryRemoteTarget(
  rawUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedRemoteTarget {
  const normalizedInput = rawUrl.includes('@') ? rawUrl : `${rawUrl}@main`;
  const parsed = parseGitForgeUri(normalizedInput);

  const mirrorRoot =
    env.AWESOME_OS_MIRROR_ROOT?.trim() ||
    path.resolve(import.meta.dirname, '..', '..', 'github-mirror');

  if (parsed.host === 'local') {
    const candidate = path.join(mirrorRoot, parsed.org, parsed.repo);
    return {
      scheme: 'repository://',
      host: parsed.host,
      org: parsed.org,
      repo: parsed.repo,
      ref: parsed.ref,
      mode: 'local-path',
      target: candidate,
    };
  }

  // Prefer canonical local mirror when present for zero-network LAN/local hydration
  const localMirror = path.join(mirrorRoot, parsed.org, parsed.repo);
  if (fs.existsSync(path.join(localMirror, '.git')) || fs.existsSync(path.join(localMirror, 'HEAD'))) {
    return {
      scheme: 'repository://',
      host: parsed.host,
      org: parsed.org,
      repo: parsed.repo,
      ref: parsed.ref,
      mode: 'local-path',
      target: localMirror,
    };
  }

  return {
    scheme: 'repository://',
    host: parsed.host,
    org: parsed.org,
    repo: parsed.repo,
    ref: parsed.ref,
    mode: 'https-fallback',
    target: `https://${parsed.host}/${parsed.org}/${parsed.repo}.git`,
  };
}

function mirrorRepoTreeToCasV11(target: ResolvedRemoteTarget): void {
  if (target.mode !== 'local-path' || !fs.existsSync(target.target)) return;
  // Only snapshot working-tree repos directly; bare repos are indexed via gitaly/casv11
  if (!fs.existsSync(path.join(target.target, '.git'))) return;
  try {
    const cas = new CasV11Store(resolveUnifiedCasRoot());
    resolveGitForgeToCasV11(
      `repository://${target.host}/${target.org}/${target.repo}@${target.ref}`,
      target.target,
      cas,
    );
    cas.close();
  } catch {
    // non-fatal background CAS indexing
  }
}

async function runHelperCli(remoteUrl: string): Promise<void> {
  const resolved = resolveRepositoryRemoteTarget(remoteUrl);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === '') {
      break;
    }
    if (line === 'capabilities') {
      process.stdout.write('connect\noption\n\n');
      continue;
    }
    if (line.startsWith('option ')) {
      process.stdout.write('unsupported\n');
      continue;
    }
    if (line.startsWith('connect ')) {
      const service = line.slice('connect '.length).trim();
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        process.stderr.write(`git-remote-repository: unsupported service ${service}\n`);
        process.exit(1);
      }
      if (resolved.mode !== 'local-path') {
        process.stderr.write(
          `git-remote-repository: remote host ${resolved.host} not cached locally; fallback URL: ${resolved.target}\n`,
        );
        process.exit(1);
      }
      // Close readline before handing raw stdin/stdout directly to git upload-pack / receive-pack
      rl.close();
      process.stdout.write('\n');
      const subcmd = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
      const res = spawnSync('git', [subcmd, resolved.target], {
        stdio: 'inherit',
        windowsHide: true,
      });
      if (service === 'git-receive-pack' && res.status === 0) {
        mirrorRepoTreeToCasV11(resolved);
      }
      process.exit(res.status ?? 0);
    }
    process.stderr.write(`git-remote-repository: unsupported command ${line}\n`);
    process.exit(1);
  }
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const remoteUrl = process.argv[3] || process.argv[2];
  if (!remoteUrl) {
    process.stderr.write('usage: git-remote-repository <remote> <repository://url>\n');
    process.exit(2);
  }
  await runHelperCli(remoteUrl);
}
