/**
 * @file packages/@awesome-os/stealify-schema/src/intersection-stream.test.mts
 * @description Unit tests for the pure Web Streams 7-Tuple Composed Intersection Stream primitive.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ContextConflictError, type ExecutionContext } from './algebra.mts'
import {
  composeIntersectionStreams,
  ContextGateError,
  createContextGateTransform,
  createFrameCollector,
  createFrameSource,
  createPersonaTee,
  type ComposedIntersectionStream,
  type StreamFrame,
} from './intersection-stream.mts'

const consumerCallerCtx: ExecutionContext = {
  boundary: 'host-win32',
  display: 'interactive-fg',
  lifetime: 'window-bound',
  transport: 'arena-sab',
  capability: { tenantId: 'acme', scopes: ['gpu.present', 'telemetry.read'], epoch: 3, privateData: false },
  locality: 'local-arena',
  persona: 'consumer',
}

const devopsCallerCtx: ExecutionContext = {
  ...consumerCallerCtx,
  capability: { tenantId: 'acme', scopes: ['*'], epoch: 3, privateData: false },
  persona: 'devops',
}

const kernelAuditCallerCtx: ExecutionContext = {
  ...devopsCallerCtx,
  persona: 'kernel-audit',
}

const sampleFrames: readonly StreamFrame<string>[] = [
  { kind: 'data', source: 'renderer', minPersona: 'consumer', payload: 'frame-1', ts: 100 },
  { kind: 'metric', source: 'gpu', minPersona: 'devops', payload: 'fps=120', ts: 101 },
  { kind: 'error', source: 'shader', minPersona: 'devops', payload: 'pipeline-stall', ts: 102 },
  { kind: 'advisory', source: 'auditor', minPersona: 'kernel-audit', payload: 'ring-watermark', ts: 103 },
  { kind: 'data', source: 'renderer', minPersona: 'consumer', payload: 'frame-2', ts: 104 },
  { kind: 'fix', source: 'healer', minPersona: 'devops', payload: 'reset-queue', ts: 105 },
]

describe('7-Tuple Composed Intersection Stream (Pure Web Streams)', () => {
  it('createContextGateTransform filters devops & kernel-audit frames from consumer callers with zero leakage', async () => {
    const reqCtx: ExecutionContext = {
      ...consumerCallerCtx,
      capability: { tenantId: 'acme', scopes: ['gpu.present'], epoch: 3, privateData: false },
    }

    const gate = createContextGateTransform<string>(reqCtx, consumerCallerCtx)
    const collector = createFrameCollector<string>()

    await createFrameSource(sampleFrames).pipeThrough(gate).pipeTo(collector.writable)
    const out = await collector.done

    assert.equal(out.length, 2)
    assert.deepEqual(
      out.map((f) => f.payload),
      ['frame-1', 'frame-2']
    )
    assert.ok(out.every((f) => f.minPersona === 'consumer'))
    assert.ok(out.every((f) => f.violations === undefined))
  })

  it('createContextGateTransform errors the stream in strict mode when admissibility fails', async () => {
    const strictReqCtx: ExecutionContext = {
      ...devopsCallerCtx,
      display: 'interactive-fg',
      capability: { tenantId: 'acme', scopes: ['admin.root'], epoch: 99, privateData: false },
      persona: 'devops',
    }

    const strictGate = createContextGateTransform<string>(strictReqCtx, consumerCallerCtx, { strict: true })
    const collector = createFrameCollector<string>()

    await assert.rejects(
      () => createFrameSource(sampleFrames).pipeThrough(strictGate).pipeTo(collector.writable),
      (err: unknown) =>
        err instanceof ContextGateError &&
        err.violations.some((v) => v.invariant === 'CAPABILITY_INCLUSION') &&
        err.violations.some((v) => v.invariant === 'CAPABILITY_EPOCH') &&
        err.violations.some((v) => v.invariant === 'PERSONA_ISOLATION')
    )
  })

  it('createContextGateTransform annotates violations on devops frames cleanly in non-strict mode without leaking to consumer frames', async () => {
    const mismatchedReqCtx: ExecutionContext = {
      ...devopsCallerCtx,
      capability: { tenantId: 'acme', scopes: ['gpu.present'], epoch: 99, privateData: false },
      persona: 'devops',
    }

    const nonStrictGate = createContextGateTransform<string>(mismatchedReqCtx, devopsCallerCtx, { strict: false })
    const collector = createFrameCollector<string>()

    await createFrameSource(sampleFrames).pipeThrough(nonStrictGate).pipeTo(collector.writable)
    const out = await collector.done

    // devops caller receives consumer + devops frames (5 total), NOT kernel-audit
    assert.equal(out.length, 5)
    assert.ok(out.every((f) => f.minPersona !== 'kernel-audit'))

    const consumerFrames = out.filter((f) => f.minPersona === 'consumer')
    assert.equal(consumerFrames.length, 2)
    assert.ok(consumerFrames.every((f) => f.violations === undefined))

    const devopsFrames = out.filter((f) => f.minPersona === 'devops')
    assert.equal(devopsFrames.length, 3)
    for (const df of devopsFrames) {
      assert.ok(df.violations && df.violations.length === 1)
      assert.equal(df.violations[0]?.invariant, 'CAPABILITY_EPOCH')
    }
  })

  it('createPersonaTee returns devops === null for consumer callers without calling .tee() (structural zero-cost)', async () => {
    const source = createFrameSource(sampleFrames)
    let teeCalled = false
    const origTee = source.tee.bind(source)
    source.tee = () => {
      teeCalled = true
      return origTee()
    }

    const { consumer, devops } = createPersonaTee(source, consumerCallerCtx)
    assert.equal(devops, null)
    assert.equal(teeCalled, false)

    const collector = createFrameCollector<string>()
    await consumer.pipeTo(collector.writable)
    const out = await collector.done

    assert.deepEqual(
      out.map((f) => f.payload),
      ['frame-1', 'frame-2']
    )
  })

  it('createPersonaTee splits live .tee() branches for devops and kernel-audit callers', async () => {
    const source = createFrameSource(sampleFrames)
    let teeCalled = false
    const origTee = source.tee.bind(source)
    source.tee = () => {
      teeCalled = true
      return origTee()
    }

    const { consumer, devops } = createPersonaTee(source, devopsCallerCtx)
    assert.equal(teeCalled, true)
    assert.ok(devops !== null)

    const consumerCollector = createFrameCollector<string>()
    const devopsCollector = createFrameCollector<string>()

    await Promise.all([
      consumer.pipeTo(consumerCollector.writable),
      devops.pipeTo(devopsCollector.writable),
    ])

    const [consumerFrames, devopsFrames] = await Promise.all([
      consumerCollector.done,
      devopsCollector.done,
    ])

    assert.deepEqual(
      consumerFrames.map((f) => f.payload),
      ['frame-1', 'frame-2']
    )
    assert.deepEqual(
      devopsFrames.map((f) => f.payload),
      ['fps=120', 'pipeline-stall', 'reset-queue']
    )

    // kernel-audit caller also observes kernel-audit frames on devops branch
    const auditTee = createPersonaTee(createFrameSource(sampleFrames), kernelAuditCallerCtx)
    assert.ok(auditTee.devops !== null)
    const auditConsumerCol = createFrameCollector<string>()
    const auditDevopsCol = createFrameCollector<string>()
    await Promise.all([
      auditTee.consumer.pipeTo(auditConsumerCol.writable),
      auditTee.devops.pipeTo(auditDevopsCol.writable),
    ])
    const auditDevopsFrames = await auditDevopsCol.done
    assert.ok(auditDevopsFrames.some((f) => f.minPersona === 'kernel-audit' && f.payload === 'ring-watermark'))
  })

  it('composeIntersectionStreams flattens multi-stage .pipeThrough() pipelines AND algebraically composes 7-tuple contexts', async () => {
    const ingestCtx: ExecutionContext = {
      boundary: 'in-process',
      display: 'headless',
      lifetime: 'oneshot',
      transport: 'external-http',
      capability: { tenantId: 'acme', scopes: ['net.fetch'], epoch: 2, privateData: false },
      locality: 'cloud-region',
      persona: 'consumer',
    }

    const enrichCtx: ExecutionContext = {
      boundary: 'host-win32',
      display: 'interactive-fg',
      lifetime: 'singleton-service',
      transport: 'os-pipe',
      capability: { tenantId: 'acme', scopes: ['gpu.present'], epoch: 5, privateData: true },
      locality: 'local-arena',
      persona: 'devops',
    }

    const stage1Transform = new TransformStream<StreamFrame<number>, StreamFrame<number>>({
      transform(frame, controller) {
        controller.enqueue({ ...frame, payload: frame.payload * 2 })
      },
    })

    const stage2Transform = new TransformStream<StreamFrame<number>, StreamFrame<string>>({
      transform(frame, controller) {
        controller.enqueue({ ...frame, payload: `v=${frame.payload + 1}` })
      },
    })

    const stage1: ComposedIntersectionStream<StreamFrame<number>, StreamFrame<number>> = {
      id: 'stage/ingest',
      context: ingestCtx,
      readable: stage1Transform.readable,
      writable: stage1Transform.writable,
    }

    const stage2: ComposedIntersectionStream<StreamFrame<number>, StreamFrame<string>> = {
      id: 'stage/enrich',
      context: enrichCtx,
      readable: stage2Transform.readable,
      writable: stage2Transform.writable,
    }

    const composed = composeIntersectionStreams('pipeline/desktop-telemetry', [stage1, stage2])

    // Verify 7-tuple algebraic composition
    assert.equal(composed.id, 'pipeline/desktop-telemetry')
    assert.equal(composed.context.boundary, 'host-win32')
    assert.equal(composed.context.display, 'interactive-fg')
    assert.equal(composed.context.lifetime, 'singleton-service')
    assert.equal(composed.context.transport, 'os-pipe')
    assert.equal(composed.context.locality, 'local-arena')
    assert.equal(composed.context.persona, 'devops')
    assert.equal(composed.context.capability.epoch, 5)
    assert.equal(composed.context.capability.privateData, true)
    assert.deepEqual(composed.context.capability.scopes, ['gpu.present', 'net.fetch'])

    // Verify live flattened Web Streams pipeline execution
    const inputFrames: StreamFrame<number>[] = [
      { kind: 'data', source: 'sensor', minPersona: 'consumer', payload: 10, ts: 1 },
      { kind: 'metric', source: 'sensor', minPersona: 'devops', payload: 20, ts: 2 },
    ]
    const collector = createFrameCollector<string>()

    await createFrameSource(inputFrames).pipeThrough(composed).pipeTo(collector.writable)
    const out = await collector.done

    assert.deepEqual(
      out.map((f) => f.payload),
      ['v=21', 'v=41']
    )

    // Conflicting stage boundaries fail fast via intersectContexts
    const conflictStage: ComposedIntersectionStream<StreamFrame<number>, StreamFrame<number>> = {
      id: 'stage/wasi',
      context: { ...enrichCtx, boundary: 'wasi' },
      readable: new TransformStream<StreamFrame<number>, StreamFrame<number>>().readable,
      writable: new TransformStream<StreamFrame<number>, StreamFrame<number>>().writable,
    }
    assert.throws(
      () => composeIntersectionStreams('pipeline/conflict', [stage2, conflictStage]),
      ContextConflictError
    )
  })
})
