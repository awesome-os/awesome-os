/**
 * @file intersections/holo-compiler/scalar-bare-worktree.mts
 * @description Bare-Git Scalar v11 Monorepo lifecycle:
 *   1. Initialize bare Git repo with an empty root commit (0-byte working tree at rest)
 *   2. On build: attach ephemeral `--no-checkout` worktree -> `sparse-checkout set --cone <paths>`
 *   3. Execute build callback & ingest outputs into `v11/files/00..ff/<sha512>[-exec]`
 *   4. Always purge worktree (`git worktree remove --force` + `git worktree prune`) in `finally`
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export interface BareScalarInitResult {
  readonly bareRepoDir: string;
  readonly rootCommitSha: string;
  readonly defaultBranch: string;
}

export interface SparseWorktreeResult<T> {
  readonly ref: string;
  readonly sparsePaths: readonly string[];
  readonly worktreePurged: boolean;
  readonly result: T;
}

function resolveGitBinary(): { bin: string; prefixArgs: readonly string[] } {
  const pwsh = path.resolve(import.meta.dirname, '..', '..', 'bin', 'pwsh.exe');
  const gitPs1 = path.resolve(import.meta.dirname, '..', '..', 'bin', 'git.ps1');
  if (process.platform === 'win32' && fs.existsSync(pwsh) && fs.existsSync(gitPs1)) {
    return { bin: pwsh, prefixArgs: ['-NoProfile', '-File', gitPs1] };
  }
  return { bin: 'git', prefixArgs: [] };
}

function runGit(args: readonly string[], cwd?: string): string {
  const { bin, prefixArgs } = resolveGitBinary();
  return execFileSync(bin, [...prefixArgs, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Initializes a bare Git v11 monorepo containing a single empty root commit on `main`.
 * Working tree footprint at rest is 0 bytes.
 */
export function initBareScalarV11Repo(
  bareRepoDir: string,
  defaultBranch = 'main',
): BareScalarInitResult {
  fs.mkdirSync(bareRepoDir, { recursive: true });
  runGit(['init', '--bare', '--initial-branch', defaultBranch, bareRepoDir]);
  // Enable scalar-style partial/sparse index optimizations on the bare repo
  runGit(['-C', bareRepoDir, 'config', 'core.logAllRefUpdates', 'false']);
  runGit(['-C', bareRepoDir, 'config', 'gc.auto', '0']);

  // Create empty root tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) & empty root commit
  const emptyTreeSha = runGit(['-C', bareRepoDir, 'hash-object', '-t', 'tree', '/dev/null']).length === 40
    ? runGit(['-C', bareRepoDir, 'hash-object', '-t', 'tree', '/dev/null'])
    : runGit(['-C', bareRepoDir, 'mktree'], bareRepoDir);

  const rootCommitSha = execFileSync(
    resolveGitBinary().bin,
    [
      ...resolveGitBinary().prefixArgs,
      '-C',
      bareRepoDir,
      '-c',
      'user.name=Awesome-OS v11 CAS',
      '-c',
      'user.email=cas@awesome-os.com',
      'commit-tree',
      emptyTreeSha,
      '-m',
      'root: empty v11 bare scalar repository',
    ],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

  runGit(['-C', bareRepoDir, 'update-ref', `refs/heads/${defaultBranch}`, rootCommitSha]);
  return { bareRepoDir, rootCommitSha, defaultBranch };
}

/**
 * Checks out ONLY `sparsePaths` into an ephemeral Git worktree from `bareRepoDir` at `ref`,
 * executes `buildFn(worktreeDir)`, and unconditionally purges the worktree afterward.
 */
export async function withEphemeralSparseWorktree<T>(
  bareRepoDir: string,
  ref: string,
  sparsePaths: readonly string[],
  buildFn: (worktreeDir: string) => Promise<T> | T,
): Promise<SparseWorktreeResult<T>> {
  for (const sp of sparsePaths) {
    if (!sp || sp.includes('..') || path.isAbsolute(sp)) {
      throw new Error(`Invalid sparsePath: ${sp}`);
    }
  }

  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-v11-wt-'));
  const wtDir = path.join(wtRoot, 'checkout');
  let worktreePurged = false;

  try {
    runGit(['-C', bareRepoDir, 'worktree', 'add', '--detach', '--no-checkout', wtDir, ref]);
    if (sparsePaths.length > 0) {
      runGit(['-C', wtDir, 'sparse-checkout', 'init', '--cone']);
      runGit(['-C', wtDir, 'sparse-checkout', 'set', ...sparsePaths]);
    }
    runGit(['-C', wtDir, 'checkout', '--detach', ref]);
    const result = await buildFn(wtDir);
    return { ref, sparsePaths, worktreePurged: true, result };
  } finally {
    try {
      runGit(['-C', bareRepoDir, 'worktree', 'remove', '--force', wtDir]);
    } catch {
      // fallback cleanup below
    }
    try {
      runGit(['-C', bareRepoDir, 'worktree', 'prune']);
    } catch {
      // best effort
    }
    try {
      fs.rmSync(wtRoot, { recursive: true, force: true });
      worktreePurged = !fs.existsSync(wtRoot);
    } catch {
      worktreePurged = false;
    }
  }
}

export function listActiveWorktrees(bareRepoDir: string): string[] {
  const out = runGit(['-C', bareRepoDir, 'worktree', 'list', '--porcelain']);
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}
