#!/usr/bin/env node
/**
 * @file intersections/holo-compiler/holo-jq.mts
 * @description Shared-V8 native JSON query & transform CLI (`holo-jq`).
 * Replaces the C `jq` + `oniguruma` bytecode interpreter with V8's SIMD `JSON.parse`
 * and TurboFan JIT (`dup_v8 = 0 B`).
 *
 * Supports:
 *   - Core jq filters: `.`, `.a.b`, `.[]`, `.items[]`, `.[0]`, `|`, `keys`, `length`, `type`, `select(.k == v)`
 *   - Direct JS mode: `--js "x.items.filter(i => i.ok).map(i => i.name)"`
 *   - Flags: `-r` / `--raw-output`, `-c` / `--compact-output`, `--js <expr>`
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function evaluateSingleStage(value: unknown, stage: string): unknown[] {
  const s = stage.trim();
  if (!s || s === '.') return [value];
  if (s === 'length') {
    if (Array.isArray(value) || typeof value === 'string') return [value.length];
    if (value && typeof value === 'object') return [Object.keys(value).length];
    return [0];
  }
  if (s === 'keys') {
    if (Array.isArray(value)) return [value.map((_, i) => i)];
    if (value && typeof value === 'object') return [Object.keys(value).sort()];
    return [[]];
  }
  if (s === 'type') {
    if (value === null) return ['null'];
    if (Array.isArray(value)) return ['array'];
    return [typeof value];
  }
  const selectMatch = s.match(/^select\((.+)\)$/);
  if (selectMatch?.[1]) {
    const cond = selectMatch[1].trim();
    const cmp = cond.match(/^(\.[A-Za-z0-9_.-]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (cmp?.[1] && cmp[2] && cmp[3]) {
      const lhs = evaluateSingleStage(value, cmp[1])[0];
      let rhs: unknown;
      try {
        rhs = JSON.parse(cmp[3].trim());
      } catch {
        rhs = cmp[3].trim().replace(/^['"]|['"]$/g, '');
      }
      let ok = false;
      switch (cmp[2]) {
        case '==': ok = lhs === rhs; break;
        case '!=': ok = lhs !== rhs; break;
        case '>': ok = Number(lhs) > Number(rhs); break;
        case '>=': ok = Number(lhs) >= Number(rhs); break;
        case '<': ok = Number(lhs) < Number(rhs); break;
        case '<=': ok = Number(lhs) <= Number(rhs); break;
      }
      return ok ? [value] : [];
    }
    // Truthy path check e.g. select(.active)
    const truthy = evaluateSingleStage(value, cond)[0];
    return truthy ? [value] : [];
  }

  // Path traversal + optional [] / [idx]
  if (s.startsWith('.')) {
    const tokens = s
      .slice(1)
      .split('.')
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [value];

    let current: unknown[] = [value];
    for (const rawTok of tokens) {
      const next: unknown[] = [];
      const arrAll = rawTok.endsWith('[]');
      const idxMatch = rawTok.match(/^(.*)\[(\d+)\]$/);

      for (const item of current) {
        if (rawTok === '[]') {
          if (Array.isArray(item)) next.push(...item);
          else if (item && typeof item === 'object') next.push(...Object.values(item));
          continue;
        }
        if (arrAll) {
          const prop = rawTok.slice(0, -2);
          const sub =
            prop && item && typeof item === 'object'
              ? (item as Record<string, unknown>)[prop]
              : item;
          if (Array.isArray(sub)) next.push(...sub);
          else if (sub && typeof sub === 'object') next.push(...Object.values(sub));
          continue;
        }
        if (idxMatch) {
          const prop = idxMatch[1] || '';
          const idx = Number(idxMatch[2]);
          const sub =
            prop && item && typeof item === 'object'
              ? (item as Record<string, unknown>)[prop]
              : item;
          next.push(Array.isArray(sub) ? sub[idx] : undefined);
          continue;
        }
        if (item && typeof item === 'object') {
          next.push((item as Record<string, unknown>)[rawTok]);
        } else {
          next.push(undefined);
        }
      }
      current = next;
    }
    return current;
  }

  throw new Error(`holo-jq: unsupported filter stage "${stage}" (use --js for arbitrary JS expressions)`);
}

export function evalHoloJqFilter(input: unknown, filter: string): unknown[] {
  const stages = filter.split('|').map((s) => s.trim()).filter(Boolean);
  let stream: unknown[] = [input];
  for (const stage of stages) {
    const next: unknown[] = [];
    for (const val of stream) {
      next.push(...evaluateSingleStage(val, stage));
    }
    stream = next;
  }
  return stream;
}

export function evalHoloJsExpr(input: unknown, expr: string): unknown {
  const fn = new Function('x', `return (${expr});`) as (x: unknown) => unknown;
  return fn(input);
}

export function formatHoloJqOutput(values: readonly unknown[], opts: { raw?: boolean; compact?: boolean }): string {
  return values
    .map((v) => {
      if (opts.raw && typeof v === 'string') return v;
      return opts.compact ? JSON.stringify(v) : JSON.stringify(v, null, 2);
    })
    .join('\n');
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const args = process.argv.slice(2);
  let raw = false;
  let compact = false;
  let jsExpr: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-r' || a === '--raw-output') raw = true;
    else if (a === '-c' || a === '--compact-output') compact = true;
    else if (a === '--js' && args[i + 1]) jsExpr = args[++i]!;
    else positional.push(a);
  }

  const filter = jsExpr ? null : (positional.shift() || '.');
  const filePath = positional.shift();
  const rawJson = filePath ? fs.readFileSync(filePath, 'utf8') : fs.readFileSync(0, 'utf8');
  const parsed: unknown = JSON.parse(rawJson);

  const results = jsExpr ? [evalHoloJsExpr(parsed, jsExpr)] : evalHoloJqFilter(parsed, filter!);
  process.stdout.write(formatHoloJqOutput(results, { raw, compact }) + '\n');
}
