/**
 * @file packages/@awesome-os/stealify-schema/src/algebra.test.mts
 * @description Unit tests for the Stealify Composition Algebra (`wedge`, `meet`, `project`, `evolve`)
 * and the zero-AST `alg` surface language.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineIntersection, defineSection, f, intersect, s, slot } from './schema-definition.mts'
import {
  alg,
  checkAdmissibility,
  ContextConflictError,
  createCapability,
  createEpochRoot,
  displayRank,
  evolve,
  hostChart,
  internalChart,
  intersectContexts,
  isDevOpsAttached,
  localityRank,
  meet,
  personaRank,
  project,
  rollback,
  shouldEmitForPersona,
  wedge,
  WedgeCollapseError,
  type ExecutionContext,
} from './algebra.mts'

describe('Stealify Composition Algebra (wedge, meet, project, evolve)', () => {
  it('wedge (^) composes orthogonal Sections and throws WedgeCollapseError on colliding fields', () => {
    const A = defineSection({
      id: 'test/a',
      version: '1.0.0',
      substrate: s.sabRing({ ringBytes: 1024 }),
      fields: { x: f.int32().default(1), y: f.int32().default(2) },
    })
    const B = defineSection({
      id: 'test/b',
      version: '1.0.0',
      substrate: s.sabRing({ ringBytes: 1024 }),
      fields: { z: f.float64().default(3) },
    })
    const BadOverlap = defineSection({
      id: 'test/overlap',
      version: '1.0.0',
      substrate: s.sabRing({ ringBytes: 1024 }),
      fields: { x: f.int32().default(99) },
    })

    const composed = wedge('test/ab', A, B)
    assert.equal(composed.id, 'test/ab')
    assert.equal(composed.sections.length, 2)

    assert.throws(
      () => (wedge as any)('test/bad', A, BadOverlap),
      (err: unknown) =>
        err instanceof WedgeCollapseError && err.collidingFields.includes('x')
    )
  })

  it('meet (&) strictly narrows capabilities and never escalates authority', () => {
    const admin = createCapability(['gpu.present', 'fs.read', 'fs.write'], 2)
    const sandbox = createCapability(['gpu.present', 'fs.read'], 5)
    const narrowed = meet(admin, sandbox)
    assert.deepEqual(narrowed.scopes, ['fs.read', 'gpu.present'])
    assert.equal(narrowed.epoch, 5)
  })

  it('project (|>) distinguishes full-speed internal charts from damped legacy host charts', () => {
    const fast = project(42, internalChart('sab', (n) => n * 2))
    assert.equal(fast.boundary, 'internal')
    assert.equal(fast.debugProfile, 'off')
    assert.equal(fast.value, 84)

    const paced = project(
      42,
      hostChart('wgpu', { debugProfile: 'diagnostic' }, (n) => `quads:${n}`)
    )
    assert.equal(paced.boundary, 'legacy-host')
    assert.equal(paced.debugProfile, 'diagnostic')
    assert.equal(paced.autoExitMs, 8000)
    assert.equal(paced.value, 'quads:42')
  })

  it('evolve (∇) advances monotonic CoW epochs with O(1) rollback', () => {
    const s1 = createEpochRoot({ wmMode: 'infinite-canvas', zoom: 1 })
    const s2 = evolve(s1, () => ({ wmMode: 'tile-bsp' }))
    const s3 = evolve(s2, (cur) => ({ zoom: cur.zoom + 0.5 }))

    assert.equal(s3.epoch, 3)
    assert.equal(s3.state.wmMode, 'tile-bsp')
    assert.equal(s3.state.zoom, 1.5)

    const back = rollback(s3)
    assert.equal(back.epoch, 2)
    assert.equal(back.state.zoom, 1)
  })

  it('alg`...` surface language compiles blades, orthogonal manifolds & host charts and rejects wedge collisions', () => {
    const program = alg`
      // Geometric OS spec
      blade WindowLayout @sab-ring { wmMode: string(32), activeId: int32 }
      blade Telemetry    @sab-ring { fps: float64, frameMs: float64 }
      manifold Desktop = WindowLayout ^ Telemetry
      chart NativeGpu  = Desktop |> host(diagnostic, 8000ms) -> wgpu
    `

    assert.equal(program.blades.size, 2)
    assert.equal(program.manifolds.size, 1)
    assert.equal(program.charts.length, 1)
    assert.equal(program.charts[0]!.debugProfile, 'diagnostic')
    assert.equal(program.charts[0]!.autoExitMs, 8000)
    assert.equal(program.charts[0]!.target, 'wgpu')

    // Rejects A ^ A (non-orthogonal self-wedge collapse!)
    assert.throws(
      () => alg`
        blade DupA @sab-ring { status: string(16) }
        blade DupB @sab-ring { status: string(16) }
        manifold Broken = DupA ^ DupB
      `,
      WedgeCollapseError
    )
  })
})

describe('StealifyLang 7-Tuple Execution Context Algebra', () => {
  const cloudHeadlessCtx: ExecutionContext = {
    boundary: 'in-process',
    display: 'headless',
    lifetime: 'oneshot',
    transport: 'external-http',
    capability: { tenantId: 'acme', scopes: ['net.fetch', 'telemetry.read'], epoch: 2, privateData: false },
    locality: 'cloud-region',
  }

  const localInteractiveCtx: ExecutionContext = {
    boundary: 'host-win32',
    display: 'interactive-fg',
    lifetime: 'singleton-service',
    transport: 'os-pipe',
    capability: { tenantId: 'acme', scopes: ['gpu.present', 'telemetry.read'], epoch: 5, privateData: true },
    locality: 'local-arena',
  }

  it('intersectContexts narrows locality, elevates display, merges scopes, propagates privateData, and prefers local IPC', () => {
    const composed = intersectContexts('desktop-intersection', [cloudHeadlessCtx, localInteractiveCtx])

    assert.equal(composed.boundary, 'host-win32')
    assert.equal(composed.display, 'interactive-fg')
    assert.equal(composed.locality, 'local-arena')
    assert.equal(composed.lifetime, 'singleton-service')
    assert.equal(composed.transport, 'os-pipe')
    assert.deepEqual(composed.capability.scopes, ['gpu.present', 'net.fetch', 'telemetry.read'])
    assert.equal(composed.capability.epoch, 5)
    assert.equal(composed.capability.privateData, true)
    assert.equal(displayRank(composed.display), 2)
    assert.equal(localityRank(composed.locality), 0)

    // Preserves external-http only when ALL contexts are external-http
    const httpOnly = intersectContexts('http-only', [
      cloudHeadlessCtx,
      { ...cloudHeadlessCtx, capability: { tenantId: 'acme', scopes: ['api.call'], epoch: 3 } },
    ])
    assert.equal(httpOnly.boundary, 'in-process')
    assert.equal(httpOnly.transport, 'external-http')
    assert.equal(httpOnly.locality, 'cloud-region')
  })

  it('intersectContexts throws ContextConflictError on incompatible concrete boundaries', () => {
    const microvmCtx: ExecutionContext = {
      ...localInteractiveCtx,
      boundary: 'microvm',
    }
    assert.throws(
      () => intersectContexts('bad-boundary', [localInteractiveCtx, microvmCtx]),
      (err: unknown) => err instanceof ContextConflictError && err.message.includes('host-win32') && err.message.includes('microvm')
    )
  })

  it('intersectContexts throws ContextConflictError on private-data cloud egress', () => {
    const privateCloudCtx: ExecutionContext = {
      ...cloudHeadlessCtx,
      capability: { tenantId: 'acme', scopes: ['pii.read'], epoch: 1, privateData: true },
      locality: 'cloud-region',
    }
    assert.throws(
      () => intersectContexts('pii-cloud-leak', [cloudHeadlessCtx, privateCloudCtx]),
      (err: unknown) => err instanceof ContextConflictError && err.message.includes('cloud-region')
    )
  })

  it('defineSection({ context }) + intersect(...) automatically composes context and enforces checkAdmissibility', () => {
    const TelemetrySec = defineSection({
      id: 'ctx/telemetry',
      version: '1.0.0',
      substrate: s.sabRing({ ringBytes: 1024 }),
      context: cloudHeadlessCtx,
      fields: { fps: f.float64().default(60) },
    })

    const WindowSec = defineSection({
      id: 'ctx/window',
      version: '1.0.0',
      substrate: s.sabRing({ ringBytes: 1024 }),
      context: localInteractiveCtx,
      fields: { activeId: f.int32().default(1) },
    })

    const UnconstrainedSec = defineSection({
      id: 'ctx/plain',
      version: '1.0.0',
      fields: { label: f.string().default('ok') },
    })

    // Unconstrained section is always admissible
    const plainRes = UnconstrainedSec.checkAdmissibility(cloudHeadlessCtx)
    assert.equal(plainRes.admissible, true)
    assert.equal(plainRes.pipeAction, 'none')
    assert.deepEqual(plainRes.violations, [])

    // Intersecting sections (including via slot) automatically composes their ExecutionContexts
    const Desktop = intersect('ctx/desktop', [TelemetrySec, slot('win', WindowSec)])
    assert.ok(Desktop.context)
    assert.equal(Desktop.context.boundary, 'host-win32')
    assert.equal(Desktop.context.display, 'interactive-fg')
    assert.equal(Desktop.context.locality, 'local-arena')
    assert.equal(Desktop.context.capability.privateData, true)
    assert.deepEqual(Desktop.context.capability.scopes, ['gpu.present', 'net.fetch', 'telemetry.read'])

    // Headless caller with missing scopes & wrong epoch is rejected
    const denied = Desktop.checkAdmissibility(cloudHeadlessCtx)
    assert.equal(denied.admissible, false)
    const invariants = denied.violations.map((v) => v.invariant)
    assert.ok(invariants.includes('VISUAL_REACHABILITY'))
    assert.ok(invariants.includes('CAPABILITY_INCLUSION'))
    assert.ok(invariants.includes('CAPABILITY_EPOCH'))

    // Matching interactive foreground caller with wildcard scope & matching epoch is admitted
    const privilegedCaller: ExecutionContext = {
      boundary: 'host-win32',
      display: 'interactive-fg',
      lifetime: 'oneshot',
      transport: 'os-pipe',
      capability: { tenantId: 'acme', scopes: ['*'], epoch: 5, privateData: true },
      locality: 'local-arena',
    }
    const allowedBind = Desktop.checkAdmissibility(privilegedCaller, { activePipeOwners: 0 })
    assert.equal(allowedBind.admissible, true)
    assert.equal(allowedBind.pipeAction, 'bind')

    const allowedAttach = Desktop.checkAdmissibility(privilegedCaller, { activePipeOwners: 1 })
    assert.equal(allowedAttach.admissible, true)
    assert.equal(allowedAttach.pipeAction, 'attach')

    const pipeConflict = Desktop.checkAdmissibility(privilegedCaller, { activePipeOwners: 2 })
    assert.equal(pipeConflict.admissible, false)
    assert.equal(pipeConflict.violations[0]?.invariant, 'SINGLETON_PIPE_OWNERSHIP')

    // defineIntersection with spec.context override also composes and detects conflicts
    assert.throws(
      () =>
        defineIntersection({
          id: 'ctx/conflict',
          version: '1.0.0',
          sections: [WindowSec],
          context: { ...localInteractiveCtx, boundary: 'wasi' },
        }),
      ContextConflictError
    )

    // Direct checkAdmissibility enforces LOCAL_IPC_PURITY
    const httpSameBoundary = checkAdmissibility(
      { ...cloudHeadlessCtx, boundary: 'host-win32', capability: { tenantId: 'acme', scopes: [], epoch: 5 } },
      privilegedCaller
    )
    assert.equal(httpSameBoundary.admissible, false)
    assert.ok(httpSameBoundary.violations.some((v) => v.invariant === 'LOCAL_IPC_PURITY'))
  })

  it('7-Tuple Persona / Observability Plane (Omega): personaRank, shouldEmitForPersona, isDevOpsAttached, PERSONA_ISOLATION, and intersectContexts elevation', () => {
    assert.equal(personaRank(), 0)
    assert.equal(personaRank('consumer'), 0)
    assert.equal(personaRank('creator'), 1)
    assert.equal(personaRank('devops'), 2)
    assert.equal(personaRank('kernel-audit'), 3)

    assert.equal(shouldEmitForPersona('devops', 'consumer'), false)
    assert.equal(shouldEmitForPersona('devops'), false)
    assert.equal(shouldEmitForPersona('devops', 'devops'), true)
    assert.equal(shouldEmitForPersona('devops', 'kernel-audit'), true)
    assert.equal(shouldEmitForPersona('consumer', 'consumer'), true)

    const consumerCtx: ExecutionContext = { ...localInteractiveCtx, persona: 'consumer' }
    const devopsCtx: ExecutionContext = { ...localInteractiveCtx, persona: 'devops' }
    const kernelAuditCtx: ExecutionContext = { ...localInteractiveCtx, persona: 'kernel-audit' }

    assert.equal(isDevOpsAttached(localInteractiveCtx), false)
    assert.equal(isDevOpsAttached(consumerCtx), false)
    assert.equal(isDevOpsAttached(devopsCtx), true)
    assert.equal(isDevOpsAttached(kernelAuditCtx), true)

    // Invariant 6: PERSONA_ISOLATION blocks consumer caller from invoking devops op
    const blocked = checkAdmissibility(devopsCtx, consumerCtx)
    assert.equal(blocked.admissible, false)
    assert.equal(blocked.violations.length, 1)
    assert.equal(blocked.violations[0]?.invariant, 'PERSONA_ISOLATION')

    // Implicit default persona ('consumer') is also blocked from devops op
    const blockedDefault = checkAdmissibility(devopsCtx, localInteractiveCtx)
    assert.equal(blockedDefault.admissible, false)
    assert.ok(blockedDefault.violations.some((v) => v.invariant === 'PERSONA_ISOLATION'))

    // Matching or higher persona is admitted
    const admittedDevops = checkAdmissibility(devopsCtx, devopsCtx)
    assert.equal(admittedDevops.admissible, true)
    const admittedAudit = checkAdmissibility(devopsCtx, kernelAuditCtx)
    assert.equal(admittedAudit.admissible, true)

    // intersectContexts elevates consumer ∩ devops -> devops
    const elevated = intersectContexts('persona-elevate', [consumerCtx, devopsCtx])
    assert.equal(elevated.persona, 'devops')
    assert.equal(isDevOpsAttached(elevated), true)

    const elevatedReverse = intersectContexts('persona-elevate-rev', [devopsCtx, consumerCtx])
    assert.equal(elevatedReverse.persona, 'devops')
  })
})
