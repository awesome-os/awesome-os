/**
 * @file schema-definition.mts
 * @description First-principles data-driven Section, SectionSlot, and Intersection schema system
 * for Stealify & B8G Microkernel.
 *
 * 100% compliant with `erasableSyntaxOnly: true` and `"types": []` (no ambient Node globals).
 * Treats self-hydrating programmable sections, physical `SectionSlot`s, and multi-intersection
 * rendezvous uniformly atop zero-copy SharedArrayBuffer arenas.
 */

import { BinaryArenaCodec, computeStructLayout } from './binary-layout.mts'
import {
  checkAdmissibility as checkExecutionAdmissibility,
  intersectContexts,
  type AdmissibilityResult,
  type ExecutionContext,
} from './algebra.mts'

export type PrimitiveType =
  | 'string'
  | 'number'
  | 'float64'
  | 'int32'
  | 'boolean'
  | 'uuid'
  | 'timestamp'
  | 'array'
  | 'record'
  | 'object'

export interface FieldOptions<T = any> {
  type: PrimitiveType
  primaryKey?: boolean
  indexed?: boolean
  nullable?: boolean
  optional?: boolean
  precision?: number
  maxBytes?: number
  items?: FieldDef<any> | PrimitiveType
  recordValueType?: FieldDef<any> | PrimitiveType
  validator?: (val: T) => boolean | string
  defaultValue?: T | (() => T)
}

export class FieldDef<T = any> {
  public readonly type: PrimitiveType
  public isPrimaryKey: boolean
  public isIndexed: boolean
  public isNullable: boolean
  public isOptional: boolean
  public precisionVal?: number
  public maxBytesVal?: number
  public itemsDef?: FieldDef<any> | PrimitiveType
  public recordValueDef?: FieldDef<any> | PrimitiveType
  public validatorFn?: (val: T) => boolean | string
  public defaultValue?: T | (() => T)

  // Phantom property for TypeScript inference
  public readonly _type!: T

  constructor(opts: FieldOptions<T>) {
    this.type = opts.type
    this.isPrimaryKey = opts.primaryKey ?? false
    this.isIndexed = opts.indexed ?? false
    this.isNullable = opts.nullable ?? false
    this.isOptional = opts.optional ?? false
    this.precisionVal = opts.precision
    this.maxBytesVal = opts.maxBytes
    this.itemsDef = opts.items
    this.recordValueDef = opts.recordValueType
    this.validatorFn = opts.validator
    this.defaultValue = opts.defaultValue
  }

  public primaryKey(): this {
    this.isPrimaryKey = true
    this.isIndexed = true
    return this
  }

  public indexed(): this {
    this.isIndexed = true
    return this
  }

  public nullable(): FieldDef<T | null> {
    this.isNullable = true
    return this as unknown as FieldDef<T | null>
  }

  public optional(): FieldDef<T | undefined> {
    this.isOptional = true
    return this as unknown as FieldDef<T | undefined>
  }

  public precision(p: number): this {
    this.precisionVal = p
    return this
  }

  public maxBytes(bytes: number): this {
    this.maxBytesVal = bytes
    return this
  }

  public validate(fn: (val: T) => boolean | string): this {
    this.validatorFn = fn
    return this
  }

  public default(val: T | (() => T)): this {
    this.defaultValue = val
    return this
  }
}

// Fluent Field Builder Namespace
export const f = {
  string: (opts?: Partial<FieldOptions<string>>) =>
    new FieldDef<string>({ type: 'string', ...opts }),

  number: (opts?: Partial<FieldOptions<number>>) =>
    new FieldDef<number>({ type: 'number', ...opts }),

  float64: (opts?: Partial<FieldOptions<number>>) =>
    new FieldDef<number>({ type: 'float64', precision: 8, ...opts }),

  int32: (opts?: Partial<FieldOptions<number>>) =>
    new FieldDef<number>({ type: 'int32', precision: 4, ...opts }),

  boolean: (opts?: Partial<FieldOptions<boolean>>) =>
    new FieldDef<boolean>({ type: 'boolean', ...opts }),

  uuid: (opts?: Partial<FieldOptions<string>>) =>
    new FieldDef<string>({ type: 'uuid', maxBytes: 36, ...opts }),

  timestamp: (opts?: Partial<FieldOptions<number>>) =>
    new FieldDef<number>({ type: 'timestamp', precision: 8, ...opts }),

  array: <TItem,>(items: FieldDef<TItem> | PrimitiveType, opts?: Partial<FieldOptions<TItem[]>>) =>
    new FieldDef<TItem[]>({ type: 'array', items, ...opts }),

  record: <TVal,>(
    _key: 'string',
    valueType: FieldDef<TVal> | PrimitiveType,
    opts?: Partial<FieldOptions<Record<string, TVal>>>
  ) =>
    new FieldDef<Record<string, TVal>>({ type: 'record', recordValueType: valueType, ...opts }),

  object: <TObj extends Record<string, any>>(opts?: Partial<FieldOptions<TObj>>) =>
    new FieldDef<TObj>({ type: 'object', ...opts }),
}

// Protocol Definition
export type ProtocolChannel = 'grpc' | 'kafka' | 'nats' | 'udp' | 'websocket' | 'amqp' | 'http' | 'b8g-mesh'

export interface ProtocolBinding {
  readonly direction: 'input' | 'output'
  readonly protocol: ProtocolChannel
  readonly target: string
}

export const p = {
  input: (protocol: ProtocolChannel, target: string): ProtocolBinding => ({
    direction: 'input',
    protocol,
    target,
  }),
  output: (protocol: ProtocolChannel, target: string): ProtocolBinding => ({
    direction: 'output',
    protocol,
    target,
  }),
}

// Storage Configuration
export type StorageEngine = 'redis' | 'postgres' | 'timescaledb' | 'b8g-cas' | 'sqlite' | 'memory-arena'

export interface StorageConfig {
  readonly engine: StorageEngine
  readonly ttl?: number
  readonly partitionBy?: string
  readonly retention?: string
  readonly auditLog?: boolean
  readonly isolationLevel?: 'read_committed' | 'serializable' | 'snapshot'
  readonly indexes?: string[]
}

// Memory Layout Strategy
export type LayoutStrategy = 'standard-json' | 'binary-packed' | 'arena-aligned'

// Physical Substrate Binding (Self-Hydration)
export type SubstrateKind = 'disk' | 'uvs-cas' | 'sqlite' | 'sab-ring' | 'pty-stream' | 'http-origin' | 'computed'

export interface SubstrateDescriptor<TKind extends SubstrateKind = SubstrateKind> {
  readonly kind: TKind
  readonly target?: string
  readonly table?: string
  readonly ringBytes?: number
  readonly dependsOn?: readonly string[]
  readonly watch?: boolean
}

export type DependencyTarget =
  | string
  | { readonly id: string }
  | { readonly slotId: string; readonly section: { readonly id: string } }

function extractDependencyId(dep: DependencyTarget): string {
  if (typeof dep === 'string') return dep
  if ('section' in dep && dep.section && typeof dep.section.id === 'string') return dep.section.id
  if ('id' in dep && typeof dep.id === 'string') return dep.id
  return String(dep)
}

/**
 * Physical substrate builder namespace `s.*` for declarative self-hydrating sections and section slots.
 */
export const s = {
  disk: (opts: { root?: string; watch?: boolean } = {}): SubstrateDescriptor<'disk'> => ({
    kind: 'disk',
    target: opts.root ?? '.',
    watch: opts.watch ?? true,
  }),
  uvsCas: (opts: { prefix?: string } = {}): SubstrateDescriptor<'uvs-cas'> => ({
    kind: 'uvs-cas',
    target: opts.prefix ?? 'refs/heads/main',
  }),
  sqlite: (opts: { table: string; dbPath?: string }): SubstrateDescriptor<'sqlite'> => ({
    kind: 'sqlite',
    table: opts.table,
    target: opts.dbPath ?? ':memory:',
  }),
  sabRing: (opts: { ringBytes?: number; capacityBytes?: number } = {}): SubstrateDescriptor<'sab-ring'> => ({
    kind: 'sab-ring',
    ringBytes: opts.ringBytes ?? opts.capacityBytes ?? 65536,
  }),
  ptyStream: (opts: { shell?: string } = {}): SubstrateDescriptor<'pty-stream'> => ({
    kind: 'pty-stream',
    target: opts.shell ?? 'b8g-shell',
  }),
  httpOrigin: (opts: { basePath?: string } = {}): SubstrateDescriptor<'http-origin'> => ({
    kind: 'http-origin',
    target: opts.basePath ?? '/',
  }),
  computed: (opts: { dependsOn: readonly DependencyTarget[] }): SubstrateDescriptor<'computed'> => ({
    kind: 'computed',
    dependsOn: opts.dependsOn.map(extractDependencyId),
  }),
}

export interface SectionHydrationContext<TState = Record<string, any>, TCaps = Record<string, any>> {
  readonly slotId: string
  readonly caps: TCaps
  readonly sab: SharedArrayBuffer
  readonly byteOffset: number
  readonly byteLength: number
  readonly scratch: Map<string, unknown>
  readState(): TState
  readSection<TOther = Record<string, any>>(sectionOrSlotOrId: DependencyTarget): TOther
}

export interface SectionOpContext<TState = Record<string, any>, TCaps = Record<string, any>>
  extends SectionHydrationContext<TState, TCaps> {
  patchState(patch: Partial<TState>): TState
}

export type SectionOpHandler<TState = any, TInput = any, TOutput = any, TCaps = any> = (
  ctx: SectionOpContext<TState, TCaps>,
  input: TInput
) => TOutput | Promise<TOutput>

// ---------------------------------------------------------------------------
// Canonical Section Definitions (`defineSection`)
// ---------------------------------------------------------------------------

// TypeScript Type Inference Utilities
export type InferField<F> = F extends FieldDef<infer T> ? T : never

export type InferSectionFromFields<TFields extends Record<string, FieldDef<any>>> = {
  [K in keyof TFields as undefined extends InferField<TFields[K]> ? never : K]: InferField<TFields[K]>
} & {
  [K in keyof TFields as undefined extends InferField<TFields[K]> ? K : never]?: InferField<TFields[K]>
}

export type SectionKind =
  | 'ui-surface'
  | 'storage-cas'
  | 'compute-runtime'
  | 'game-sim'
  | 'devops-plane'
  | 'protocol-bridge'

export type UiSurfaceBackend =
  | 'html-dom'
  | 'canvas-2d'
  | 'canvas-3d'
  | 'framebuffer'
  | 'unknown-framebuffer'

export interface SectionShapeMap {
  readonly 'ui-surface': {
    readonly surface: UiSurfaceBackend
    readonly liveness: 'progress-bar' | 'overlay' | 'stream'
    readonly htmlTagged?: boolean
    readonly actions: readonly string[]
  }
  readonly 'storage-cas': {
    readonly digest: 'sha256'
    readonly merkleAuditable: true
    readonly tenantScoped: boolean
  }
  readonly 'compute-runtime': {
    readonly isolation: 'vm' | 'wasi' | 'sab-worker' | 'process'
    readonly quotaEnforced: boolean
  }
  readonly 'game-sim': {
    readonly tickHz: number
    readonly deterministic: boolean
    readonly renderer: 'webgpu' | 'webgl2' | 'headless'
  }
  readonly 'devops-plane': {
    readonly consumerZeroBytes: true
    readonly sidecarFormat: 'debug.b8p' | 'none'
  }
  readonly 'protocol-bridge': {
    readonly transport: 'os-pipe' | 'sab' | 'lan-mtls' | 'quic-tunnel'
    readonly authMode: string
  }
}

export type SectionShapeFor<K extends SectionKind> = SectionShapeMap[K]

export class SectionShapeError extends Error {
  readonly kind: SectionKind
  readonly violations: readonly string[]

  constructor(sectionId: string, kind: SectionKind, violations: readonly string[]) {
    super(`[stealify-schema] Section "${sectionId}" (${kind}) violated shape contract: ${violations.join('; ')}`)
    this.name = 'SectionShapeError'
    this.kind = kind
    this.violations = violations
  }
}

export function validateSectionShape(
  kind: SectionKind,
  shape: unknown,
  context?: ExecutionContext
): string[] {
  const violations: string[] = []
  if (!shape || typeof shape !== 'object') {
    return [`Section kind "${kind}" requires an explicit shape object.`]
  }
  const s = shape as Record<string, unknown>

  if (kind === 'ui-surface') {
    const validSurfaces = new Set(['html-dom', 'canvas-2d', 'canvas-3d', 'framebuffer', 'unknown-framebuffer'])
    if (typeof s.surface !== 'string' || !validSurfaces.has(s.surface)) {
      violations.push('ui-surface requires shape.surface ("html-dom" | "canvas-2d" | "canvas-3d" | "framebuffer" | "unknown-framebuffer")')
    }
    if (s.liveness !== 'progress-bar' && s.liveness !== 'overlay' && s.liveness !== 'stream') {
      violations.push('ui-surface requires shape.liveness ("progress-bar" | "overlay" | "stream")')
    }
    if (s.surface === 'html-dom' && s.htmlTagged !== true) {
      violations.push('ui-surface with surface="html-dom" requires shape.htmlTagged === true (B8G022 compliance)')
    }
    if (!Array.isArray(s.actions) || s.actions.length === 0) {
      violations.push('ui-surface requires a non-empty shape.actions list')
    }
  } else if (kind === 'storage-cas') {
    if (s.digest !== 'sha256') violations.push('storage-cas requires shape.digest === "sha256"')
    if (s.merkleAuditable !== true) violations.push('storage-cas requires shape.merkleAuditable === true')
    if (typeof s.tenantScoped !== 'boolean') violations.push('storage-cas requires boolean shape.tenantScoped')
  } else if (kind === 'compute-runtime') {
    if (s.isolation !== 'vm' && s.isolation !== 'wasi' && s.isolation !== 'sab-worker' && s.isolation !== 'process') {
      violations.push('compute-runtime requires valid shape.isolation')
    }
    if (typeof s.quotaEnforced !== 'boolean') violations.push('compute-runtime requires boolean shape.quotaEnforced')
  } else if (kind === 'game-sim') {
    if (typeof s.tickHz !== 'number' || s.tickHz <= 0) violations.push('game-sim requires positive shape.tickHz')
    if (typeof s.deterministic !== 'boolean') violations.push('game-sim requires boolean shape.deterministic')
    if (s.renderer !== 'webgpu' && s.renderer !== 'webgl2' && s.renderer !== 'headless') {
      violations.push('game-sim requires valid shape.renderer')
    }
  } else if (kind === 'devops-plane') {
    if (s.consumerZeroBytes !== true) violations.push('devops-plane requires shape.consumerZeroBytes === true')
    if (context && context.persona === 'consumer') {
      violations.push('devops-plane cannot declare context.persona === "consumer" (violates Omega isolation)')
    }
  } else if (kind === 'protocol-bridge') {
    if (typeof s.transport !== 'string' || !s.transport) violations.push('protocol-bridge requires shape.transport')
    if (typeof s.authMode !== 'string' || !s.authMode) violations.push('protocol-bridge requires shape.authMode')
  }
  return violations
}

export interface SectionSpec<
  TFields extends Record<string, FieldDef<any>> = Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
  TOps extends Record<string, SectionOpHandler<any, any, any, any>> = Record<string, SectionOpHandler>,
  TKind extends SectionKind = SectionKind
> {
  readonly id: string
  readonly version: string
  readonly description?: string
  readonly kind?: TKind
  readonly shape?: SectionShapeMap[TKind]
  readonly layout?: LayoutStrategy
  readonly storage?: StorageConfig
  readonly substrate?: SubstrateDescriptor
  readonly context?: ExecutionContext
  readonly fields: TFields
  readonly protocols?: TProtocols
  readonly hydrate?: (
    ctx: SectionHydrationContext<InferSectionFromFields<TFields>, any>
  ) => Partial<InferSectionFromFields<TFields>> | Promise<Partial<InferSectionFromFields<TFields>>>
  readonly flush?: (ctx: SectionHydrationContext<InferSectionFromFields<TFields>, any>) => void | Promise<void>
  readonly ops?: TOps
}

export interface SectionDefinition<
  TFields extends Record<string, FieldDef<any>> = Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
  TOps extends Record<string, SectionOpHandler<any, any, any, any>> = Record<string, SectionOpHandler>,
  TKind extends SectionKind = SectionKind
> {
  readonly id: string
  readonly version: string
  readonly description?: string
  readonly kind?: TKind
  readonly shape?: SectionShapeMap[TKind]
  readonly layout: LayoutStrategy
  readonly storage?: StorageConfig
  readonly substrate?: SubstrateDescriptor
  readonly context?: ExecutionContext
  readonly fields: TFields
  readonly protocols: TProtocols
  readonly ops: TOps
  readonly infer: InferSectionFromFields<TFields>
  hydrate?(
    ctx: SectionHydrationContext<InferSectionFromFields<TFields>, any>
  ): Partial<InferSectionFromFields<TFields>> | Promise<Partial<InferSectionFromFields<TFields>>>
  flush?(ctx: SectionHydrationContext<InferSectionFromFields<TFields>, any>): void | Promise<void>
  defaultState(): InferSectionFromFields<TFields>
  validate(data: unknown): { valid: boolean; errors: string[] }
  checkAdmissibility(
    caller: ExecutionContext,
    opts?: { readonly isExternalWeb?: boolean; readonly activePipeOwners?: number }
  ): AdmissibilityResult
}

export type InferSection<S> = S extends SectionDefinition<infer TFields, any, any>
  ? InferSectionFromFields<TFields>
  : S extends SectionSpec<infer TFields, any, any>
    ? InferSectionFromFields<TFields>
    : S extends SectionSlotDefinition<infer Sec>
      ? InferSection<Sec>
      : never

export function materializeDefaultFieldValue(field: FieldDef<any>): unknown {
  if (field.defaultValue !== undefined) {
    return typeof field.defaultValue === 'function' ? (field.defaultValue as () => unknown)() : field.defaultValue
  }
  if (field.isOptional) return undefined
  if (field.isNullable) return null
  switch (field.type) {
    case 'string':
    case 'uuid':
      return ''
    case 'boolean':
      return false
    case 'array':
      return []
    case 'record':
    case 'object':
      return {}
    case 'number':
    case 'float64':
    case 'int32':
    case 'timestamp':
    default:
      return 0
  }
}

export function materializeFieldsDefaults<TFields extends Record<string, FieldDef<any>>>(
  fields: TFields
): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    const val = materializeDefaultFieldValue(field)
    if (val !== undefined) {
      state[key] = val
    }
  }
  return state
}

/**
 * Define a self-hydrating, programmable Section schema (`s.*` physical substrate + fields + ops).
 */
export function defineSection<
  TFields extends Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
  TOps extends Record<string, SectionOpHandler<any, any, any, any>> = Record<string, SectionOpHandler>,
  TKind extends SectionKind = SectionKind
>(spec: SectionSpec<TFields, TProtocols, TOps, TKind>): SectionDefinition<TFields, TProtocols, TOps, TKind> {
  if (spec.kind) {
    const shapeViolations = validateSectionShape(spec.kind, spec.shape, spec.context)
    if (shapeViolations.length > 0) {
      throw new SectionShapeError(spec.id, spec.kind, shapeViolations)
    }
  }
  const layout: LayoutStrategy = spec.layout ?? (spec.substrate ? 'arena-aligned' : 'standard-json')
  const protocols = (spec.protocols ?? {}) as TProtocols
  const ops = (spec.ops ?? {}) as TOps

  const def: SectionDefinition<TFields, TProtocols, TOps, TKind> = {
    id: spec.id,
    version: spec.version,
    description: spec.description,
    kind: spec.kind,
    shape: spec.shape,
    layout,
    storage: spec.storage,
    substrate: spec.substrate,
    context: spec.context,
    fields: spec.fields,
    protocols,
    ops,
    hydrate: spec.hydrate,
    flush: spec.flush,
    infer: {} as InferSectionFromFields<TFields>,
    defaultState(): InferSectionFromFields<TFields> {
      return materializeFieldsDefaults(spec.fields) as InferSectionFromFields<TFields>
    },
    checkAdmissibility(
      caller: ExecutionContext,
      opts?: { readonly isExternalWeb?: boolean; readonly activePipeOwners?: number }
    ): AdmissibilityResult {
      if (!def.context) {
        return { admissible: true, pipeAction: 'none', violations: [] }
      }
      return checkExecutionAdmissibility(def.context, caller, opts)
    },
    validate(data: unknown): { valid: boolean; errors: string[] } {
      const errors: string[] = []
      if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Section payload must be a non-null object'] }
      }

      const rec = data as Record<string, any>
      for (const [key, field] of Object.entries(spec.fields)) {
        const val = rec[key]

        if (val === undefined) {
          if (!field.isOptional) {
            errors.push(`Missing required field '${key}'`)
          }
          continue
        }

        if (val === null) {
          if (!field.isNullable) {
            errors.push(`Field '${key}' cannot be null`)
          }
          continue
        }

        switch (field.type) {
          case 'string':
          case 'uuid':
            if (typeof val !== 'string') {
              errors.push(`Field '${key}' expected string, got ${typeof val}`)
            } else if (field.maxBytesVal && new TextEncoder().encode(val).length > field.maxBytesVal) {
              errors.push(`Field '${key}' exceeds maxBytes (${field.maxBytesVal})`)
            }
            break
          case 'number':
          case 'float64':
          case 'int32':
          case 'timestamp':
            if (typeof val !== 'number' || Number.isNaN(val)) {
              errors.push(`Field '${key}' expected number, got ${typeof val}`)
            }
            break
          case 'boolean':
            if (typeof val !== 'boolean') {
              errors.push(`Field '${key}' expected boolean, got ${typeof val}`)
            }
            break
          case 'array':
            if (!Array.isArray(val)) {
              errors.push(`Field '${key}' expected array, got ${typeof val}`)
            }
            break
          case 'record':
          case 'object':
            if (typeof val !== 'object' || Array.isArray(val)) {
              errors.push(`Field '${key}' expected object, got ${typeof val}`)
            }
            break
        }

        if (field.validatorFn) {
          const res = field.validatorFn(val)
          if (res !== true) {
            errors.push(typeof res === 'string' ? res : `Field '${key}' validation failed`)
          }
        }
      }

      return { valid: errors.length === 0, errors }
    },
  }

  return def
}

// ---------------------------------------------------------------------------
// First-Class Schema SectionSlot (`defineSectionSlot` / `slot`)
// ---------------------------------------------------------------------------

export interface SectionSlotSpec<TSection extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>> {
  readonly slotId: string
  readonly section: TSection
  readonly substrate?: SubstrateDescriptor
  readonly alignBytes?: number
  readonly required?: boolean
}

export interface SectionSlotDefinition<
  TSection extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>
> {
  readonly isSectionSlot: true
  readonly slotId: string
  readonly section: TSection
  readonly fields: TSection['fields']
  readonly protocols: TSection['protocols']
  readonly substrate?: SubstrateDescriptor
  readonly alignBytes: number
  readonly required: boolean
  readonly structSize: number
}

export interface SectionSlotLayout<
  TSection extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>
> {
  readonly slotId: string
  readonly index: number
  readonly section: TSection
  readonly substrate?: SubstrateDescriptor
  readonly offset: number
  readonly size: number
  readonly alignBytes: number
  readonly required: boolean
}

/**
 * Declare a physical & schema-level `SectionSlot` binding a Section to a named arena slot
 * (optionally overriding its substrate or alignment within an Intersection).
 */
export function defineSectionSlot<TSection extends SectionDefinition<any, any, any>>(
  spec: SectionSlotSpec<TSection>
): SectionSlotDefinition<TSection> {
  const layoutMeta = computeStructLayout(spec.section)
  return {
    isSectionSlot: true,
    slotId: spec.slotId,
    section: spec.section,
    fields: spec.section.fields,
    protocols: spec.section.protocols,
    substrate: spec.substrate ?? spec.section.substrate,
    alignBytes: spec.alignBytes ?? 64,
    required: spec.required ?? true,
    structSize: layoutMeta.totalSize,
  }
}

/**
 * Ergonomic shorthand for `defineSectionSlot`.
 */
export function slot<TSection extends SectionDefinition<any, any, any>>(
  slotId: string,
  section: TSection,
  opts?: { substrate?: SubstrateDescriptor; alignBytes?: number; required?: boolean }
): SectionSlotDefinition<TSection> {
  return defineSectionSlot({
    slotId,
    section,
    substrate: opts?.substrate,
    alignBytes: opts?.alignBytes,
    required: opts?.required,
  })
}

// ---------------------------------------------------------------------------
// Backward-Compatible Aliases (Deprecated — prefer defineSection / SectionSlot)
// ---------------------------------------------------------------------------

/** @deprecated Use `SectionSpec` and `defineSection`. */
export type ComponentSpec<
  TFields extends Record<string, FieldDef<any>> = Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
  TOps extends Record<string, SectionOpHandler<any, any, any, any>> = Record<string, SectionOpHandler>
> = SectionSpec<TFields, TProtocols, TOps>

/** @deprecated Use `SectionDefinition` and `defineSection`. */
export type ComponentDefinition<
  TFields extends Record<string, FieldDef<any>> = Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
  TOps extends Record<string, SectionOpHandler<any, any, any, any>> = Record<string, SectionOpHandler>
> = SectionDefinition<TFields, TProtocols, TOps>

/** @deprecated Use `InferSectionFromFields`. */
export type InferComponentFromFields<TFields extends Record<string, FieldDef<any>>> = InferSectionFromFields<TFields>

/** @deprecated Use `InferSection`. */
export type InferComponent<C> = InferSection<C>

/** @deprecated Use `defineSection`. */
export function defineComponent<
  TFields extends Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
  TOps extends Record<string, SectionOpHandler<any, any, any, any>> = Record<string, SectionOpHandler>
>(spec: SectionSpec<TFields, TProtocols, TOps>): SectionDefinition<TFields, TProtocols, TOps> {
  return defineSection(spec)
}

// ---------------------------------------------------------------------------
// Multi-Intersection Rendezvous Architecture (`defineIntersection` & `intersect`)
// ---------------------------------------------------------------------------

export type Intersectable =
  | SectionDefinition<any, any, any>
  | SectionSlotDefinition<any>
  | IntersectionDefinition<any, any, any>

export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never

export type ExtractLeafSection<U> = U extends IntersectionDefinition<infer Inner, any, any>
  ? ExtractLeafSection<Inner[number]>
  : U extends SectionSlotDefinition<infer S>
    ? S
    : U extends SectionDefinition<any, any, any>
      ? U
      : never

export type IsAny<T> = 0 extends 1 & T ? true : false

export type StripIndexSignature<T> = IsAny<T> extends true
  ? {}
  : {
      [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
    }

export type SafeExtractFields<U> = U extends { readonly fields: infer F }
  ? IsAny<F> extends true
    ? {}
    : StripIndexSignature<F>
  : {}

export type SafeExtractProtocols<U> = U extends { readonly protocols: infer P }
  ? IsAny<P> extends true
    ? {}
    : StripIndexSignature<P>
  : {}

export type MergeSectionFields<TUnits extends readonly Intersectable[]> = UnionToIntersection<
  SafeExtractFields<TUnits[number]>
>

export type MergeSectionProtocols<TUnits extends readonly Intersectable[]> = UnionToIntersection<
  SafeExtractProtocols<TUnits[number]>
>

export type InferIntersection<I> = I extends IntersectionDefinition<any, infer TFields, any>
  ? InferSectionFromFields<TFields>
  : InferSection<I>

export interface IntersectionSpec<
  TUnits extends readonly Intersectable[] = readonly Intersectable[],
  TExtraFields extends Record<string, FieldDef<any>> = Record<string, FieldDef<any>>,
  TExtraProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>
> {
  readonly id: string
  readonly version: string
  readonly sections?: TUnits
  readonly slots?: TUnits
  readonly fields?: TExtraFields
  readonly protocols?: TExtraProtocols
  readonly layout?: LayoutStrategy
  readonly storage?: StorageConfig
  readonly context?: ExecutionContext
}

export interface IntersectionDefinition<
  TUnits extends readonly Intersectable[] = readonly Intersectable[],
  TFields extends Record<string, FieldDef<any>> = Record<string, FieldDef<any>>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>
> extends SectionDefinition<TFields, TProtocols> {
  readonly context?: ExecutionContext
  readonly sections: ReadonlyArray<SectionDefinition<any, any, any>>
  readonly slots: ReadonlyArray<SectionSlotLayout<SectionDefinition<any, any, any>>>
  readonly intersectedUnits: TUnits
  readonly isIntersection: true
  readonly structSize: number
  getSlot(
    target: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string
  ): SectionSlotLayout<SectionDefinition<any, any, any>> | undefined
  hasSlot(target: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string): boolean
  hasSection(section: SectionDefinition<any, any, any> | string): boolean
  createSabBuffer(instances?: number): SharedArrayBuffer
  syncToSab(data: Record<string, any>, target: SharedArrayBuffer | Uint8Array, byteOffset?: number): number
  syncFromSab(source: SharedArrayBuffer | Uint8Array, byteOffset?: number): Record<string, any>
  syncSectionToSab(
    section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string,
    sectionData: Record<string, any>,
    target: SharedArrayBuffer | Uint8Array,
    byteOffset?: number
  ): number
  syncSectionFromSab(
    section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string,
    source: SharedArrayBuffer | Uint8Array,
    byteOffset?: number
  ): Record<string, any>
  getSectionOffset(
    section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string
  ): { offset: number; size: number } | undefined
}

export interface FlattenedSlotEntry {
  readonly slotId: string
  readonly section: SectionDefinition<any, any, any>
  substrate?: SubstrateDescriptor
  readonly alignBytes: number
  readonly required: boolean
}

function isIntersectionDef(u: Intersectable): u is IntersectionDefinition<any, any, any> {
  return 'isIntersection' in u && u.isIntersection === true
}

function isSectionSlotDef(u: Intersectable): u is SectionSlotDefinition<any> {
  return 'isSectionSlot' in u && u.isSectionSlot === true
}

/**
 * Recursively flattens nested Intersections, SectionSlotDefinitions, and raw SectionDefinitions
 * into a deduplicated ordered slot table (preserving first-seen order by `slotId`).
 */
export function flattenIntersectableSlots(units: readonly Intersectable[]): FlattenedSlotEntry[] {
  const bySlotId = new Map<string, FlattenedSlotEntry>()

  const pushEntry = (entry: FlattenedSlotEntry): void => {
    const existing = bySlotId.get(entry.slotId)
    if (!existing) {
      bySlotId.set(entry.slotId, { ...entry })
      return
    }
    if (!existing.substrate && entry.substrate) {
      existing.substrate = entry.substrate
    }
  }

  const visit = (unit: Intersectable): void => {
    if (isIntersectionDef(unit)) {
      if (Array.isArray(unit.slots) && unit.slots.length > 0) {
        for (const sl of unit.slots) {
          pushEntry({
            slotId: sl.slotId,
            section: sl.section,
            substrate: sl.substrate ?? sl.section.substrate,
            alignBytes: sl.alignBytes,
            required: sl.required,
          })
        }
      } else {
        for (const sec of unit.sections) {
          pushEntry({
            slotId: sec.id,
            section: sec,
            substrate: sec.substrate,
            alignBytes: 64,
            required: true,
          })
        }
      }
      return
    }
    if (isSectionSlotDef(unit)) {
      pushEntry({
        slotId: unit.slotId,
        section: unit.section,
        substrate: unit.substrate ?? unit.section.substrate,
        alignBytes: unit.alignBytes,
        required: unit.required,
      })
      return
    }
    pushEntry({
      slotId: unit.id,
      section: unit,
      substrate: unit.substrate,
      alignBytes: 64,
      required: true,
    })
  }

  for (const unit of units) {
    visit(unit)
  }

  return Array.from(bySlotId.values())
}

function resolveTargetId(
  target: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string
): string {
  if (typeof target === 'string') return target
  if ('slotId' in target) return target.slotId
  return target.id
}

/**
 * Define an Intersection: rendezvous point intersecting multiple Sections, SectionSlots,
 * and/or existing Intersections onto a deduplicated SharedArrayBuffer arena layout.
 */
export function defineIntersection<
  const TUnits extends readonly Intersectable[],
  TExtraFields extends Record<string, FieldDef<any>> = {},
  TExtraProtocols extends Record<string, ProtocolBinding> = {}
>(
  spec: IntersectionSpec<TUnits, TExtraFields, TExtraProtocols>
): IntersectionDefinition<
  TUnits,
  MergeSectionFields<TUnits> & TExtraFields,
  MergeSectionProtocols<TUnits> & TExtraProtocols
> {
  const rawUnits = (spec.slots ?? spec.sections ?? []) as unknown as TUnits
  const flattenedSlots = flattenIntersectableSlots(rawUnits)
  const leafSections = flattenedSlots.map((sl) => sl.section) as unknown as ReadonlyArray<
    ExtractLeafSection<TUnits[number]>
  >

  const mergedFields: Record<string, FieldDef<any>> = {}
  const mergedProtocols: Record<string, ProtocolBinding> = {}

  const collectUnitExtras = (unit: Intersectable): void => {
    if (isIntersectionDef(unit)) {
      for (const inner of unit.intersectedUnits ?? []) {
        collectUnitExtras(inner)
      }
      for (const [k, v] of Object.entries(unit.fields) as Array<[string, FieldDef<any>]>) {
        mergedFields[k] = v
      }
      for (const [k, v] of Object.entries(unit.protocols) as Array<[string, ProtocolBinding]>) {
        mergedProtocols[k] = v
      }
      return
    }
    const sec = isSectionSlotDef(unit) ? unit.section : unit
    for (const [k, v] of Object.entries(sec.fields) as Array<[string, FieldDef<any>]>) {
      mergedFields[k] = v
    }
    for (const [k, v] of Object.entries(sec.protocols) as Array<[string, ProtocolBinding]>) {
      mergedProtocols[k] = v
    }
  }

  for (const unit of rawUnits) {
    collectUnitExtras(unit)
  }

  if (spec.fields) {
    for (const [k, v] of Object.entries(spec.fields) as Array<[string, FieldDef<any>]>) {
      mergedFields[k] = v
    }
  }
  if (spec.protocols) {
    for (const [k, v] of Object.entries(spec.protocols) as Array<[string, ProtocolBinding]>) {
      mergedProtocols[k] = v
    }
  }

  const collectedContexts: ExecutionContext[] = []
  for (const unit of rawUnits) {
    if (isIntersectionDef(unit)) {
      if (unit.context) collectedContexts.push(unit.context)
    } else if (isSectionSlotDef(unit)) {
      if (unit.section.context) collectedContexts.push(unit.section.context)
    } else {
      if (unit.context) collectedContexts.push(unit.context)
    }
  }
  if (spec.context) {
    collectedContexts.push(spec.context)
  }
  const composedContext =
    collectedContexts.length > 0 ? intersectContexts(spec.id, collectedContexts) : undefined

  const layout: LayoutStrategy = spec.layout ?? 'arena-aligned'
  const baseDef = defineSection({
    id: spec.id,
    version: spec.version,
    layout,
    storage: spec.storage,
    context: composedContext,
    fields: mergedFields,
    protocols: mergedProtocols,
  })

  const layoutMeta = computeStructLayout(baseDef)
  const codec = new BinaryArenaCodec(baseDef)

  const slotLayouts: SectionSlotLayout<SectionDefinition<any, any, any>>[] = []
  const slotById = new Map<string, SectionSlotLayout<SectionDefinition<any, any, any>>>()
  const sectionMeta = new Map<string, { offset: number; size: number }>()

  flattenedSlots.forEach((entry, index) => {
    let minOffset = Infinity
    let maxOffset = 0
    for (const fieldName of Object.keys(entry.section.fields)) {
      const fMeta = layoutMeta.fields.find((fm) => fm.name === fieldName)
      if (fMeta) {
        if (fMeta.offset < minOffset) minOffset = fMeta.offset
        if (fMeta.offset + fMeta.size > maxOffset) maxOffset = fMeta.offset + fMeta.size
      }
    }
    const offset = minOffset === Infinity ? 0 : minOffset
    const size = minOffset === Infinity ? computeStructLayout(entry.section).totalSize : maxOffset - minOffset
    const slotLayout: SectionSlotLayout<SectionDefinition<any, any, any>> = {
      slotId: entry.slotId,
      index,
      section: entry.section,
      substrate: entry.substrate,
      offset,
      size,
      alignBytes: entry.alignBytes,
      required: entry.required,
    }
    slotLayouts.push(slotLayout)
    slotById.set(entry.slotId, slotLayout)
    if (!slotById.has(entry.section.id)) {
      slotById.set(entry.section.id, slotLayout)
    }
    sectionMeta.set(entry.slotId, { offset, size })
    if (!sectionMeta.has(entry.section.id)) {
      sectionMeta.set(entry.section.id, { offset, size })
    }
  })

  const intersectionDef = {
    ...baseDef,
    hydrate: undefined,
    flush: undefined,
    fields: mergedFields as MergeSectionFields<TUnits> & TExtraFields,
    protocols: mergedProtocols as MergeSectionProtocols<TUnits> & TExtraProtocols,
    infer: {} as InferSectionFromFields<MergeSectionFields<TUnits> & TExtraFields>,
    sections: leafSections,
    slots: slotLayouts,
    intersectedUnits: rawUnits,
    isIntersection: true as const,
    structSize: codec.structSize,
    defaultState(): InferSectionFromFields<MergeSectionFields<TUnits> & TExtraFields> {
      const merged = materializeFieldsDefaults(mergedFields)
      for (const sl of slotLayouts) {
        Object.assign(merged, sl.section.defaultState())
      }
      return merged as InferSectionFromFields<MergeSectionFields<TUnits> & TExtraFields>
    },
    getSlot(target: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string) {
      return slotById.get(resolveTargetId(target))
    },
    hasSlot(target: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string) {
      return slotById.has(resolveTargetId(target))
    },
    hasSection(secOrId: SectionDefinition<any, any, any> | string) {
      const targetId = typeof secOrId === 'string' ? secOrId : secOrId.id
      return slotLayouts.some((sl) => sl.section.id === targetId || sl.slotId === targetId)
    },
    validate(data: unknown): { valid: boolean; errors: string[] } {
      const baseResult = baseDef.validate(data)
      const errors = [...baseResult.errors]

      for (const sl of slotLayouts) {
        const secRes = sl.section.validate(data)
        for (const err of secRes.errors) {
          if (!errors.includes(err)) {
            errors.push(err)
          }
        }
      }

      return { valid: errors.length === 0, errors }
    },
    createSabBuffer(instances: number = 1): SharedArrayBuffer {
      return new SharedArrayBuffer(Math.max(1, codec.structSize) * Math.max(1, instances))
    },
    syncToSab(data: Record<string, any>, target: SharedArrayBuffer | Uint8Array, byteOffset: number = 0): number {
      return codec.pack(data, target, byteOffset)
    },
    syncFromSab(source: SharedArrayBuffer | Uint8Array, byteOffset: number = 0): Record<string, any> {
      return codec.unpack(source, byteOffset)
    },
    syncSectionToSab(
      section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string,
      sectionData: Record<string, any>,
      target: SharedArrayBuffer | Uint8Array,
      byteOffset: number = 0
    ): number {
      const targetId = resolveTargetId(section)
      const targetSlot = slotById.get(targetId)
      if (!targetSlot) {
        throw new Error(`Slot/Section '${targetId}' not found in intersection '${spec.id}'`)
      }
      const filtered: Record<string, any> = {}
      for (const fieldName of Object.keys(targetSlot.section.fields)) {
        if (fieldName in sectionData) {
          filtered[fieldName] = sectionData[fieldName]
        }
      }
      codec.pack(filtered, target, byteOffset)
      return targetSlot.size
    },
    syncSectionFromSab(
      section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string,
      source: SharedArrayBuffer | Uint8Array,
      byteOffset: number = 0
    ): Record<string, any> {
      const targetId = resolveTargetId(section)
      const targetSlot = slotById.get(targetId)
      if (!targetSlot) {
        throw new Error(`Slot/Section '${targetId}' not found in intersection '${spec.id}'`)
      }
      const full = codec.unpack(source, byteOffset)
      const res: Record<string, any> = {}
      for (const fieldName of Object.keys(targetSlot.section.fields)) {
        if (fieldName in full) {
          res[fieldName] = full[fieldName]
        }
      }
      return res
    },
    getSectionOffset(section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string) {
      return sectionMeta.get(resolveTargetId(section))
    },
  }

  return intersectionDef as unknown as IntersectionDefinition<
    TUnits,
    MergeSectionFields<TUnits> & TExtraFields,
    MergeSectionProtocols<TUnits> & TExtraProtocols
  >
}

/**
 * Ergonomic multi-intersection constructor: `intersect('vscodium-ide', [I_a, I_b, Sec_c])`.
 */
export function intersect<
  const TUnits extends readonly Intersectable[],
  TExtraFields extends Record<string, FieldDef<any>> = {},
  TExtraProtocols extends Record<string, ProtocolBinding> = {}
>(
  id: string,
  units: TUnits,
  extras?: {
    version?: string
    fields?: TExtraFields
    protocols?: TExtraProtocols
    layout?: LayoutStrategy
    storage?: StorageConfig
    context?: ExecutionContext
  }
): IntersectionDefinition<
  TUnits,
  MergeSectionFields<TUnits> & TExtraFields,
  MergeSectionProtocols<TUnits> & TExtraProtocols
> {
  return defineIntersection({
    id,
    version: extras?.version ?? '1.0.0',
    slots: units,
    fields: extras?.fields,
    protocols: extras?.protocols,
    layout: extras?.layout,
    storage: extras?.storage,
    context: extras?.context,
  })
}
