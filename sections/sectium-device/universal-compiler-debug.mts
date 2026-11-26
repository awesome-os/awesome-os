/**
 * @file sections/sectium-device/universal-compiler-debug.mts
 * @description Universal Compiler Feedback (`HoloCompiler.*`, GraalVM JVMCI/Truffle-style)
 * + Universal Polyglot Debugger (`HoloDebug.*` + standard CDP `Debugger.*` / `Runtime.*`)
 * riding over `SectiumDevToolsPlane` (`channel: 'command'`, B8G016-compliant).
 */

import { createHash } from 'node:crypto';

export type PolyglotRuntimeKind =
  | 'js-v8'
  | 'ts-erasable'
  | 'jvm-kotlin'
  | 'c-zig-native'
  | 'wasm-wasi'
  | 'python'
  | 'colibri-moe';

export type CompilerTier = 'tier0-interp' | 'tier1-ssa' | 'tier2-native-aot';

export interface CompilerFeedbackReport {
  runtimeId: string;
  language: PolyglotRuntimeKind;
  symbolId: string;
  sourceUrl: string;
  invocations: number;
  monomorphicTypes: string[];
  branchTakenRatio: number; // 0..1
  hotLoopBackedges?: number;
  deoptReason?: string;
}

export interface CompiledCodeArtifact {
  codeHandle: string;
  symbolId: string;
  language: PolyglotRuntimeKind;
  tier: CompilerTier;
  casPath: string;
  sha512: string;
  compiledAt: number;
  speculatedTypes: string[];
  deoptimized: boolean;
}

export interface PolyglotRuntimeSession {
  runtimeId: string;
  language: PolyglotRuntimeKind;
  pidOrThread: string;
  adapter: 'cdp-native' | 'jdwp-bridge' | 'dwarf-pdb-bridge' | 'wasi-dwarf' | 'dap-python' | 'colibri-expert-trace';
  attachedAt: number;
  paused: boolean;
}

export interface PolyglotBreakpoint {
  breakpointId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  language?: PolyglotRuntimeKind;
  condition?: string;
  hitCount: number;
}

export interface PolyglotCallFrame {
  callFrameId: string;
  functionName: string;
  language: PolyglotRuntimeKind;
  runtimeId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  locals: Record<string, unknown>;
}

export interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CdpEvent {
  method: string;
  channel: 'command';
  timestamp: number;
  params: Record<string, unknown>;
}

export interface IoTraceFrame {
  traceId: string;
  sessionId: string;
  direction: 'in' | 'out';
  channel: 'stdin' | 'stdout' | 'stderr' | 'dom' | 'ipc' | 'eval';
  payload: string;
  redacted: boolean;
  sha512: string;
  timestamp: number;
}

export interface AutoVerifyAssertion {
  mustContain?: string[];
  mustNotContain?: string[];
  expectedSha512?: string;
}

export interface AutoVerifyVerdict {
  sessionId: string;
  verdict: 'PASS' | 'FAIL';
  verifier: 'lumibert-2.8ms' | 'agent-cdp';
  frameCount: number;
  failures: string[];
  traceDigestSha512: string;
  verifiedAt: number;
}

const SECRET_PATTERN = /(Bearer\s+[A-Za-z0-9._-]+|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]+|password\s*[:=]\s*\S+|api[_-]?key\s*[:=]\s*\S+)/gi;

function redactSecrets(text: string): { sanitized: string; redacted: boolean } {
  let redacted = false;
  const sanitized = text.replace(SECRET_PATTERN, () => {
    redacted = true;
    return '[REDACTED]';
  });
  return { sanitized, redacted };
}

export class UniversalCompilerDebugHub {
  readonly #runtimes = new Map<string, PolyglotRuntimeSession>();
  readonly #feedback = new Map<string, CompilerFeedbackReport>();
  readonly #artifacts = new Map<string, CompiledCodeArtifact>();
  readonly #breakpoints = new Map<string, PolyglotBreakpoint>();
  readonly #listeners = new Set<(ev: CdpEvent) => void>();
  readonly #ioTraces = new Map<string, IoTraceFrame[]>();
  #ioTapEnabled = false;
  #traceSeq = 0;
  #callStack: PolyglotCallFrame[] = [];
  #debuggerEnabled = false;
  #bpSeq = 0;

  onEvent(listener: (ev: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(method: string, params: Record<string, unknown>): void {
    const ev: CdpEvent = { method, channel: 'command', timestamp: Date.now(), params };
    for (const fn of this.#listeners) fn(ev);
  }

  attachRuntime(input: {
    runtimeId: string;
    language: PolyglotRuntimeKind;
    pidOrThread?: string;
  }): PolyglotRuntimeSession {
    const adapterMap: Record<PolyglotRuntimeKind, PolyglotRuntimeSession['adapter']> = {
      'js-v8': 'cdp-native',
      'ts-erasable': 'cdp-native',
      'jvm-kotlin': 'jdwp-bridge',
      'c-zig-native': 'dwarf-pdb-bridge',
      'wasm-wasi': 'wasi-dwarf',
      python: 'dap-python',
      'colibri-moe': 'colibri-expert-trace',
    };
    const session: PolyglotRuntimeSession = {
      runtimeId: input.runtimeId,
      language: input.language,
      pidOrThread: input.pidOrThread ?? `${input.language}:main`,
      adapter: adapterMap[input.language],
      attachedAt: Date.now(),
      paused: false,
    };
    this.#runtimes.set(session.runtimeId, session);
    this.#emit('HoloDebug.runtimeAttached', { session });
    return session;
  }

  reportFeedback(report: CompilerFeedbackReport): {
    symbolId: string;
    recommendedTier: CompilerTier;
    readyForTierUp: boolean;
  } {
    this.#feedback.set(report.symbolId, report);
    const recommendedTier: CompilerTier =
      report.invocations >= 1000 && report.monomorphicTypes.length <= 2
        ? 'tier2-native-aot'
        : report.invocations >= 100
          ? 'tier1-ssa'
          : 'tier0-interp';
    const readyForTierUp = recommendedTier !== 'tier0-interp';
    this.#emit('HoloCompiler.feedbackUpdated', {
      symbolId: report.symbolId,
      language: report.language,
      invocations: report.invocations,
      recommendedTier,
      readyForTierUp,
    });
    return { symbolId: report.symbolId, recommendedTier, readyForTierUp };
  }

  compileAndInstall(params: {
    symbolId: string;
    language: PolyglotRuntimeKind;
    sourceCode: string;
    targetTier?: CompilerTier;
  }): CompiledCodeArtifact {
    const fb = this.#feedback.get(params.symbolId);
    const tier: CompilerTier =
      params.targetTier ??
      (fb && fb.invocations >= 1000 ? 'tier2-native-aot' : 'tier1-ssa');
    const speculatedTypes = fb ? [...fb.monomorphicTypes] : ['any'];

    const irPayload = JSON.stringify({
      schema: 'holo-compiler.ssa-artifact.v1',
      symbolId: params.symbolId,
      language: params.language,
      tier,
      speculatedTypes,
      sourceCode: params.sourceCode,
    });
    const sha512 = createHash('sha512').update(irPayload).digest('hex');
    const casPath = `cas/v11/files/${sha512.slice(0, 2)}/${sha512}`;
    const codeHandle = `holo://${params.language}/${params.symbolId}@${sha512.slice(0, 12)}`;

    const artifact: CompiledCodeArtifact = {
      codeHandle,
      symbolId: params.symbolId,
      language: params.language,
      tier,
      casPath,
      sha512,
      compiledAt: Date.now(),
      speculatedTypes,
      deoptimized: false,
    };
    this.#artifacts.set(codeHandle, artifact);
    this.#emit('HoloCompiler.codeInstalled', { artifact });
    return artifact;
  }

  runCompiled(codeHandle: string, args: unknown[] = []): {
    codeHandle: string;
    tier: CompilerTier;
    language: PolyglotRuntimeKind;
    casPath: string;
    durationMs: number;
    status: 'executed' | 'deoptimized-fallback';
    argsEcho: unknown[];
  } {
    const art = this.#artifacts.get(codeHandle);
    if (!art) {
      throw new Error(`Unknown compiled codeHandle: ${codeHandle}`);
    }
    const t0 = performance.now();
    const status = art.deoptimized ? 'deoptimized-fallback' : 'executed';
    const durationMs = Number((performance.now() - t0).toFixed(4));
    this.#emit('HoloCompiler.executionCompleted', { codeHandle, status, durationMs, tier: art.tier });
    return {
      codeHandle,
      tier: art.deoptimized ? 'tier0-interp' : art.tier,
      language: art.language,
      casPath: art.casPath,
      durationMs,
      status,
      argsEcho: args,
    };
  }

  deoptimize(codeHandle: string, reason: string): CompiledCodeArtifact {
    const art = this.#artifacts.get(codeHandle);
    if (!art) throw new Error(`Unknown compiled codeHandle: ${codeHandle}`);
    art.deoptimized = true;
    this.#emit('HoloCompiler.deoptimized', { codeHandle, symbolId: art.symbolId, reason });
    return art;
  }

  setPolyglotCallStack(frames: PolyglotCallFrame[]): void {
    this.#callStack = frames;
  }

  enableIoTap(enabled: boolean): { enabled: boolean } {
    this.#ioTapEnabled = enabled;
    this.#emit('HoloVerify.ioTapChanged', { enabled });
    return { enabled };
  }

  recordIo(input: {
    sessionId: string;
    direction: IoTraceFrame['direction'];
    channel: IoTraceFrame['channel'];
    payload: string;
  }): IoTraceFrame {
    if (!this.#ioTapEnabled) {
      throw new Error('I/O tap is disabled. Call HoloVerify.enableIoTap first.');
    }
    const { sanitized, redacted } = redactSecrets(input.payload);
    const sha512 = createHash('sha512').update(sanitized).digest('hex');
    const frame: IoTraceFrame = {
      traceId: `io-${++this.#traceSeq}`,
      sessionId: input.sessionId,
      direction: input.direction,
      channel: input.channel,
      payload: sanitized,
      redacted,
      sha512,
      timestamp: Date.now(),
    };
    const list = this.#ioTraces.get(input.sessionId) ?? [];
    list.push(frame);
    this.#ioTraces.set(input.sessionId, list);
    this.#emit('HoloVerify.ioRecorded', { frame });
    return frame;
  }

  verifyTrace(
    sessionId: string,
    assertions: AutoVerifyAssertion = {},
    verifier: AutoVerifyVerdict['verifier'] = 'lumibert-2.8ms',
  ): AutoVerifyVerdict {
    const frames = this.#ioTraces.get(sessionId) ?? [];
    const combinedOut = frames
      .filter((f) => f.direction === 'out')
      .map((f) => f.payload)
      .join('\n');
    const traceDigestSha512 = createHash('sha512')
      .update(JSON.stringify(frames.map((f) => ({ d: f.direction, c: f.channel, h: f.sha512 }))))
      .digest('hex');

    const failures: string[] = [];
    for (const needle of assertions.mustContain ?? []) {
      if (!combinedOut.includes(needle)) failures.push(`Missing expected output: "${needle}"`);
    }
    for (const forbidden of assertions.mustNotContain ?? []) {
      if (combinedOut.includes(forbidden)) failures.push(`Found forbidden output: "${forbidden}"`);
    }
    if (assertions.expectedSha512 && traceDigestSha512 !== assertions.expectedSha512) {
      failures.push(`Trace digest mismatch: expected ${assertions.expectedSha512.slice(0, 16)}, got ${traceDigestSha512.slice(0, 16)}`);
    }

    const verdict: AutoVerifyVerdict = {
      sessionId,
      verdict: failures.length === 0 ? 'PASS' : 'FAIL',
      verifier,
      frameCount: frames.length,
      failures,
      traceDigestSha512,
      verifiedAt: Date.now(),
    };
    this.#emit('HoloVerify.verdict', { verdict });
    return verdict;
  }

  handleCdpCommand(req: CdpRequest): CdpResponse {
    const p = req.params ?? {};
    try {
      switch (req.method) {
        // --- Universal Compiler Feedback Domain (HoloCompiler.*) ---
        case 'HoloCompiler.reportFeedback':
          return { id: req.id, result: this.reportFeedback(p as unknown as CompilerFeedbackReport) };
        case 'HoloCompiler.compileAndInstall':
          return {
            id: req.id,
            result: this.compileAndInstall(
              p as unknown as {
                symbolId: string;
                language: PolyglotRuntimeKind;
                sourceCode: string;
                targetTier?: CompilerTier;
              },
            ) as unknown as Record<string, unknown>,
          };
        case 'HoloCompiler.runCompiled':
          return {
            id: req.id,
            result: this.runCompiled(String(p.codeHandle ?? ''), Array.isArray(p.args) ? p.args : []),
          };
        case 'HoloCompiler.deoptimize':
          return {
            id: req.id,
            result: this.deoptimize(String(p.codeHandle ?? ''), String(p.reason ?? 'speculation-guard')) as unknown as Record<string, unknown>,
          };

        // --- Universal Polyglot Debug Domain (HoloDebug.* + Standard CDP Debugger.* / Runtime.*) ---
        case 'HoloDebug.attachRuntime':
          return {
            id: req.id,
            result: {
              session: this.attachRuntime({
                runtimeId: String(p.runtimeId ?? ''),
                language: p.language as PolyglotRuntimeKind,
                pidOrThread: typeof p.pidOrThread === 'string' ? p.pidOrThread : undefined,
              }),
            },
          };
        case 'HoloDebug.listRuntimes':
          return { id: req.id, result: { runtimes: Array.from(this.#runtimes.values()) } };
        case 'Debugger.enable':
          this.#debuggerEnabled = true;
          return { id: req.id, result: { debuggerId: 'holo-universal-debugger-v1', polyglot: true } };
        case 'Debugger.setBreakpointByUrl': {
          const id = `bp-${++this.#bpSeq}`;
          const bp: PolyglotBreakpoint = {
            breakpointId: id,
            url: String(p.url ?? ''),
            lineNumber: Number(p.lineNumber ?? 0),
            columnNumber: Number(p.columnNumber ?? 0),
            language: typeof p.language === 'string' ? (p.language as PolyglotRuntimeKind) : undefined,
            condition: typeof p.condition === 'string' ? p.condition : undefined,
            hitCount: 0,
          };
          this.#breakpoints.set(id, bp);
          return {
            id: req.id,
            result: {
              breakpointId: id,
              locations: [{ scriptId: bp.url, lineNumber: bp.lineNumber, columnNumber: bp.columnNumber }],
            },
          };
        }
        case 'Debugger.removeBreakpoint': {
          const bpId = String(p.breakpointId ?? '');
          this.#breakpoints.delete(bpId);
          return { id: req.id, result: {} };
        }
        case 'Debugger.pause': {
          for (const rt of this.#runtimes.values()) rt.paused = true;
          this.#emit('Debugger.paused', {
            reason: 'other',
            callFrames: this.#callStack,
            polyglotRuntimes: Array.from(this.#runtimes.keys()),
          });
          return { id: req.id, result: { paused: true, callFrames: this.#callStack } };
        }
        case 'Debugger.resume':
        case 'Debugger.stepOver':
        case 'Debugger.stepInto': {
          for (const rt of this.#runtimes.values()) rt.paused = false;
          this.#emit('Debugger.resumed', { action: req.method });
          return { id: req.id, result: { resumed: true, action: req.method } };
        }
        case 'Runtime.evaluate': {
          const expression = String(p.expression ?? '');
          const language = typeof p.language === 'string' ? p.language : 'js-v8';
          return {
            id: req.id,
            result: {
              result: {
                type: 'string',
                value: `[${language}] evaluated: ${expression}`,
              },
              debuggerEnabled: this.#debuggerEnabled,
            },
          };
        }

        // --- Deterministic I/O Tap & AI Auto-Verify Domain (HoloVerify.*) ---
        case 'HoloVerify.enableIoTap':
          return { id: req.id, result: this.enableIoTap(Boolean(p.enabled ?? true)) };
        case 'HoloVerify.recordIo':
          return {
            id: req.id,
            result: this.recordIo({
              sessionId: String(p.sessionId ?? 'default'),
              direction: (p.direction === 'in' ? 'in' : 'out'),
              channel: (typeof p.channel === 'string' ? p.channel : 'eval') as IoTraceFrame['channel'],
              payload: String(p.payload ?? ''),
            }) as unknown as Record<string, unknown>,
          };
        case 'HoloVerify.verifyTrace':
          return {
            id: req.id,
            result: this.verifyTrace(
              String(p.sessionId ?? 'default'),
              (p.assertions ?? {}) as AutoVerifyAssertion,
              p.verifier === 'agent-cdp' ? 'agent-cdp' : 'lumibert-2.8ms',
            ) as unknown as Record<string, unknown>,
          };
        case 'HoloVerify.getTraces': {
          const sessionId = String(p.sessionId ?? 'default');
          return { id: req.id, result: { sessionId, frames: this.#ioTraces.get(sessionId) ?? [] } };
        }
        default:
          return { id: req.id, error: { code: -32601, message: `Unsupported CDP method: ${req.method}` } };
      }
    } catch (err) {
      return {
        id: req.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
