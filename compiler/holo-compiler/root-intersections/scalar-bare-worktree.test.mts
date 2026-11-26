import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CasV11Store } from './cas-v11-store.mts';
import {
  initBareScalarV11Repo,
  listActiveWorktrees,
  withEphemeralSparseWorktree,
} from './scalar-bare-worktree.mts';

const PWSH = path.resolve(import.meta.dirname, '..', '..', 'bin', 'pwsh.exe');
const GIT_PS1 = path.resolve(import.meta.dirname, '..', '..', 'bin', 'git.ps1');

function git(args: string[], cwd?: string): string {
  return execFileSync(PWSH, ['-NoProfile', '-File', GIT_PS1, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('Bare Git Scalar v11 Monorepo + Ephemeral Sparse Worktree', () => {
  it('initializes bare repo with empty root commit, checks out ONLY requested sparse package, ingests to v11 CAS, and purges worktree', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-scalar-test-'));
    const bareDir = path.join(tmp, 'v11-mono.git');
    const seedDir = path.join(tmp, 'seed');
    const casRoot = path.join(tmp, 'cas-v11');

    try {
      // 1. Bare repo starts with empty root commit (0 files)
      const init = initBareScalarV11Repo(bareDir);
      assert.equal(init.rootCommitSha.length, 40);
      assert.equal(git(['-C', bareDir, 'ls-tree', '-r', init.rootCommitSha]), '');

      // 2. Push two disjoint packages (`pkg-alpha` and `pkg-beta`) on top of empty root
      git(['clone', bareDir, seedDir]);
      fs.mkdirSync(path.join(seedDir, 'pkg-alpha'), { recursive: true });
      fs.mkdirSync(path.join(seedDir, 'pkg-beta'), { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'pkg-alpha', 'lib.c'), 'int alpha(void){return 42;}\n');
      fs.writeFileSync(path.join(seedDir, 'pkg-beta', 'huge.bin'), 'BETA-SHOULD-NOT-CHECKOUT\n');
      git(['-C', seedDir, 'add', '.']);
      git(['-C', seedDir, '-c', 'user.name=Test', '-c', 'user.email=t@test', 'commit', '-m', 'add pkg-alpha & pkg-beta']);
      git(['-C', seedDir, 'push', 'origin', 'main']);

      // 3. Ephemeral sparse worktree checkout of ONLY `pkg-alpha`
      const cas = new CasV11Store(casRoot);
      let observedWorktreeDir = '';
      const run = await withEphemeralSparseWorktree(bareDir, 'main', ['pkg-alpha'], (wtDir) => {
        observedWorktreeDir = wtDir;
        assert.equal(fs.existsSync(path.join(wtDir, 'pkg-alpha', 'lib.c')), true);
        assert.equal(fs.existsSync(path.join(wtDir, 'pkg-beta', 'huge.bin')), false);
        const src = fs.readFileSync(path.join(wtDir, 'pkg-alpha', 'lib.c'));
        return cas.putBlob(src, { kind: 'object' });
      });

      // 4. Verify v11 CAS blob stored & ephemeral worktree completely purged
      assert.equal(run.worktreePurged, true);
      assert.equal(fs.existsSync(observedWorktreeDir), false);
      assert.equal(listActiveWorktrees(bareDir).length, 1); // only the bare repo itself remains
      assert.equal(run.result.sha512.length, 128);
      assert.equal(fs.existsSync(run.result.path), true);
      cas.close();
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
