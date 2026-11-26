import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UniversalCompilerDebugHub, type CdpEvent } from './universal-compiler-debug.mts';

describe('UniversalCompilerDebugHub (HoloCompiler.* + Universal Polyglot CDP Debug)', () => {
  it('runs GraalVM-style feedback -> compileAndInstall (v11 CAS) -> runCompiled -> deoptimize over CDP', () => {
    const hub = new UniversalCompilerDebugHub();
    const events: CdpEvent[] = [];
    hub.onEvent((ev) => events.push(ev));

    const fb = hub.handleCdpCommand({
      id: 1,
      method: 'HoloCompiler.reportFeedback',
      params: {
        runtimeId: 'v8-main',
        language: 'ts-erasable',
        symbolId: 'matmul_f16',
        sourceUrl: 'file:///app/matmul.mts',
        invocations: 5000,
        monomorphicTypes: ['Float16Array'],
        branchTakenRatio: 0.99,
      },
    });
    assert.equal(fb.result?.recommendedTier, 'tier2-native-aot');
    assert.equal(fb.result?.readyForTierUp, true);

    const compiled = hub.handleCdpCommand({
      id: 2,
      method: 'HoloCompiler.compileAndInstall',
      params: {
        symbolId: 'matmul_f16',
        language: 'ts-erasable',
        sourceCode: 'export function matmul_f16(a, b) { return a * b; }',
      },
    });
    const codeHandle = String(compiled.result?.codeHandle);
    assert.ok(codeHandle.startsWith('holo://ts-erasable/matmul_f16@'));
    assert.ok(String(compiled.result?.casPath).startsWith('cas/v11/files/'));

    const run = hub.handleCdpCommand({
      id: 3,
      method: 'HoloCompiler.runCompiled',
      params: { codeHandle, args: [42] },
    });
    assert.equal(run.result?.status, 'executed');
    assert.equal(run.result?.tier, 'tier2-native-aot');

    const deopt = hub.handleCdpCommand({
      id: 4,
      method: 'HoloCompiler.deoptimize',
      params: { codeHandle, reason: 'polymorphic-guard-failed' },
    });
    assert.equal(deopt.result?.deoptimized, true);

    const fallbackRun = hub.handleCdpCommand({
      id: 5,
      method: 'HoloCompiler.runCompiled',
      params: { codeHandle, args: [42] },
    });
    assert.equal(fallbackRun.result?.status, 'deoptimized-fallback');
    assert.equal(fallbackRun.result?.tier, 'tier0-interp');
    assert.ok(events.some((e) => e.method === 'HoloCompiler.codeInstalled'));
    assert.ok(events.some((e) => e.method === 'HoloCompiler.deoptimized'));
  });

  it('attaches multiple languages (TS, C11/Zig, Kotlin/JVM, WASI, Colibri) into one unified CDP debug session', () => {
    const hub = new UniversalCompilerDebugHub();
    const events: CdpEvent[] = [];
    hub.onEvent((ev) => events.push(ev));

    hub.handleCdpCommand({ id: 10, method: 'Debugger.enable' });
    hub.handleCdpCommand({ id: 11, method: 'HoloDebug.attachRuntime', params: { runtimeId: 'ts-1', language: 'ts-erasable' } });
    hub.handleCdpCommand({ id: 12, method: 'HoloDebug.attachRuntime', params: { runtimeId: 'c11-1', language: 'c-zig-native' } });
    hub.handleCdpCommand({ id: 13, method: 'HoloDebug.attachRuntime', params: { runtimeId: 'jvm-1', language: 'jvm-kotlin' } });
    hub.handleCdpCommand({ id: 14, method: 'HoloDebug.attachRuntime', params: { runtimeId: 'colibri-1', language: 'colibri-moe' } });

    const bp = hub.handleCdpCommand({
      id: 15,
      method: 'Debugger.setBreakpointByUrl',
      params: { url: 'file:///colibri/c/colibri.c', lineNumber: 412, language: 'c-zig-native' },
    });
    assert.ok(String(bp.result?.breakpointId).startsWith('bp-'));

    hub.setPolyglotCallStack([
      { callFrameId: 'f0', functionName: 'colibri_route_experts', language: 'c-zig-native', runtimeId: 'c11-1', url: 'file:///colibri/c/colibri.c', lineNumber: 412, columnNumber: 4, locals: { k: 8 } },
      { callFrameId: 'f1', functionName: 'runInference', language: 'ts-erasable', runtimeId: 'ts-1', url: 'file:///app/agent.mts', lineNumber: 29, columnNumber: 12, locals: { model: 'glm-5.2' } },
    ]);

    const paused = hub.handleCdpCommand({ id: 16, method: 'Debugger.pause' });
    const frames = paused.result?.callFrames as Array<{ language: string }>;
    assert.equal(frames.length, 2);
    assert.equal(frames[0].language, 'c-zig-native');
    assert.equal(frames[1].language, 'ts-erasable');

    const evalRes = hub.handleCdpCommand({
      id: 17,
      method: 'Runtime.evaluate',
      params: { expression: 'k * 2', language: 'c-zig-native' },
    });
    assert.ok(String((evalRes.result?.result as { value: string }).value).includes('[c-zig-native]'));
    assert.ok(events.some((e) => e.method === 'Debugger.paused'));
  });

  it('intercepts I/O with automatic secret redaction and produces AI auto-verify verdicts (HoloVerify.*)', () => {
    const hub = new UniversalCompilerDebugHub();
    const events: CdpEvent[] = [];
    hub.onEvent((ev) => events.push(ev));

    hub.handleCdpCommand({ id: 20, method: 'HoloVerify.enableIoTap', params: { enabled: true } });
    const recIn = hub.handleCdpCommand({
      id: 21,
      method: 'HoloVerify.recordIo',
      params: { sessionId: 's1', direction: 'in', channel: 'ipc', payload: 'Authorization: Bearer super_secret_token_123' },
    });
    assert.equal(recIn.result?.redacted, true);
    assert.equal(recIn.result?.payload, 'Authorization: [REDACTED]');

    hub.handleCdpCommand({
      id: 22,
      method: 'HoloVerify.recordIo',
      params: { sessionId: 's1', direction: 'out', channel: 'stdout', payload: 'PASS: 16/16 checks green' },
    });

    const passVerdict = hub.handleCdpCommand({
      id: 23,
      method: 'HoloVerify.verifyTrace',
      params: {
        sessionId: 's1',
        assertions: { mustContain: ['PASS: 16/16'], mustNotContain: ['ERROR', 'super_secret_token_123'] },
      },
    });
    assert.equal(passVerdict.result?.verdict, 'PASS');
    assert.equal(passVerdict.result?.verifier, 'lumibert-2.8ms');

    const failVerdict = hub.handleCdpCommand({
      id: 24,
      method: 'HoloVerify.verifyTrace',
      params: { sessionId: 's1', assertions: { mustContain: ['NONEXISTENT_LINE'] } },
    });
    assert.equal(failVerdict.result?.verdict, 'FAIL');
    assert.ok(events.some((e) => e.method === 'HoloVerify.verdict'));
  });
});
