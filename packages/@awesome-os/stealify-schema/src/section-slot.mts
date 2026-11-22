/**
 * @file section-slot.mts
 * @description Physical & runtime `SectionSlot` primitive for `@awesome-os/stealify-schema`.
 *
 * A `SectionSlot<S>` binds one physical SharedArrayBuffer slice (`byteOffset..byteOffset+byteLength`),
 * an optional physical substrate (`s.disk`, `s.uvsCas`, `s.sqlite`, `s.sabRing`, `s.ptyStream`, `s.httpOrigin`, `s.computed`),
 * typed primary-key record storage, and self-hydrating `ops` into one unified runtime slot.
 *
 * Strictly `types: []` and `erasableSyntaxOnly: true` clean (zero `node:*` imports).
 */

import { BinaryArenaCodec } from './binary-layout.mts'
import {
  type DependencyTarget,
  type FieldDef,
  type InferSection,
  type SectionDefinition,
  type SectionHydrationContext,
  type SectionOpContext,
  type SectionOpHandler,
  type SectionSpec,
  type SubstrateDescriptor,
} from './schema-definition.mts'

export type StateSubscriber<T = any> = (state: T, previousState?: T) => void

export interface SectionSlotOverride<
  TSection extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>
> {
  readonly section?: TSection
  readonly substrate?: SubstrateDescriptor
  readonly hydrate?: SectionSpec<any, any, any>['hydrate']
  readonly flush?: SectionSpec<any, any, any>['flush']
  readonly ops?: Record<string, SectionOpHandler>
}

export interface SectionSlotOptions<
  TSection extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>
> {
  readonly slotId?: string
  readonly sab?: SharedArrayBuffer
  readonly byteOffset?: number
  readonly byteLength?: number
  readonly alignBytes?: number
  readonly substrate?: SubstrateDescriptor
  readonly onMutate?: (
    slot: SectionSlot<TSection>,
    nextState: InferSection<TSection>,
    prevState?: InferSection<TSection>,
    fromRecordSet?: boolean
  ) => void
}

function alignUp(value: number, alignment: number): number {
  const align = Math.max(1, alignment)
  const rem = value % align
  return rem === 0 ? value : value + (align - rem)
}

export class SectionSlot<
  TSection extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>
> {
  public readonly slotId: string
  public readonly sab: SharedArrayBuffer
  public readonly byteOffset: number
  public readonly byteLength: number
  public readonly alignBytes: number
  public readonly scratch = new Map<string, unknown>()

  private activeSection: TSection
  private activeCodec: BinaryArenaCodec
  private activeSubstrate?: SubstrateDescriptor
  private overrideHydrate?: SectionSpec<any, any, any>['hydrate']
  private overrideFlush?: SectionSpec<any, any, any>['flush']
  private overrideOps?: Record<string, SectionOpHandler>
  private readonly onMutate?: SectionSlotOptions<TSection>['onMutate']
  private readonly records = new Map<string, InferSection<TSection>>()
  private readonly subscribers = new Set<StateSubscriber<InferSection<TSection>>>()

  constructor(section: TSection, options: SectionSlotOptions<TSection> = {}) {
    this.activeSection = section
    this.activeCodec = new BinaryArenaCodec(section)
    this.slotId = options.slotId ?? section.id
    this.alignBytes = Math.max(8, options.alignBytes ?? 64)
    this.activeSubstrate = options.substrate ?? section.substrate
    this.onMutate = options.onMutate

    const requiredBytes = alignUp(Math.max(this.alignBytes, this.activeCodec.structSize), this.alignBytes)
    this.byteLength = options.byteLength !== undefined ? Math.max(options.byteLength, this.activeCodec.structSize) : requiredBytes
    this.sab = options.sab ?? new SharedArrayBuffer(this.byteLength)
    this.byteOffset = options.byteOffset ?? 0

    // Seed SharedArrayBuffer slice with deterministic field defaults
    if (this.activeCodec.structSize > 0) {
      this.activeCodec.pack(section.defaultState() as Record<string, any>, this.sab, this.byteOffset)
    }
  }

  public get section(): TSection {
    return this.activeSection
  }

  public get codec(): BinaryArenaCodec {
    return this.activeCodec
  }

  public get substrate(): SubstrateDescriptor | undefined {
    return this.activeSubstrate
  }

  /**
   * Swap section schema, substrate binding, hydrate/flush hooks, or op handlers inside this physical slot.
   */
  public applyOverride(override: SectionSlotOverride<TSection>): this {
    if (override.section) {
      const nextCodec = new BinaryArenaCodec(override.section)
      if (nextCodec.structSize > this.byteLength) {
        throw new Error(
          `Cannot override slot '${this.slotId}' (${this.byteLength}B) with section '${override.section.id}' requiring ${nextCodec.structSize}B`
        )
      }
      this.activeSection = override.section
      this.activeCodec = nextCodec
      if (this.activeCodec.structSize > 0) {
        this.activeCodec.pack(override.section.defaultState() as Record<string, any>, this.sab, this.byteOffset)
      }
    }
    if (override.substrate !== undefined) {
      this.activeSubstrate = override.substrate
    } else if (override.section?.substrate !== undefined && override.substrate === undefined) {
      this.activeSubstrate = override.section.substrate
    }
    if (override.hydrate !== undefined) {
      this.overrideHydrate = override.hydrate
    }
    if (override.flush !== undefined) {
      this.overrideFlush = override.flush
    }
    if (override.ops !== undefined) {
      this.overrideOps = { ...(this.overrideOps ?? {}), ...override.ops }
    }
    return this
  }

  public getPrimaryKeyField(): string {
    const fieldEntries = Object.entries(this.activeSection.fields) as Array<[string, FieldDef<any>]>
    for (const [name, f] of fieldEntries) {
      if (f.isPrimaryKey) return name
    }
    return 'id'
  }

  /**
   * Zero-copy read of the slot's physical SharedArrayBuffer slice.
   */
  public read(): InferSection<TSection> {
    if (this.activeCodec.structSize === 0) {
      return this.activeSection.defaultState() as InferSection<TSection>
    }
    return this.activeCodec.unpack(this.sab, this.byteOffset) as InferSection<TSection>
  }

  /**
   * Zero-copy overwrite of the slot's physical SharedArrayBuffer slice.
   */
  public write(next: InferSection<TSection>): InferSection<TSection> {
    const prev = this.read()
    if (this.activeCodec.structSize > 0) {
      this.activeCodec.pack(next as Record<string, any>, this.sab, this.byteOffset)
    }
    const materialized = this.read()
    this.notify(materialized, prev, false)
    return materialized
  }

  /**
   * Merge a partial update directly into the slot's physical SharedArrayBuffer slice.
   */
  public patch(partial: Partial<InferSection<TSection>>): InferSection<TSection> {
    const current = this.read()
    const merged = { ...(current as Record<string, any>), ...(partial as Record<string, any>) } as InferSection<TSection>
    return this.write(merged)
  }

  /**
   * Validated primary-key record upsert (updates both record map and binary SAB slice when binary-packed/arena-aligned).
   */
  public set(data: InferSection<TSection>): { success: boolean; errors?: string[] } {
    const val = this.activeSection.validate(data)
    if (!val.valid) {
      return { success: false, errors: val.errors }
    }

    const pkField = this.getPrimaryKeyField()
    const pk = String((data as Record<string, any>)[pkField])
    const prev = this.records.get(pk)
    this.records.set(pk, data)

    if (
      (this.activeSection.layout === 'binary-packed' || this.activeSection.layout === 'arena-aligned') &&
      this.activeCodec.structSize > 0
    ) {
      this.activeCodec.pack(data as Record<string, any>, this.sab, this.byteOffset)
    }

    this.notify(data, prev, true)
    return { success: true }
  }

  public get(primaryKey: string | number): InferSection<TSection> | undefined {
    return this.records.get(String(primaryKey))
  }

  public list(): Array<InferSection<TSection>> {
    return Array.from(this.records.values())
  }

  public mutate(primaryKey: string | number, mutator: (current: InferSection<TSection>) => void): boolean {
    const current = this.get(primaryKey)
    if (!current) return false

    const clone = JSON.parse(JSON.stringify(current)) as InferSection<TSection>
    mutator(clone)
    return this.set(clone).success
  }

  public subscribe(subscriber: StateSubscriber<InferSection<TSection>>): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  public listOps(): string[] {
    const combined = { ...(this.activeSection.ops ?? {}), ...(this.overrideOps ?? {}) }
    return Object.keys(combined)
  }

  public hasOp(opName: string): boolean {
    return Boolean(this.overrideOps?.[opName] ?? this.activeSection.ops?.[opName])
  }

  public async hydrate(
    caps: Record<string, any> = {},
    readSection?: <TOther = Record<string, any>>(target: DependencyTarget) => TOther
  ): Promise<InferSection<TSection>> {
    const hydrateFn = this.overrideHydrate ?? this.activeSection.hydrate
    if (!hydrateFn) {
      return this.read()
    }
    const ctx = this.buildHydrationContext(caps, readSection)
    const patch = await hydrateFn(ctx)
    if (patch && typeof patch === 'object' && Object.keys(patch).length > 0) {
      return this.patch(patch as Partial<InferSection<TSection>>)
    }
    return this.read()
  }

  public async invoke<TOut = unknown>(
    opName: string,
    input: unknown,
    caps: Record<string, any> = {},
    readSection?: <TOther = Record<string, any>>(target: DependencyTarget) => TOther
  ): Promise<{ result: TOut; mutated: boolean }> {
    const handler = this.overrideOps?.[opName] ?? this.activeSection.ops?.[opName]
    if (!handler) {
      throw new Error(`Operation '${opName}' is not defined on SectionSlot '${this.slotId}' (${this.activeSection.id})`)
    }

    let mutated = false
    const baseCtx = this.buildHydrationContext(caps, readSection)
    const opCtx: SectionOpContext<InferSection<TSection>, Record<string, any>> = {
      ...baseCtx,
      patchState: (patch) => {
        mutated = true
        return this.patch(patch)
      },
    }

    const result = (await handler(opCtx, input)) as TOut
    return { result, mutated }
  }

  public async flush(
    caps: Record<string, any> = {},
    readSection?: <TOther = Record<string, any>>(target: DependencyTarget) => TOther
  ): Promise<void> {
    const flushFn = this.overrideFlush ?? this.activeSection.flush
    if (!flushFn) return
    await flushFn(this.buildHydrationContext(caps, readSection))
  }

  private buildHydrationContext(
    caps: Record<string, any>,
    readSection?: <TOther = Record<string, any>>(target: DependencyTarget) => TOther
  ): SectionHydrationContext<InferSection<TSection>, Record<string, any>> {
    return {
      slotId: this.slotId,
      caps,
      sab: this.sab,
      byteOffset: this.byteOffset,
      byteLength: this.byteLength,
      scratch: this.scratch,
      readState: () => this.read(),
      readSection: <TOther = Record<string, any>,>(target: DependencyTarget): TOther => {
        if (readSection) {
          return readSection<TOther>(target)
        }
        return this.read() as unknown as TOther
      },
    }
  }

  private notify(nextState: InferSection<TSection>, prevState?: InferSection<TSection>, fromRecordSet?: boolean): void {
    for (const sub of this.subscribers) {
      sub(nextState, prevState)
    }
    this.onMutate?.(this, nextState, prevState, fromRecordSet)
  }
}
