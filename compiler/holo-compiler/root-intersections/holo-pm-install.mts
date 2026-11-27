/**
 * @file intersections/holo-compiler/holo-pm-install.mts
 * @description Local-by-default `./bin/` hardlink installer & collision-guarded `-g` global
 * ownership table for `holo-pm install` / `holo-pm add`.
 *
 * Contract:
 *   - Default (`global: false`): hardlinks `v11/files/<xx>/<sha512>-exec` directly into
 *     `<cwd>/bin/<binName>` (zero global namespace collisions, 0 B duplicated disk) and
 *     records the pinned entry in `<cwd>/holo-compiler-lockfile.json`.
 *   - Global (`global: true`): hardlinks into `<globalBinDir>/<alias || binName>` and
 *     enforces strict ownership in `<casRoot>/v11/bin-owners.json` — refuses silent overwrite
 *     unless `forceDefault: true` (`holo-pm use`) or `--as <alias>` is specified.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CasV11Store, resolveUnifiedCasRoot } from './cas-v11-store.mts';
import { parseGitForgeUri } from './git-forge.mts';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export interface HoloPmInstallOptions {
  readonly uri: string;
  readonly binName: string;
  readonly sha512: string;
  readonly casRoot?: string;
  readonly cwd?: string;
  readonly global?: boolean;
  readonly globalBinDir?: string;
  readonly alias?: string;
  readonly forceDefault?: boolean;
}

export interface HoloPmInstallReceipt {
  readonly scope: 'local' | 'global';
  readonly uri: string;
  readonly binPath: string;
  readonly lockfilePath: string | null;
  readonly sha512: string;
  readonly hardlinked: boolean;
  readonly abiMagic: string;
}

interface BinOwnersDoc {
  readonly schema: 'awesome-os-bin-owners-v1';
  readonly owners: Record<string, { readonly uri: string; readonly sha512: string; readonly updatedAt: string }>;
}

function defaultGlobalBinDir(): string {
  return path.join(os.homedir(), '.b8g', 'bin');
}

function loadOwners(ownersPath: string): BinOwnersDoc {
  if (!fs.existsSync(ownersPath)) {
    return { schema: 'awesome-os-bin-owners-v1', owners: {} };
  }
  return JSON.parse(fs.readFileSync(ownersPath, 'utf8')) as BinOwnersDoc;
}

function upsertProjectLockfile(
  cwd: string,
  entry: { readonly id: string; readonly uri: string; readonly binName: string; readonly sha512: string },
): string {
  const lockPath = path.join(cwd, 'holo-compiler-lockfile.json');
  let doc: {
    schema: string;
    abiMagic: string;
    casLayout: string;
    dependencies: Array<{ id: string; uri: string; binName: string; sha512: string }>;
  } = {
    schema: 'holo-compiler-lockfile-v1',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    dependencies: [],
  };

  if (fs.existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as typeof doc;
      if (Array.isArray(parsed.dependencies)) doc = parsed;
    } catch {
      // start fresh if corrupt
    }
  }

  const idx = doc.dependencies.findIndex((d) => d.binName === entry.binName || d.id === entry.id);
  if (idx >= 0) doc.dependencies[idx] = entry;
  else doc.dependencies.push(entry);

  fs.writeFileSync(lockPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return lockPath;
}

export function installHoloPmBin(opts: HoloPmInstallOptions): HoloPmInstallReceipt {
  const parsed = parseGitForgeUri(opts.uri);
  const effectiveName = (opts.alias || opts.binName).trim();
  if (!effectiveName || effectiveName.includes('/') || effectiveName.includes('\\') || effectiveName.includes('..')) {
    throw new Error(`holo-pm: invalid binary name "${effectiveName}"`);
  }

  const casRoot = opts.casRoot || resolveUnifiedCasRoot();
  const store = new CasV11Store(casRoot);
  try {
    const isExec = store.hasBlob(opts.sha512, true);
    if (!isExec && !store.hasBlob(opts.sha512, false)) {
      throw new Error(`holo-pm: blob ${opts.sha512.slice(0, 16)}... not found in v11 CAS`);
    }

    if (opts.global) {
      const ownersPath = path.join(store.storeRoot, 'bin-owners.json');
      const ownersDoc = loadOwners(ownersPath);
      const existing = ownersDoc.owners[effectiveName];
      if (existing && existing.uri !== opts.uri && !opts.forceDefault) {
        throw new Error(
          `holo-pm collision: global bin "${effectiveName}" is already owned by "${existing.uri}". ` +
            `Use --as <alias>, --force-default (holo-pm use), or local ./bin/ install.`,
        );
      }

      const gBinDir = opts.globalBinDir || defaultGlobalBinDir();
      fs.mkdirSync(gBinDir, { recursive: true });
      const destPath = path.join(gBinDir, effectiveName);
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
      const linkRes = store.linkBlobTo(opts.sha512, destPath, isExec) as unknown as {
        linked?: boolean;
        strategy?: string;
        method?: string;
      };

      ownersDoc.owners[effectiveName] = {
        uri: opts.uri,
        sha512: opts.sha512,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(ownersPath, JSON.stringify(ownersDoc, null, 2) + '\n', 'utf8');

      return {
        scope: 'global',
        uri: opts.uri,
        binPath: destPath,
        lockfilePath: null,
        sha512: opts.sha512,
        hardlinked: linkRes.linked === true || linkRes.strategy === 'hardlink' || linkRes.method === 'hardlink',
        abiMagic: B8G_ABI_MAGIC_V3,
      };
    }

    // Default: local-by-default `./bin/<binName>` hardlink + project lockfile
    const cwd = opts.cwd || process.cwd();
    const localBinDir = path.join(cwd, 'bin');
    fs.mkdirSync(localBinDir, { recursive: true });
    const destPath = path.join(localBinDir, effectiveName);
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
    const linkRes = store.linkBlobTo(opts.sha512, destPath, isExec) as unknown as {
      linked?: boolean;
      strategy?: string;
      method?: string;
    };

    const lockfilePath = upsertProjectLockfile(cwd, {
      id: `${parsed.org}/${parsed.repo}@${parsed.ref}`,
      uri: opts.uri,
      binName: effectiveName,
      sha512: opts.sha512,
    });

    return {
      scope: 'local',
      uri: opts.uri,
      binPath: destPath,
      lockfilePath,
      sha512: opts.sha512,
      hardlinked: linkRes.linked === true || linkRes.strategy === 'hardlink' || linkRes.method === 'hardlink',
      abiMagic: B8G_ABI_MAGIC_V3,
    };
  } finally {
    store.close();
  }
}

async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: holo-pm install <repository://github.com/org/repo@ref> [-g|--global] [--as <alias>] [--force-default] [--json]');
    return;
  }
  if (cmd !== 'install') {
    throw new Error(`holo-pm: unsupported subcommand "${cmd}" (use "install")`);
  }
  const uri = argv[1];
  if (!uri) throw new Error('holo-pm install: missing repository:// URI');
  const globalFlag = argv.includes('-g') || argv.includes('--global');
  const forceDefault = argv.includes('--force-default');
  const jsonFlag = argv.includes('--json');
  const asIdx = argv.indexOf('--as');
  const alias = asIdx >= 0 ? argv[asIdx + 1] : undefined;

  const parsed = parseGitForgeUri(uri);
  const relUrl = `https://api.github.com/repos/${parsed.org}/${parsed.repo}/releases/latest`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'holo-pm/v11' };
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const relRes = await fetch(relUrl, { headers });
  if (!relRes.ok) throw new Error(`holo-pm: GitHub release lookup failed (${relRes.status}) for ${parsed.org}/${parsed.repo}`);
  const rel = (await relRes.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
  const assets = rel.assets || [];

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const nativePick =
    assets.find((a) => isWin && a.name.toLowerCase().endsWith('.exe')) ||
    assets.find((a) => isMac && /darwin|macos/i.test(a.name) && !a.name.endsWith('.txt') && !a.name.endsWith('.json')) ||
    assets.find((a) => !isWin && !isMac && /linux/i.test(a.name) && !a.name.endsWith('.txt') && !a.name.endsWith('.json'));
  const treePick = assets.find((a) => a.name === 'v11-tree.json');
  const pick = nativePick || treePick;

  if (!pick) {
    throw new Error(`holo-pm: no compatible asset found in ${parsed.org}/${parsed.repo}@${rel.tag_name}`);
  }

  if (!jsonFlag) {
    console.log(`[holo-pm] Fetching ${parsed.org}/${parsed.repo}@${rel.tag_name} (${pick.name}, ${(pick.size / 1024).toFixed(1)} KB)...`);
  }
  const dlRes = await fetch(pick.browser_download_url, { headers: { 'User-Agent': 'holo-pm/v11' } });
  if (!dlRes.ok) throw new Error(`holo-pm: download failed (${dlRes.status}) for ${pick.name}`);
  const bytes = new Uint8Array(await dlRes.arrayBuffer());

  const casRoot = resolveUnifiedCasRoot();
  const store = new CasV11Store(casRoot);
  let sha512 = '';
  try {
    const put = store.putBlob(bytes, Boolean(nativePick));
    sha512 = put.sha512;
  } finally {
    store.close();
  }

  const effectiveName = (alias || parsed.repo).trim();
  const cwd = process.cwd();

  // Case A: Native platform executable -> hardlink directly into ./bin/ (or global bin)
  if (nativePick) {
    const binName = isWin && pick.name.toLowerCase().endsWith('.exe') ? `${effectiveName}.exe` : effectiveName;
    const receipt = installHoloPmBin({
      uri,
      sha512,
      binName,
      alias: binName,
      global: globalFlag,
      forceDefault,
      cwd,
    });
    const runCmd = globalFlag
      ? binName
      : (isWin ? `.\\bin\\${binName}` : `./bin/${binName}`);
    const out = { ...receipt, kind: 'native-binary', tag: rel.tag_name, asset: pick.name, runCommand: runCmd };
    if (jsonFlag) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`[holo-pm] Installed ${parsed.org}/${parsed.repo}@${rel.tag_name} (${receipt.hardlinked ? '0-byte v11 hardlink' : 'v11 CAS copy'})`);
      console.log(`  Binary:   ${receipt.binPath}`);
      if (receipt.lockfilePath) console.log(`  Lockfile: ${receipt.lockfilePath}`);
      console.log(`  Run now:  ${runCmd}`);
    }
    return;
  }

  // Case B: v11-tree.json package (e.g. desktop-omarchy, web/script pack with no native .exe for this OS)
  // Store manifest cleanly under ./.holo/manifests/ and stamp runnable launchers in ./bin/
  const manifestDir = path.join(cwd, '.holo', 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `${effectiveName}.v11-tree.json`);
  fs.writeFileSync(manifestPath, bytes);

  let totalFiles = 0;
  try {
    const parsedTree = JSON.parse(new TextDecoder().decode(bytes)) as { totalFiles?: number; files?: unknown[] };
    totalFiles = parsedTree.totalFiles ?? parsedTree.files?.length ?? 0;
  } catch {}

  const binDir = globalFlag ? defaultGlobalBinDir() : path.join(cwd, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const webAppMap: Record<string, string> = {
    'desktop-omarchy': 'https://awesome-os.github.io/apps/omarchy.html',
    'awesome-os-desktop': 'https://awesome-os.github.io/apps/desktop.html',
    'sectium': 'https://awesome-os.github.io/apps/sectium.html',
    'noctalia': 'https://awesome-os.github.io/apps/noctalia.html',
    'chonkstep': 'https://awesome-os.github.io/apps/chonkstep.html',
    'gitlab-foss': 'https://awesome-os.github.io/apps/gitlab.html',
  };
  const webUrl = webAppMap[parsed.repo] || `https://github.com/${parsed.org}/${parsed.repo}`;

  // Stamp real runnable Virtual Device Monitor wrappers (.cmd, .ps1, POSIX sh)
  const cmdPath = path.join(binDir, `${effectiveName}.cmd`);
  const ps1Path = path.join(binDir, `${effectiveName}.ps1`);
  const shPath = path.join(binDir, effectiveName);
  const deviceLauncherMts = path.resolve(new URL('./holo-device-launch.mts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  fs.writeFileSync(
    cmdPath,
    `@echo off\r\nchcp 65001 >nul\r\nif "%~1"=="--info" (\r\n  echo ${parsed.org}/${parsed.repo}@${rel.tag_name} [v11-tree: ${totalFiles} files]\r\n  echo Manifest: ${manifestPath}\r\n  echo Device:   ${webUrl}\r\n  exit /b 0\r\n)\r\nnode "${deviceLauncherMts}" "${effectiveName}" "${webUrl}" %*\r\n`,
    'utf8',
  );
  fs.writeFileSync(
    ps1Path,
    `param([switch]$Info, [switch]$Fullscreen, [switch]$DryRun)\n` +
      `if ($Info) {\n` +
      `  Write-Output "${parsed.org}/${parsed.repo}@${rel.tag_name} [v11-tree: ${totalFiles} files]"\n` +
      `  Write-Output "Manifest: ${manifestPath}"\n` +
      `  Write-Output "Device:   ${webUrl}"\n` +
      `  exit 0\n` +
      `}\n` +
      `$extra = @()\n` +
      `if ($Fullscreen) { $extra += '--fullscreen' }\n` +
      `if ($DryRun) { $extra += '--dry-run' }\n` +
      `& node "${deviceLauncherMts}" "${effectiveName}" "${webUrl}" @extra\n`,
    'utf8',
  );
  fs.writeFileSync(
    shPath,
    `#!/usr/bin/env sh\n` +
      `if [ "$1" = "--info" ]; then\n` +
      `  echo "${parsed.org}/${parsed.repo}@${rel.tag_name} [v11-tree: ${totalFiles} files]"\n` +
      `  echo "Manifest: ${manifestPath}"\n` +
      `  echo "Device:   ${webUrl}"\n` +
      `  exit 0\n` +
      `fi\n` +
      `node "${deviceLauncherMts}" "${effectiveName}" "${webUrl}" "$@"\n`,
    'utf8',
  );

  const lockfilePath = globalFlag
    ? null
    : upsertProjectLockfile(cwd, {
        id: `${parsed.org}/${parsed.repo}@${parsed.ref}`,
        uri,
        binName: effectiveName,
        sha512,
      });

  const runCmd = globalFlag
    ? effectiveName
    : (isWin ? `.\\bin\\${effectiveName}.cmd` : `./bin/${effectiveName}`);
  const out = {
    scope: globalFlag ? 'global' : 'local',
    kind: 'v11-tree-launcher',
    uri,
    tag: rel.tag_name,
    asset: pick.name,
    totalFiles,
    manifestPath,
    launcherPath: isWin ? cmdPath : shPath,
    webUrl,
    lockfilePath,
    sha512,
    abiMagic: B8G_ABI_MAGIC_V3,
    runCommand: runCmd,
  };

  if (jsonFlag) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`[holo-pm] Installed ${parsed.org}/${parsed.repo}@${rel.tag_name} (${totalFiles} files indexed via v11-tree.json)`);
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`  Launcher: ${isWin ? cmdPath : shPath}`);
    console.log(`  Run now:  ${runCmd}   (or ${runCmd} --info)`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).toLowerCase()
) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
