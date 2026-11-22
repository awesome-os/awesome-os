#!/usr/bin/env node
/**
 * @file b8g-build/src/dag-build-cli.mts
 * @description Sovereign Zero-GN / Zero-Ninja Build CLI (`.\bin\b8g-dag-build`).
 * Usage:
 *   b8g-dag-build sectium-plan [--src E:\b8g-chromium-real\src] [--target x86_64-windows-msvc|x86_64-linux-gnu]
 *   b8g-dag-build ninja-audit  <path/to/toolchain.ninja>
 *   b8g-dag-build run-sectium  [--dry-run] [--concurrency 4]
 */

import fs from 'node:fs';
import path from 'node:path';
import { auditNinjaLongCommands, executeDag } from './dag-executor.mts';
import {
  buildSectiumMinimalDag,
  type SectiumLinkMode,
  type SectiumPgoMode,
  type SectiumTargetTriple,
} from './sectium-minimal-dag.mts';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = { _: argv[0] || 'sectium-plan' };
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
    } else if (!out.pos1) {
      out.pos1 = a;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._);

  if (cmd === 'sectium-plan' || cmd === 'run-sectium') {
    const src = String(args.src || 'E:\\b8g-chromium-real\\src');
    const outDir = String(args.out || path.join(process.cwd(), '.b8g-cas', 'sectium-minimal-out'));
    const targetTriple = (String(args.target || 'x86_64-windows-msvc')) as SectiumTargetTriple;
    const linkMode = (String(args['link-mode'] || 'late-link')) as SectiumLinkMode;
    const pgoMode = (String(args['pgo-mode'] || 'cached-profdata')) as SectiumPgoMode;
    const plan = buildSectiumMinimalDag({ chromiumSrcDir: src, outDir, targetTriple, linkMode, pgoMode });

    if (cmd === 'sectium-plan') {
      console.log(
        JSON.stringify(
          {
            profile: plan.profile,
            targetTriple: plan.targetTriple,
            compiler: plan.compiler,
            linkMode: plan.linkMode,
            pgoMode: plan.pgoMode,
            astFreePreLookup: plan.astFreePreLookup,
            zeroGnRequired: plan.zeroGnRequired,
            zeroNinjaRequired: plan.zeroNinjaRequired,
            retainedSubtrees: plan.retainedSubtrees,
            droppedBloatSubsystems: plan.droppedBloatSubsystems,
            nodes: plan.graph.nodes.map((n) => ({ id: n.id, deps: n.deps, outputs: n.outputs })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const summary = await executeDag(plan.graph, {
      workDir: process.cwd(),
      casDir: path.join(process.cwd(), '.b8g-cas', 'dag-cache'),
      concurrency: Number(args.concurrency || 4) || 4,
      dryRun: Boolean(args['dry-run']),
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (cmd === 'ninja-audit') {
    const file = String(args.pos1 || '');
    if (!file || !fs.existsSync(file)) {
      console.error('Provide an existing .ninja file path.');
      process.exit(1);
    }
    const content = fs.readFileSync(file, 'utf8');
    const findings = auditNinjaLongCommands(content, 30_000);
    console.log(JSON.stringify({ file, over30kCommands: findings.length, findings }, null, 2));
    return;
  }

  console.error(`Unknown subcommand: ${cmd}. Use sectium-plan | run-sectium | ninja-audit.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
