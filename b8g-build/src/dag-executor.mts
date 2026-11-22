/**
 * @file b8g-build/src/dag-executor.mts
 * @description Sovereign Zero-Ninja In-Process DAG Executor & `.ninja` Ingestor.
 * Eliminates legacy `ninja.exe` pain points on Windows & POSIX:
 *   1. Automatic `@rspfile` wrapping for any command > 30,000 chars (zero Windows GetLastError=87).
 *   2. Automatic single-TU retry with backoff on transient `0xC0000005` / rpmalloc signals.
 *   3. SHA-256 content-addressed output caching (`.b8g-cas/dag-cache.json`) for O(1) incremental skips.
 *   4. Bounded topological wave execution (`concurrency`, default 4 on Windows).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface DagNode {
  readonly id: string;
  readonly rule: string;
  readonly outputs: readonly string[];
  readonly inputs: readonly string[];
  readonly deps: readonly string[];
  readonly command: string;
  readonly rspfile?: string;
  readonly rspfileContent?: string;
}

export interface DagGraph {
  readonly name: string;
  readonly nodes: readonly DagNode[];
}

export interface DagExecutionEvent {
  readonly nodeId: string;
  readonly status: 'running' | 'cached' | 'retried' | 'done' | 'failed';
  readonly attempt: number;
  readonly durationMs: number;
  readonly detail?: string;
}

export interface DagExecutionOptions {
  readonly workDir: string;
  readonly concurrency?: number;
  readonly casDir?: string;
  readonly maxRetries?: number;
  readonly maxCommandChars?: number;
  readonly dryRun?: boolean;
  readonly runner?: (node: DagNode, effectiveCommand: string, attempt: number) => Promise<{ code: number; stderr?: string }>;
  readonly onEvent?: (ev: DagExecutionEvent) => void;
}

export interface DagExecutionSummary {
  readonly total: number;
  readonly executed: number;
  readonly cached: number;
  readonly retried: number;
  readonly failed: number;
  readonly wrappedLongCommands: number;
  readonly durationMs: number;
}

export function wrapLongCommandForWindows(
  command: string,
  workDir: string,
  nodeId: string,
  maxChars = 30_000,
): { command: string; wrapped: boolean; rspPath?: string } {
  if (command.length <= maxChars) {
    return { command, wrapped: false };
  }
  const safeId = nodeId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const rspDir = path.join(workDir, '.b8g-rsp');
  fs.mkdirSync(rspDir, { recursive: true });
  const rspPath = path.join(rspDir, `${safeId}.rsp`);

  const pyMatch = command.match(/^(\S*python3?(?:\.exe)?)\s+([\s\S]+)$/i);
  if (pyMatch) {
    const pyBin = pyMatch[1]!;
    const rest = pyMatch[2]!;
    const helperPath = path.join(rspDir, 'b8g_run_rsp.py');
    if (!fs.existsSync(helperPath)) {
      fs.writeFileSync(
        helperPath,
        [
          'import os, runpy, shlex, sys',
          'with open(sys.argv[1], "r", encoding="utf-8") as f:',
          '    args = shlex.split(f.read(), posix=True)',
          'sys.path.insert(0, os.path.dirname(os.path.abspath(args[0])))',
          'sys.argv = args',
          'runpy.run_path(args[0], run_name="__main__")',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    fs.writeFileSync(rspPath, rest, 'utf8');
    return {
      command: `${pyBin} "${helperPath}" "${rspPath}"`,
      wrapped: true,
      rspPath,
    };
  }

  // Generic compiler/linker @rspfile fallback (clang, clang-cl, lld-link, zig cc)
  const firstSpace = command.indexOf(' ');
  if (firstSpace > 0) {
    const exe = command.slice(0, firstSpace);
    const args = command.slice(firstSpace + 1);
    fs.writeFileSync(rspPath, args, 'utf8');
    return {
      command: `${exe} @"${rspPath}"`,
      wrapped: true,
      rspPath,
    };
  }
  return { command, wrapped: false };
}

export function parseNinjaFile(content: string, name = 'ninja-import'): DagGraph {
  const lines = content.split(/\r?\n/);
  const rules = new Map<string, { command: string; rspfile?: string; rspfileContent?: string }>();
  const nodes: DagNode[] = [];

  let currentRule: string | null = null;
  let buildIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('rule ')) {
      currentRule = line.slice(5).trim();
      rules.set(currentRule, { command: '' });
      continue;
    }
    if (currentRule && (line.startsWith('  ') || line.startsWith('\t'))) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        const rec = rules.get(currentRule)!;
        if (k === 'command') rec.command = v;
        else if (k === 'rspfile') rec.rspfile = v;
        else if (k === 'rspfile_content') rec.rspfileContent = v;
      }
      continue;
    }
    if (line.startsWith('build ')) {
      currentRule = null;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const outputs = line.slice(6, colon).trim().split(/\s+/).filter(Boolean);
      const rhs = line.slice(colon + 1).trim();
      const parts = rhs.split(/\s+/).filter(Boolean);
      const ruleName = parts[0] || 'phony';
      const inputs = parts.slice(1).filter((p) => p !== '|' && p !== '||');
      const ruleDef = rules.get(ruleName);
      nodes.push({
        id: outputs[0] || `node_${++buildIdx}`,
        rule: ruleName,
        outputs,
        inputs,
        deps: [],
        command: ruleDef?.command || '',
        ...(ruleDef?.rspfile ? { rspfile: ruleDef.rspfile } : {}),
        ...(ruleDef?.rspfileContent ? { rspfileContent: ruleDef.rspfileContent } : {}),
      });
      continue;
    }
    if (line.trim() === '') currentRule = null;
  }

  return { name, nodes };
}

export function auditNinjaLongCommands(content: string, thresholdChars = 30_000): Array<{ line: number; rule: string; length: number }> {
  const lines = content.split(/\r?\n/);
  const findings: Array<{ line: number; rule: string; length: number }> = [];
  let activeRule = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('rule ')) activeRule = l.slice(5).trim();
    else if (l.startsWith('  command = ') && l.length > thresholdChars) {
      findings.push({ line: i + 1, rule: activeRule, length: l.length });
    }
  }
  return findings;
}

function computeNodeDigest(node: DagNode, workDir: string): string {
  const h = crypto.createHash('sha256');
  h.update(node.id);
  h.update('\0');
  h.update(node.command);
  for (const inp of node.inputs) {
    h.update('\0');
    h.update(inp);
    const abs = path.resolve(workDir, inp);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        h.update(String(st.size));
        h.update(':');
        h.update(String(Math.floor(st.mtimeMs)));
      }
    }
  }
  return h.digest('hex');
}

function isTransientCompilerCrash(code: number, stderr = ''): boolean {
  if (code === -1073741819 || code === 3221225477) return true; // 0xC0000005
  if (/rpmalloc|clang frontend command failed due to signal|0xC0000005/i.test(stderr)) return true;
  return false;
}

async function runShellCommand(command: string, workDir: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: workDir,
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export async function executeDag(graph: DagGraph, opts: DagExecutionOptions): Promise<DagExecutionSummary> {
  const t0 = performance.now();
  const workDir = path.resolve(opts.workDir);
  const concurrency = Math.max(1, opts.concurrency ?? (process.platform === 'win32' ? 4 : 8));
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const maxCommandChars = opts.maxCommandChars ?? 30_000;

  const cacheFile = opts.casDir ? path.join(path.resolve(opts.casDir), 'dag-cache.json') : null;
  const cache: Record<string, string> = {};
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      Object.assign(cache, JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, string>);
    } catch {
      // fresh cache
    }
  }

  const nodeMap = new Map<string, DagNode>();
  const remainingDeps = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();

  for (const n of graph.nodes) {
    nodeMap.set(n.id, n);
    remainingDeps.set(n.id, new Set(n.deps.filter((d) => graph.nodes.some((x) => x.id === d))));
    dependents.set(n.id, []);
  }
  for (const n of graph.nodes) {
    for (const d of remainingDeps.get(n.id)!) {
      dependents.get(d)?.push(n.id);
    }
  }

  const ready: string[] = [];
  for (const [id, deps] of remainingDeps.entries()) {
    if (deps.size === 0) ready.push(id);
  }

  let executed = 0;
  let cached = 0;
  let retried = 0;
  let failed = 0;
  let wrappedLongCommands = 0;

  const runNode = async (node: DagNode): Promise<void> => {
    const nt0 = performance.now();
    const digest = computeNodeDigest(node, workDir);
    if (cache[node.id] === digest) {
      cached++;
      opts.onEvent?.({ nodeId: node.id, status: 'cached', attempt: 0, durationMs: performance.now() - nt0 });
      return;
    }

    const wrapped = wrapLongCommandForWindows(node.command, workDir, node.id, maxCommandChars);
    if (wrapped.wrapped) wrappedLongCommands++;

    if (opts.dryRun || !wrapped.command.trim()) {
      executed++;
      cache[node.id] = digest;
      opts.onEvent?.({ nodeId: node.id, status: 'done', attempt: 1, durationMs: performance.now() - nt0 });
      return;
    }

    let attempt = 0;
    while (attempt <= maxRetries) {
      attempt++;
      opts.onEvent?.({ nodeId: node.id, status: 'running', attempt, durationMs: 0 });
      const res = opts.runner
        ? await opts.runner(node, wrapped.command, attempt)
        : await runShellCommand(wrapped.command, workDir);

      if (res.code === 0) {
        executed++;
        cache[node.id] = digest;
        opts.onEvent?.({ nodeId: node.id, status: 'done', attempt, durationMs: performance.now() - nt0 });
        return;
      }

      if (attempt <= maxRetries && isTransientCompilerCrash(res.code, res.stderr)) {
        retried++;
        opts.onEvent?.({
          nodeId: node.id,
          status: 'retried',
          attempt,
          durationMs: performance.now() - nt0,
          detail: res.stderr || `exit ${res.code}`,
        });
        await new Promise((r) => setTimeout(r, 40 * attempt));
        continue;
      }

      failed++;
      opts.onEvent?.({
        nodeId: node.id,
        status: 'failed',
        attempt,
        durationMs: performance.now() - nt0,
        detail: res.stderr || `exit ${res.code}`,
      });
      return;
    }
  };

  while (ready.length > 0 && failed === 0) {
    const wave = ready.splice(0, concurrency);
    await Promise.all(
      wave.map(async (id) => {
        const node = nodeMap.get(id)!;
        await runNode(node);
        for (const depOf of dependents.get(id) || []) {
          const set = remainingDeps.get(depOf)!;
          set.delete(id);
          if (set.size === 0) ready.push(depOf);
        }
      }),
    );
  }

  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  }

  return {
    total: graph.nodes.length,
    executed,
    cached,
    retried,
    failed,
    wrappedLongCommands,
    durationMs: performance.now() - t0,
  };
}
