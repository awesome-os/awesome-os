#!/usr/bin/env node
/**
 * @file src/cli.mts
 * @description CLI to stamp installers (`install.ps1`, `install.sh`), pixel-aligned
 * `splash_layout.h`, and `web-catalog.json` from `.mts` release matrix definitions.
 *
 * Usage:
 *   node src/cli.mts stamp [--out ./dist] [--web-host https://awesome-os.github.io/installer/downloads] [--only sectium-browser]
 */

import { resolve } from 'node:path';
import { AWESOME_OS_CATALOG } from '../catalog/awesome-os-apps.mts';
import { stampCatalog } from './index.mts';

const args = process.argv.slice(2);
let outDir = resolve(process.cwd(), 'dist');
let webHost: string | undefined;
let onlyId: string | undefined;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out' && args[i + 1]) {
    outDir = resolve(args[++i]!);
  } else if (args[i] === '--web-host' && args[i + 1]) {
    webHost = args[++i];
  } else if (args[i] === '--only' && args[i + 1]) {
    onlyId = args[++i];
  }
}

const defs = onlyId ? AWESOME_OS_CATALOG.filter((d) => d.id === onlyId) : AWESOME_OS_CATALOG;
if (defs.length === 0) {
  console.error(`No catalog entry matched --only "${onlyId}"`);
  process.exit(1);
}

const result = stampCatalog(defs, outDir, webHost);
console.log(
  JSON.stringify(
    {
      stampedCount: result.stamped.length,
      catalogJsonPath: result.catalogJsonPath,
      webHost: webHost ?? 'github-releases-default',
      apps: result.stamped.map((s) => ({
        id: s.id,
        windows: s.installPs1Command,
        posix: s.installShCommand,
      })),
    },
    null,
    2,
  ),
);
