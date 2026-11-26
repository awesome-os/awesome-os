import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveRepositoryRemoteTarget } from './git-remote-repository.mts';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BIN_DIR = path.join(WORKSPACE_ROOT, 'bin');

describe('git-remote-repository (native repository:// Git remote helper)', () => {
  it('resolves repository://local and mirrored repository://github.com URLs cleanly', () => {
    const localTarget = resolveRepositoryRemoteTarget('repository://local/awesome-os/models');
    assert.equal(localTarget.mode, 'local-path');
    assert.equal(localTarget.org, 'awesome-os');
    assert.equal(localTarget.repo, 'models');
    assert.ok(localTarget.target.endsWith(path.join('awesome-os', 'models')));

    const githubMirrored = resolveRepositoryRemoteTarget('repository://github.com/awesome-os/models@main');
    assert.equal(githubMirrored.mode, 'local-path');

    const unmirrored = resolveRepositoryRemoteTarget('repository://github.com/example-org/unmirrored-repo@v1.0.0');
    assert.equal(unmirrored.mode, 'https-fallback');
    assert.equal(unmirrored.target, 'https://github.com/example-org/unmirrored-repo.git');
  });

  it('rejects B8G016 loopback hosts and path traversal', () => {
    assert.throws(() => resolveRepositoryRemoteTarget('repository://127.0.0.1/awesome-os/models@main'));
    assert.throws(() => resolveRepositoryRemoteTarget('repository://local/awesome-os/models@main#../secret'));
  });

  it('executes stock `git ls-remote repository://local/awesome-os/models` live via bin/git-remote-repository', () => {
    const out = execFileSync('git', ['ls-remote', 'repository://local/awesome-os/models'], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
      windowsHide: true,
    }).trim();

    assert.match(out, /[0-9a-f]{40}\s+HEAD/);
    assert.match(out, /[0-9a-f]{40}\s+refs\/heads\/main/);
  });
});
