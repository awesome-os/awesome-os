/**
 * @file packages/@awesome-os/stealify-schema/src/algebra.mts
 * @description Stealify Composition Algebra (`wedge`, `meet`, `project`, `evolve`)
 * + Minimal Zero-AST Geometric Surface Syntax (`alg` tagged template / `parseAlgebraSpec`).
 *
 * Unifies Awesome-OS memory slices, capabilities, host boundaries, and CoW epochs
 * under 4 first-principles algebraic operators:
 *   1. `wedge(id, A, B)` (^)  — Exterior product of orthogonal Sections (collisions collapse to error/never).
 *   2. `meet(c1, c2)`    (&)  — Meet-semilattice capability narrowing (monotonic, never escalates).
 *   3. `project(M, C)`   (|>) — Manifold chart projection (legacy host charts structurally carry a pacing policy).
 *   4. `evolve(S, fn)`   (∇)  — Monotonic CoW epoch delta with O(1) snapshot rollback.
 *
 * Strictly `erasableSyntaxOnly: true` and zero `node:*` imports.
 */

import {
  defineSection,
  f,
  intersect,
  s,
  type FieldDef,
  type IntersectionDefinition,
  type SectionDefinition,
} from './schema-definition.mts'

// ============================================================================
// 1. Exterior Product: `wedge` (^) — Orthogonal Section Composition
// ============================================================================

export type CollidingKeys<A, B> = Extract<keyof A, keyof B>

export type AssertOrthogonalFields<A, B> =
  CollidingKeys<A, B> extends never
    ? unknown
    : {
        readonly __wedgeCollapse: 'Geometric Wedge Collapse: Sections share colliding field(s)'
        readonly __collidingFields: CollidingKeys<A, B>
      }

export class WedgeCollapseError extends Error {
  readonly collidingFields: readonly string[]
  constructor(id: string, collidingFields: readonly string[]) {
    super(
      `Geometric Wedge Collapse in '${id}': non-orthogonal Sections share colliding field(s): [${collidingFields.join(', ')}]`
    )
    this.name = 'WedgeCollapseError'
    this.collidingFields = collidingFields
  }
}

/**
 * Exterior wedge product (`A ^ B`): composes two Sections into an Intersection
 * if and only if their field subspaces are strictly orthogonal (`keyof A & keyof B = ∅`).
 * Collisions are rejected BOTH at compile time (type level) AND at runtime (`WedgeCollapseError`).
 */
export function wedge<
  TFieldsA extends Record<string, FieldDef<any>>,
  TFieldsB extends Record<string, FieldDef<any>>,
>(
  id: string,
  a: SectionDefinition<TFieldsA, any, any>,
  b: SectionDefinition<TFieldsB, any, any>,
  ..._proof: CollidingKeys<TFieldsA, TFieldsB> extends never
    ? []
    : [AssertOrthogonalFields<TFieldsA, TFieldsB>]
): IntersectionDefinition<readonly [typeof a, typeof b]> {
  const keysA = new Set(Object.keys(a.fields))
  const collisions: string[] = []
  for (const k of Object.keys(b.fields)) {
    if (keysA.has(k)) collisions.push(k)
  }
  if (collisions.length > 0) {
    throw new WedgeCollapseError(id, collisions)
  }
  return intersect(id, [a, b] as const)
}

// ============================================================================
// 2. Meet-Semilattice: `meet` (&) — Monotonic Capability Narrowing
// ============================================================================

export interface AlgebraicCapability<TScope extends string = string> {
  readonly __brand: 'B8gAlgebraicCapability'
  readonly scopes: readonly TScope[]
  readonly epoch: number
}

export function createCapability<TScope extends string>(
  scopes: readonly TScope[],
  epoch: number = 1
): AlgebraicCapability<TScope> {
  const unique = Array.from(new Set(scopes)).sort() as TScope[]
  return Object.freeze({
    __brand: 'B8gAlgebraicCapability',
    scopes: Object.freeze(unique),
    epoch: Math.max(1, Math.trunc(epoch)),
  })
}

/**
 * Capability Meet (`c1 & c2`): returns the greatest lower bound (intersection of scopes,
 * max epoch). Authority can ONLY shrink — never escalate.
 */
export function meet<TA extends string, TB extends string>(
  a: AlgebraicCapability<TA>,
  b: AlgebraicCapability<TB>
): AlgebraicCapability<Extract<TA, TB>> {
  const setB = new Set<string>(b.scopes)
  const narrowed = a.scopes.filter((scope): scope is Extract<TA, TB> => setB.has(scope))
  return createCapability(narrowed, Math.max(a.epoch, b.epoch))
}

// ============================================================================
// 3. Manifold Chart Projection: `project` (|>) — Internal vs. Legacy Host Boundary
// ============================================================================

export type ProjectionTargetKind = 'wgpu' | 'vt100' | 'http' | 'uefi' | 'sab'
export type ChartDebugProfile = 'off' | 'gentle' | 'diagnostic' | 'paranoid'

export interface InternalChart<TIn, TOut> {
  readonly kind: 'internal'
  readonly target: ProjectionTargetKind
  readonly map: (input: TIn) => TOut
}

export interface LegacyHostChart<TIn, TOut> {
  readonly kind: 'legacy-host'
  readonly target: ProjectionTargetKind
  readonly debugProfile: ChartDebugProfile
  readonly autoExitMs: number
  readonly map: (input: TIn) => TOut
}

export type ManifoldChart<TIn, TOut> = InternalChart<TIn, TOut> | LegacyHostChart<TIn, TOut>

export interface ProjectionReceipt<TOut> {
  readonly target: ProjectionTargetKind
  readonly boundary: 'internal' | 'legacy-host'
  readonly debugProfile: ChartDebugProfile
  readonly autoExitMs: number
  readonly value: TOut
}

export function internalChart<TIn, TOut>(
  target: ProjectionTargetKind,
  map: (input: TIn) => TOut
): InternalChart<TIn, TOut> {
  return { kind: 'internal', target, map }
}

export function hostChart<TIn, TOut>(
  target: ProjectionTargetKind,
  opts: { readonly debugProfile: ChartDebugProfile; readonly autoExitMs?: number },
  map: (input: TIn) => TOut
): LegacyHostChart<TIn, TOut> {
  return {
    kind: 'legacy-host',
    target,
    debugProfile: opts.debugProfile,
    autoExitMs: opts.autoExitMs ?? (opts.debugProfile === 'diagnostic' || opts.debugProfile === 'paranoid' ? 8000 : 0),
    map,
  }
}

/**
 * Projects an internal manifold value onto either an internal chart (full speed)
 * or a legacy host chart (explicitly stamped with its `HostDebugProfile` & `autoExitMs`).
 */
export function project<TIn, TOut>(
  manifoldValue: TIn,
  chart: ManifoldChart<TIn, TOut>
): ProjectionReceipt<TOut> {
  return {
    target: chart.target,
    boundary: chart.kind,
    debugProfile: chart.kind === 'legacy-host' ? chart.debugProfile : 'off',
    autoExitMs: chart.kind === 'legacy-host' ? chart.autoExitMs : 0,
    value: chart.map(manifoldValue),
  }
}

// ============================================================================
// 4. Monotonic CoW Epoch Delta: `evolve` (∇) — O(1) Rollback
// ============================================================================

export interface EpochSnapshot<T> {
  readonly epoch: number
  readonly state: Readonly<T>
  readonly parent: EpochSnapshot<T> | null
}

export function createEpochRoot<T extends object>(initial: T): EpochSnapshot<T> {
  return Object.freeze({
    epoch: 1,
    state: Object.freeze({ ...initial }),
    parent: null,
  })
}

export function evolve<T extends object>(
  current: EpochSnapshot<T>,
  delta: (state: Readonly<T>) => Partial<T>
): EpochSnapshot<T> {
  const patch = delta(current.state)
  return Object.freeze({
    epoch: current.epoch + 1,
    state: Object.freeze({ ...current.state, ...patch }),
    parent: current,
  })
}

export function rollback<T extends object>(current: EpochSnapshot<T>): EpochSnapshot<T> {
  return current.parent ?? current
}

// ============================================================================
// 5. Minimal Zero-AST Algebraic Surface Language (`alg` tagged template)
// ============================================================================

export interface ParsedBladeDecl {
  readonly name: string
  readonly substrate: 'sab-ring' | 'sqlite' | 'disk' | 'uvs-cas'
  readonly fields: Record<string, { readonly type: 'int32' | 'float64' | 'boolean' | 'string'; readonly maxBytes?: number }>
}

export interface ParsedManifoldDecl {
  readonly name: string
  readonly blades: readonly string[]
}

export interface ParsedChartDecl {
  readonly name: string
  readonly manifold: string
  readonly debugProfile: ChartDebugProfile
  readonly autoExitMs: number
  readonly target: ProjectionTargetKind
}

export interface CompiledAlgebraProgram {
  readonly blades: ReadonlyMap<string, SectionDefinition<any, any, any>>
  readonly manifolds: ReadonlyMap<string, IntersectionDefinition<any>>
  readonly charts: readonly ParsedChartDecl[]
}

/**
 * Zero-AST parser & compiler for the Stealify Geometric Surface Language:
 *
 *   blade WindowLayout @sab-ring { wmMode: string(32), activeId: int32 }
 *   blade Telemetry    @sab-ring { fps: float64, frameMs: float64 }
 *   manifold Desktop = WindowLayout ^ Telemetry
 *   chart NativeGpu  = Desktop |> host(diagnostic, 8000ms) -> wgpu
 */
export function compileAlgebra(source: string): CompiledAlgebraProgram {
  const bladeDecls = new Map<string, ParsedBladeDecl>()
  const manifoldDecls: ParsedManifoldDecl[] = []
  const charts: ParsedChartDecl[] = []

  const lines = source
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l.length > 0)

  for (const line of lines) {
    const bladeMatch = line.match(
      /^blade\s+([A-Za-z_][A-Za-z0-9_]*)\s+@(sab-ring|sqlite|disk|uvs-cas)\s*\{([^}]*)\}$/
    )
    if (bladeMatch) {
      const name = bladeMatch[1]!
      const substrate = bladeMatch[2]! as ParsedBladeDecl['substrate']
      const rawFields = bladeMatch[3]!.trim()
      const fields: ParsedBladeDecl['fields'] = {}
      if (rawFields.length > 0) {
        for (const item of rawFields.split(',')) {
          const fm = item.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(int32|float64|boolean|string)(?:\((\d+)\))?$/)
          if (!fm) {
            throw new Error(`Invalid blade field syntax in '${name}': '${item.trim()}'`)
          }
          const fName = fm[1]!
          const fType = fm[2]! as 'int32' | 'float64' | 'boolean' | 'string'
          const maxBytes = fm[3] ? Number(fm[3]) : undefined
          fields[fName] = maxBytes !== undefined ? { type: fType, maxBytes } : { type: fType }
        }
      }
      bladeDecls.set(name, { name, substrate, fields })
      continue
    }

    const manifoldMatch = line.match(/^manifold\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/)
    if (manifoldMatch) {
      const name = manifoldMatch[1]!
      const blades = manifoldMatch[2]!
        .split('^')
        .map((b) => b.trim())
        .filter((b) => b.length > 0)
      if (blades.length < 2) {
        throw new Error(`Manifold '${name}' must wedge at least 2 blades with '^'.`)
      }
      manifoldDecls.push({ name, blades })
      continue
    }

    const chartMatch = line.match(
      /^chart\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|>\s*host\((off|gentle|diagnostic|paranoid)(?:\s*,\s*(\d+)ms)?\)\s*->\s*(wgpu|vt100|http|uefi|sab)$/
    )
    if (chartMatch) {
      const debugProfile = chartMatch[3]! as ChartDebugProfile
      const autoExitMs = chartMatch[4]
        ? Number(chartMatch[4])
        : debugProfile === 'diagnostic' || debugProfile === 'paranoid'
          ? 8000
          : 0
      charts.push({
        name: chartMatch[1]!,
        manifold: chartMatch[2]!,
        debugProfile,
        autoExitMs,
        target: chartMatch[5]! as ProjectionTargetKind,
      })
      continue
    }

    throw new Error(`Unrecognized Stealify Algebra statement: '${line}'`)
  }

  // Materialize live B8G-SECT-1 Sections
  const blades = new Map<string, SectionDefinition<any, any, any>>()
  for (const decl of bladeDecls.values()) {
    const fieldDefs: Record<string, FieldDef<any>> = {}
    for (const [k, spec] of Object.entries(decl.fields)) {
      if (spec.type === 'int32') fieldDefs[k] = f.int32().default(0)
      else if (spec.type === 'float64') fieldDefs[k] = f.float64().default(0)
      else if (spec.type === 'boolean') fieldDefs[k] = f.boolean().default(false)
      else fieldDefs[k] = f.string({ maxBytes: spec.maxBytes ?? 64 }).default('')
    }
    const sub =
      decl.substrate === 'sqlite'
        ? s.sqlite({ table: decl.name.toLowerCase() })
        : decl.substrate === 'disk'
          ? s.disk({ root: decl.name.toLowerCase() })
          : decl.substrate === 'uvs-cas'
            ? s.uvsCas({ prefix: decl.name.toLowerCase() })
            : s.sabRing({ ringBytes: 16384 })

    blades.set(
      decl.name,
      defineSection({
        id: `alg/${decl.name.toLowerCase()}`,
        version: '1.0.0',
        substrate: sub,
        fields: fieldDefs,
      })
    )
  }

  // Materialize Manifolds with strict geometric wedge orthogonality check!
  const manifolds = new Map<string, IntersectionDefinition<any>>()
  for (const m of manifoldDecls) {
    const seenFields = new Set<string>()
    const resolved: SectionDefinition<any, any, any>[] = []
    for (const bName of m.blades) {
      const sec = blades.get(bName)
      if (!sec) throw new Error(`Manifold '${m.name}' references unknown blade '${bName}'.`)
      for (const fieldName of Object.keys(sec.fields)) {
        if (seenFields.has(fieldName)) {
          throw new WedgeCollapseError(m.name, [fieldName])
        }
        seenFields.add(fieldName)
      }
      resolved.push(sec)
    }
    manifolds.set(m.name, intersect(`alg/${m.name.toLowerCase()}`, resolved))
  }

  // Validate chart references
  for (const c of charts) {
    if (!manifolds.has(c.manifold) && !blades.has(c.manifold)) {
      throw new Error(`Chart '${c.name}' references unknown manifold/blade '${c.manifold}'.`)
    }
  }

  return { blades, manifolds, charts }
}

/**
 * Tagged template entrypoint for inline Stealify Composition Algebra.
 */
export function alg(strings: TemplateStringsArray, ...values: unknown[]): CompiledAlgebraProgram {
  let src = ''
  for (let i = 0; i < strings.length; i += 1) {
    src += strings[i]!
    if (i < values.length) src += String(values[i])
  }
  return compileAlgebra(src)
}

// ============================================================================
// 6. StealifyLang 7-Tuple Execution Context Algebra: C_cloud = (B, D, L, T, κ, Λ, Ω)
// ============================================================================

export type ExecutionBoundary =
  | 'bare-metal'
  | 'host-win32'
  | 'host-posix'
  | 'in-process'
  | 'microvm'
  | 'wasi'

export type DisplayContext = 'headless' | 'background-job' | 'interactive-fg'

export type LifetimePolicy = 'oneshot' | 'window-bound' | 'singleton-service'

export type IpcTransport = 'arena-sab' | 'os-pipe' | 'cdp-pipe' | 'external-http'

export type LocalityZone = 'local-arena' | 'lan-peer' | 'sovereign-edge' | 'cloud-region'

export type PersonaPlane = 'consumer' | 'creator' | 'devops' | 'kernel-audit'

export interface CapabilityContext {
  readonly tenantId: string
  readonly scopes: readonly string[]
  readonly epoch: number
  readonly privateData?: boolean
}

export interface ExecutionContext {
  readonly boundary: ExecutionBoundary
  readonly display: DisplayContext
  readonly lifetime: LifetimePolicy
  readonly transport: IpcTransport
  readonly capability: CapabilityContext
  readonly locality: LocalityZone
  readonly persona?: PersonaPlane
}

export interface AdmissibilityViolation {
  readonly invariant:
    | 'VISUAL_REACHABILITY'
    | 'LOCAL_IPC_PURITY'
    | 'CAPABILITY_INCLUSION'
    | 'CAPABILITY_EPOCH'
    | 'DATA_SOVEREIGNTY'
    | 'SINGLETON_PIPE_OWNERSHIP'
    | 'PERSONA_ISOLATION'
  readonly message: string
}

export interface AdmissibilityResult {
  readonly admissible: boolean
  readonly pipeAction: 'bind' | 'attach' | 'none'
  readonly violations: readonly AdmissibilityViolation[]
}

const DISPLAY_RANK: Readonly<Record<DisplayContext, number>> = {
  headless: 0,
  'background-job': 1,
  'interactive-fg': 2,
}

const LOCALITY_RANK: Readonly<Record<LocalityZone, number>> = {
  'local-arena': 0,
  'lan-peer': 1,
  'sovereign-edge': 2,
  'cloud-region': 3,
}

const LIFETIME_RANK: Readonly<Record<LifetimePolicy, number>> = {
  oneshot: 0,
  'window-bound': 1,
  'singleton-service': 2,
}

const TRANSPORT_LOCALITY_RANK: Readonly<Record<IpcTransport, number>> = {
  'arena-sab': 0,
  'os-pipe': 1,
  'cdp-pipe': 2,
  'external-http': 3,
}

const PERSONA_RANK: Readonly<Record<PersonaPlane, number>> = {
  consumer: 0,
  creator: 1,
  devops: 2,
  'kernel-audit': 3,
}

export function displayRank(d: DisplayContext): number {
  return DISPLAY_RANK[d]
}

export function localityRank(l: LocalityZone): number {
  return LOCALITY_RANK[l]
}

export function personaRank(p: PersonaPlane = 'consumer'): number {
  return PERSONA_RANK[p]
}

export function shouldEmitForPersona(
  eventMinPersona: PersonaPlane,
  callerPersona: PersonaPlane = 'consumer'
): boolean {
  return personaRank(eventMinPersona) <= personaRank(callerPersona)
}

export function isDevOpsAttached(ctx: ExecutionContext): boolean {
  return personaRank(ctx.persona ?? 'consumer') >= personaRank('devops')
}

export class ContextConflictError extends Error {
  readonly contextId: string
  readonly reason: string
  constructor(contextId: string, reason: string) {
    super(`ExecutionContext conflict in '${contextId}': ${reason}`)
    this.name = 'ContextConflictError'
    this.contextId = contextId
    this.reason = reason
  }
}

/**
 * Evaluates the Total Admissibility Gate for an operation requiring `req`
 * when invoked from `caller`.
 */
export function checkAdmissibility(
  req: ExecutionContext,
  caller: ExecutionContext,
  opts?: {
    readonly isExternalWeb?: boolean
    readonly activePipeOwners?: number
  }
): AdmissibilityResult {
  const violations: AdmissibilityViolation[] = []

  // 1. Visual Reachability: D_req <= D_caller
  if (displayRank(req.display) > displayRank(caller.display)) {
    violations.push({
      invariant: 'VISUAL_REACHABILITY',
      message: `Operation requires display="${req.display}", but caller only has "${caller.display}" (foreground visibility not guaranteed).`,
    })
  }

  // 2. Local IPC Purity (B8G016): same-boundary local IPC must not use external-http
  const sameBoundary = req.boundary === caller.boundary
  if (sameBoundary && !opts?.isExternalWeb && req.transport === 'external-http') {
    violations.push({
      invariant: 'LOCAL_IPC_PURITY',
      message: 'Local same-boundary IPC must use arena-sab, os-pipe, or cdp-pipe (not external-http).',
    })
  }

  // 3. Capability Inclusion & Epoch Fence
  const callerScopes = new Set(caller.capability.scopes)
  if (!callerScopes.has('*')) {
    for (const s of req.capability.scopes) {
      if (!callerScopes.has(s)) {
        violations.push({
          invariant: 'CAPABILITY_INCLUSION',
          message: `Caller tenant "${caller.capability.tenantId}" lacks required scope "${s}".`,
        })
      }
    }
  }
  if (req.capability.epoch !== caller.capability.epoch) {
    violations.push({
      invariant: 'CAPABILITY_EPOCH',
      message: `Capability epoch mismatch: req=${req.capability.epoch}, caller=${caller.capability.epoch}.`,
    })
  }

  // 4. CISO Data-Locality Sovereignty: privateData => Lambda <= lan-peer
  const isPrivate = req.capability.privateData === true || caller.capability.privateData === true
  if (isPrivate && localityRank(req.locality) > localityRank('lan-peer')) {
    violations.push({
      invariant: 'DATA_SOVEREIGNTY',
      message: `Private capability data cannot leave LAN boundary (requested locality="${req.locality}" > "lan-peer").`,
    })
  }

  // 5. Singleton Pipe Ownership: |Owners(p)| <= 1
  const owners = opts?.activePipeOwners ?? 0
  let pipeAction: 'bind' | 'attach' | 'none' = 'none'
  if (req.transport === 'os-pipe') {
    if (owners === 0) pipeAction = 'bind'
    else if (owners === 1) pipeAction = 'attach'
    else {
      violations.push({
        invariant: 'SINGLETON_PIPE_OWNERSHIP',
        message: `Pipe invariant violated: ${owners} concurrent owners detected (must be <= 1).`,
      })
    }
  }

  // 6. Persona / Observability Plane Isolation: Omega_req <= Omega_caller
  const reqPersona: PersonaPlane = req.persona ?? 'consumer'
  const callerPersona: PersonaPlane = caller.persona ?? 'consumer'
  if (personaRank(reqPersona) > personaRank(callerPersona)) {
    violations.push({
      invariant: 'PERSONA_ISOLATION',
      message: `Operation requires persona="${reqPersona}", but caller only has "${callerPersona}".`,
    })
  }

  return {
    admissible: violations.length === 0,
    pipeAction,
    violations,
  }
}

/**
 * Algebraically composes multiple `ExecutionContext` contracts when intersecting sections:
 *   - display: strictest (max displayRank)
 *   - locality: strictest sovereignty (min localityRank)
 *   - capability.scopes: sorted deduplicated union
 *   - capability.privateData: logical OR
 *   - capability.epoch: max epoch
 *   - lifetime: strictest persistence (singleton-service > window-bound > oneshot)
 *   - transport: local non-HTTP preferred; external-http only if all are external-http
 *   - boundary: unique concrete boundary if all non-'in-process' agree, else 'in-process';
 *               distinct concrete boundaries throw ContextConflictError
 *   - persona: highest personaRank if any context specifies persona (omitted if none do)
 *   - sovereignty invariant: privateData === true && localityRank(locality) > localityRank('lan-peer')
 *               throws ContextConflictError
 */
export function intersectContexts(id: string, contexts: readonly ExecutionContext[]): ExecutionContext {
  if (contexts.length === 0) {
    throw new ContextConflictError(id, 'Cannot compose an empty ExecutionContext list.')
  }

  const first = contexts[0]!
  let display: DisplayContext = first.display
  let locality: LocalityZone = first.locality
  let lifetime: LifetimePolicy = first.lifetime
  let transport: IpcTransport = first.transport
  let persona: PersonaPlane | undefined = first.persona
  let epoch = first.capability.epoch
  let privateData = first.capability.privateData === true
  const tenantId = first.capability.tenantId
  const scopeSet = new Set<string>(first.capability.scopes)
  const concreteBoundaries = new Set<ExecutionBoundary>()

  if (first.boundary !== 'in-process') {
    concreteBoundaries.add(first.boundary)
  }

  for (let i = 1; i < contexts.length; i += 1) {
    const ctx = contexts[i]!
    if (displayRank(ctx.display) > displayRank(display)) {
      display = ctx.display
    }
    if (localityRank(ctx.locality) < localityRank(locality)) {
      locality = ctx.locality
    }
    if (LIFETIME_RANK[ctx.lifetime] > LIFETIME_RANK[lifetime]) {
      lifetime = ctx.lifetime
    }
    if (TRANSPORT_LOCALITY_RANK[ctx.transport] < TRANSPORT_LOCALITY_RANK[transport]) {
      transport = ctx.transport
    }
    if (ctx.persona !== undefined && (persona === undefined || personaRank(ctx.persona) > personaRank(persona))) {
      persona = ctx.persona
    }
    if (ctx.capability.epoch > epoch) {
      epoch = ctx.capability.epoch
    }
    if (ctx.capability.privateData === true) {
      privateData = true
    }
    for (const scope of ctx.capability.scopes) {
      scopeSet.add(scope)
    }
    if (ctx.boundary !== 'in-process') {
      concreteBoundaries.add(ctx.boundary)
    }
  }

  if (concreteBoundaries.size > 1) {
    const list = Array.from(concreteBoundaries).sort().join(', ')
    throw new ContextConflictError(id, `Incompatible concrete execution boundaries: [${list}].`)
  }

  const boundary: ExecutionBoundary =
    concreteBoundaries.size === 1 ? concreteBoundaries.values().next().value! : 'in-process'

  if (privateData && localityRank(locality) > localityRank('lan-peer')) {
    throw new ContextConflictError(
      id,
      `Private capability data cannot egress to locality "${locality}" (must be <= "lan-peer").`
    )
  }

  return Object.freeze({
    boundary,
    display,
    lifetime,
    transport,
    capability: Object.freeze({
      tenantId,
      scopes: Object.freeze(Array.from(scopeSet).sort()),
      epoch,
      privateData,
    }),
    locality,
    ...(persona !== undefined ? { persona } : {}),
  })
}
