/**
 * @file intersection-container.mts
 * @description Runtime `IntersectionContainer` owning a shared 64-byte-aligned `SharedArrayBuffer` arena,
 * deduplicated `SectionSlot` instances, topological `s.*` self-hydration, reactive `s.computed` propagation,
 * programmable `ops` invocation, and I/O protocol routing.
 *
 * Strictly `types: []` and `erasableSyntaxOnly: true` clean (zero `node:*` imports).
 */

import { BinaryArenaCodec } from './binary-layout.mts'
import { ProtocolRouter, type ProtocolHandler } from './protocol-adapters.mts'
import {
  type DependencyTarget,
  type FieldDef,
  type InferIntersection,
  type InferSection,
  type IntersectionDefinition,
  type ProtocolBinding,
  type SectionDefinition,
  type SectionSlotDefinition,
  type SectionSlotLayout,
} from './schema-definition.mts'
import { SectionSlot, type SectionSlotOverride, type StateSubscriber } from './section-slot.mts'

export interface IntersectionContainerOptions {
  readonly arenaByteLength?: number
}

function alignUp(value: number, alignment: number): number {
  const align = Math.max(8, alignment)
  const rem = value % align
  return rem === 0 ? value : value + (align - rem)
}

function isIntersectionDef(
  def: SectionDefinition<any, any, any> | IntersectionDefinition<any, any, any>
): def is IntersectionDefinition<any, any, any> {
  return 'isIntersection' in def && def.isIntersection === true
}

function resolveSlotKey(
  target: SectionDefinition<any, any, any> | SectionSlotDefinition<any> | SectionSlotLayout<any> | string
): string {
  if (typeof target === 'string') return target
  if ('slotId' in target) return target.slotId
  return target.id
}

export class IntersectionContainer {
  private readonly arena: SharedArrayBuffer
  private arenaCursor = 0
  private readonly slotsById = new Map<string, SectionSlot<any>>()
  private readonly slotsBySectionId = new Map<string, SectionSlot<any>>()
  private readonly definitions = new Map<string, SectionDefinition<any, any, any> | IntersectionDefinition<any, any, any>>()
  private readonly intersectionExtraState = new Map<string, Record<string, any>>()
  private readonly intersectionCodecs = new Map<string, BinaryArenaCodec>()
  private readonly intersectionRecords = new Map<string, Map<string, any>>()
  private readonly intersectionSubscribers = new Map<string, Set<StateSubscriber<any>>>()
  private readonly sectionToIntersections = new Map<string, Set<string>>()
  public readonly router = new ProtocolRouter()

  constructor(options: IntersectionContainerOptions = {}) {
    const bytes = Math.max(65536, options.arenaByteLength ?? 512 * 1024)
    this.arena = new SharedArrayBuffer(bytes)
  }

  public getArena(): SharedArrayBuffer {
    return this.arena
  }

  /**
   * Returns (or lazily allocates in the shared SAB arena) the canonical `SectionSlot` for a Section or SectionSlotDefinition.
   * Overlapping Intersections share the exact same `SectionSlot` instance and SAB slice!
   */
  public slot<S extends SectionDefinition<any, any, any>>(
    target: S | SectionSlotDefinition<S>
  ): SectionSlot<S> {
    const isSlotDef = 'isSectionSlot' in target && target.isSectionSlot === true
    const slotId = isSlotDef ? target.slotId : (target as S).id
    const section = (isSlotDef ? target.section : target) as S
    const alignBytes = isSlotDef ? target.alignBytes : 64
    const substrate = isSlotDef ? target.substrate : (target as S).substrate

    const existing = this.slotsById.get(slotId)
    if (existing) {
      return existing as SectionSlot<S>
    }

    const tempCodec = new BinaryArenaCodec(section)
    const sliceBytes = alignUp(Math.max(alignBytes, tempCodec.structSize), alignBytes)
    const alignedOffset = alignUp(this.arenaCursor, alignBytes)

    let targetSab: SharedArrayBuffer = this.arena
    let targetOffset = alignedOffset
    if (alignedOffset + sliceBytes <= this.arena.byteLength) {
      this.arenaCursor = alignedOffset + sliceBytes
    } else {
      // Spill safely if caller registers more slices than initial slab size
      targetSab = new SharedArrayBuffer(sliceBytes)
      targetOffset = 0
    }

    const created = new SectionSlot<S>(section, {
      slotId,
      sab: targetSab,
      byteOffset: targetOffset,
      byteLength: sliceBytes,
      alignBytes,
      substrate,
      onMutate: (mutatedSlot, nextState, prevState, fromRecordSet) => {
        if (fromRecordSet) {
          this.emitOutputProtocols(mutatedSlot.section, nextState)
        }
        const parentIds = this.sectionToIntersections.get(mutatedSlot.slotId)
        if (parentIds && !fromRecordSet) {
          for (const interId of parentIds) {
            const interDef = this.definitions.get(interId)
            if (interDef && isIntersectionDef(interDef)) {
              const subs = this.intersectionSubscribers.get(interId)
              if (subs && subs.size > 0) {
                const snapshot = this.readSabState(interDef)
                for (const fn of subs) {
                  fn(snapshot, prevState)
                }
              }
            }
          }
        }
      },
    })

    this.slotsById.set(slotId, created)
    if (!this.slotsBySectionId.has(section.id)) {
      this.slotsBySectionId.set(section.id, created)
    }
    this.router.registerSection(section)
    return created
  }

  public getSlot<S extends SectionDefinition<any, any, any> = SectionDefinition<any, any, any>>(
    slotOrSection: S | SectionSlotDefinition<S> | string
  ): SectionSlot<S> | undefined {
    const key = resolveSlotKey(slotOrSection)
    return (this.slotsById.get(key) ?? this.slotsBySectionId.get(key)) as SectionSlot<S> | undefined
  }

  public slotsFor(def: IntersectionDefinition<any, any, any>): ReadonlyArray<SectionSlot<any>> {
    const out: SectionSlot<any>[] = []
    if (Array.isArray(def.slots) && def.slots.length > 0) {
      for (const slLayout of def.slots) {
        const sInstance = this.slot({
          isSectionSlot: true,
          slotId: slLayout.slotId,
          section: slLayout.section,
          fields: slLayout.section.fields,
          protocols: slLayout.section.protocols,
          substrate: slLayout.substrate,
          alignBytes: slLayout.alignBytes,
          required: slLayout.required,
          structSize: slLayout.size,
        })
        this.linkSlotToIntersection(sInstance.slotId, def.id)
        out.push(sInstance)
      }
      return out
    }
    for (const sec of def.sections) {
      const sInstance = this.slot(sec)
      this.linkSlotToIntersection(sInstance.slotId, def.id)
      out.push(sInstance)
    }
    return out
  }

  public overrideSlot<S extends SectionDefinition<any, any, any>>(
    target: S | SectionSlotDefinition<S> | string,
    override: SectionSlotOverride<S>
  ): SectionSlot<S> {
    const key = resolveSlotKey(target)
    const existing = this.slotsById.get(key) ?? this.slotsBySectionId.get(key)
    if (existing) {
      return existing.applyOverride(override) as SectionSlot<S>
    }
    if (typeof target !== 'string') {
      const created = this.slot(target)
      return created.applyOverride(override)
    }
    throw new Error(`Cannot override unknown SectionSlot '${key}'`)
  }

  public register<D extends SectionDefinition<any, any, any> | IntersectionDefinition<any, any, any>>(def: D): this {
    this.definitions.set(def.id, def)
    this.router.registerSection(def)

    if (isIntersectionDef(def)) {
      this.slotsFor(def)
      if (!this.intersectionExtraState.has(def.id)) {
        const defaults = def.defaultState()
        const extraOnly: Record<string, any> = {}
        const slotFieldSet = new Set<string>()
        for (const sec of def.sections) {
          for (const k of Object.keys(sec.fields)) slotFieldSet.add(k)
        }
        for (const [k, v] of Object.entries(defaults)) {
          if (!slotFieldSet.has(k)) extraOnly[k] = v
        }
        this.intersectionExtraState.set(def.id, extraOnly)
      }
      if (def.layout === 'binary-packed' || def.layout === 'arena-aligned') {
        this.intersectionCodecs.set(def.id, new BinaryArenaCodec(def))
      }
      if (!this.intersectionRecords.has(def.id)) {
        this.intersectionRecords.set(def.id, new Map())
      }
      return this
    }

    this.slot(def)
    return this
  }

  public getCodec(def: SectionDefinition<any, any, any> | IntersectionDefinition<any, any, any>): BinaryArenaCodec | undefined {
    if (isIntersectionDef(def)) {
      return this.intersectionCodecs.get(def.id)
    }
    const sl = this.slot(def)
    if (def.layout === 'binary-packed' || def.layout === 'arena-aligned') {
      return sl.codec
    }
    return undefined
  }

  public registerOutputSink(protocol: string, handler: ProtocolHandler): void {
    this.router.registerOutputSink(protocol, handler)
  }

  public getPrimaryKeyField(def: SectionDefinition<any, any, any>): string {
    const fieldEntries = Object.entries(def.fields) as Array<[string, FieldDef<any>]>
    for (const [name, f] of fieldEntries) {
      if (f.isPrimaryKey) return name
    }
    return 'id'
  }

  public getScratch(defOrSlot: IntersectionDefinition<any, any, any> | SectionDefinition<any, any, any> | string, sectionId?: string): Map<string, unknown> {
    const key = sectionId ?? resolveSlotKey(defOrSlot)
    const sl = this.slotsById.get(key) ?? this.slotsBySectionId.get(key)
    if (sl) return sl.scratch
    if (typeof defOrSlot !== 'string' && isIntersectionDef(defOrSlot)) {
      this.register(defOrSlot)
      const registeredSlot = sectionId ? (this.slotsById.get(sectionId) ?? this.slotsBySectionId.get(sectionId)) : undefined
      if (registeredSlot) return registeredSlot.scratch
    }
    return new Map()
  }

  public readSabState<I extends IntersectionDefinition<any, any, any>>(def: I): InferIntersection<I> {
    this.register(def)
    const state: Record<string, any> = { ...(this.intersectionExtraState.get(def.id) ?? {}) }
    for (const sl of this.slotsFor(def)) {
      Object.assign(state, sl.read())
    }
    return state as InferIntersection<I>
  }

  public exportIntersectionSab(def: IntersectionDefinition<any, any, any>): SharedArrayBuffer {
    const state = this.readSabState(def)
    const sab = def.createSabBuffer(1)
    def.syncToSab(state as Record<string, any>, sab, 0)
    return sab
  }

  public readSectionSabState(
    def: IntersectionDefinition<any, any, any>,
    section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string
  ): Record<string, any> {
    this.register(def)
    const key = resolveSlotKey(section)
    const slLayout = def.getSlot(section)
    const sl = (slLayout ? this.slotsById.get(slLayout.slotId) : undefined) ?? this.slotsById.get(key) ?? this.slotsBySectionId.get(key)
    if (!sl) {
      throw new Error(`Slot/Section '${key}' not found in intersection '${def.id}'`)
    }
    return sl.read()
  }

  public patchSectionSab(
    def: IntersectionDefinition<any, any, any>,
    section: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string,
    patch: Record<string, any>
  ): Record<string, any> {
    this.register(def)
    const key = resolveSlotKey(section)
    const slLayout = def.getSlot(section)
    const sl = (slLayout ? this.slotsById.get(slLayout.slotId) : undefined) ?? this.slotsById.get(key) ?? this.slotsBySectionId.get(key)
    if (!sl) {
      throw new Error(`Slot/Section '${key}' not found in intersection '${def.id}'`)
    }
    return sl.patch(patch)
  }

  /**
   * Topologically hydrate all physical substrates (`s.*`) inside an Intersection,
   * ensuring `s.computed({ dependsOn })` slots execute after their dependencies.
   */
  public async hydrate<I extends IntersectionDefinition<any, any, any>>(
    def: I,
    caps: Record<string, any> = {},
    overrides?: Record<string, SectionSlotOverride<any>>
  ): Promise<InferIntersection<I>> {
    this.register(def)
    if (overrides) {
      for (const [slotKey, ov] of Object.entries(overrides)) {
        this.overrideSlot(slotKey, ov)
      }
    }

    const orderedSlots = this.topologicalSortSlots(this.slotsFor(def))
    const readSection = this.makeReadSectionFn()
    for (const sl of orderedSlots) {
      await sl.hydrate(caps, readSection)
    }
    return this.readSabState(def)
  }

  /**
   * Invoke a programmable operation on a `SectionSlot` inside an Intersection,
   * then reactively re-hydrate any downstream `s.computed` SectionSlots that depend on it.
   */
  public async invokeOp<TOut = unknown>(
    def: IntersectionDefinition<any, any, any>,
    target: SectionSlotDefinition<any> | SectionDefinition<any, any, any> | string,
    opName: string,
    input: unknown,
    caps: Record<string, any> = {}
  ): Promise<TOut> {
    this.register(def)
    const key = resolveSlotKey(target)
    const slLayout = def.getSlot(target)
    const sl = (slLayout ? this.slotsById.get(slLayout.slotId) : undefined) ?? this.slotsById.get(key) ?? this.slotsBySectionId.get(key)
    if (!sl) {
      throw new Error(`Slot/Section '${key}' not found in intersection '${def.id}'`)
    }

    const readSection = this.makeReadSectionFn()
    const { result, mutated } = await sl.invoke<TOut>(opName, input, caps, readSection)

    if (mutated) {
      await this.rehydrateDependents(sl.slotId, sl.section.id, caps, readSection)
    }

    return result
  }

  public async flush(def: IntersectionDefinition<any, any, any>, caps: Record<string, any> = {}): Promise<void> {
    this.register(def)
    const readSection = this.makeReadSectionFn()
    for (const sl of this.slotsFor(def)) {
      await sl.flush(caps, readSection)
    }
  }

  public set<C extends SectionDefinition<any, any, any>>(
    def: C,
    data: InferSection<C>
  ): { success: boolean; errors?: string[] } {
    this.register(def)

    if (isIntersectionDef(def)) {
      const val = def.validate(data)
      if (!val.valid) {
        return { success: false, errors: val.errors }
      }
      const pkField = this.getPrimaryKeyField(def)
      const pk = String((data as Record<string, any>)[pkField])
      const store = this.intersectionRecords.get(def.id)!
      const prev = store.get(pk)
      store.set(pk, data)

      const rec = data as Record<string, any>
      const extraPatch: Record<string, any> = {}
      const extraMap = this.intersectionExtraState.get(def.id)
      for (const k of Object.keys(rec)) {
        if (extraMap && k in extraMap) {
          extraPatch[k] = rec[k]
        }
      }
      if (extraMap) Object.assign(extraMap, extraPatch)

      for (const sl of this.slotsFor(def)) {
        const patchObj: Record<string, any> = {}
        for (const fieldName of Object.keys(sl.section.fields)) {
          if (fieldName in rec) {
            patchObj[fieldName] = rec[fieldName]
          }
        }
        if (Object.keys(patchObj).length > 0 && (sl.section.layout === 'binary-packed' || sl.section.layout === 'arena-aligned')) {
          sl.patch(patchObj)
        }
      }

      const subs = this.intersectionSubscribers.get(def.id)
      if (subs) {
        for (const fn of subs) fn(data, prev)
      }
      this.emitOutputProtocols(def, data)
      return { success: true }
    }

    return this.slot(def).set(data)
  }

  public get<C extends SectionDefinition<any, any, any>>(
    def: C,
    primaryKey: string | number
  ): InferSection<C> | undefined {
    if (isIntersectionDef(def)) {
      return this.intersectionRecords.get(def.id)?.get(String(primaryKey))
    }
    return this.getSlot(def)?.get(primaryKey)
  }

  public list<C extends SectionDefinition<any, any, any>>(def: C): Array<InferSection<C>> {
    if (isIntersectionDef(def)) {
      const store = this.intersectionRecords.get(def.id)
      return store ? Array.from(store.values()) : []
    }
    return this.getSlot(def)?.list() ?? []
  }

  public mutate<C extends SectionDefinition<any, any, any>>(
    def: C,
    primaryKey: string | number,
    mutator: (current: InferSection<C>) => void
  ): boolean {
    if (isIntersectionDef(def)) {
      const current = this.get(def, primaryKey)
      if (!current) return false
      const clone = JSON.parse(JSON.stringify(current)) as InferSection<C>
      mutator(clone)
      return this.set(def, clone).success
    }
    return this.getSlot(def)?.mutate(primaryKey, mutator) ?? false
  }

  public subscribe<C extends SectionDefinition<any, any, any>>(
    def: C,
    subscriber: StateSubscriber<InferSection<C>>
  ): () => void {
    this.register(def)
    if (isIntersectionDef(def)) {
      if (!this.intersectionSubscribers.has(def.id)) {
        this.intersectionSubscribers.set(def.id, new Set())
      }
      const set = this.intersectionSubscribers.get(def.id)!
      set.add(subscriber)
      return () => {
        set.delete(subscriber)
      }
    }
    return this.slot(def).subscribe(subscriber)
  }

  public ingest(protocol: string, target: string, rawData: unknown): boolean {
    const res = this.router.ingest(protocol, target, rawData)
    if (!res.success || !res.data) return false

    for (const def of this.definitions.values()) {
      const protocolValues = Object.values(def.protocols) as ProtocolBinding[]
      for (const binding of protocolValues) {
        if (binding.direction === 'input' && binding.protocol === protocol && binding.target === target) {
          return this.set(def, res.data).success
        }
      }
    }
    return false
  }

  private linkSlotToIntersection(slotId: string, intersectionId: string): void {
    let set = this.sectionToIntersections.get(slotId)
    if (!set) {
      set = new Set()
      this.sectionToIntersections.set(slotId, set)
    }
    set.add(intersectionId)
  }

  private makeReadSectionFn() {
    return <TOther = Record<string, any>,>(target: DependencyTarget): TOther => {
      const key =
        typeof target === 'string'
          ? target
          : 'slotId' in target
            ? target.slotId
            : target.id
      const sl = this.slotsById.get(key) ?? this.slotsBySectionId.get(key)
      if (!sl) {
        throw new Error(`readSection: SectionSlot '${key}' is not registered in IntersectionContainer`)
      }
      return sl.read() as unknown as TOther
    }
  }

  private topologicalSortSlots(slots: readonly SectionSlot<any>[]): SectionSlot<any>[] {
    const byKey = new Map<string, SectionSlot<any>>()
    for (const sl of slots) {
      byKey.set(sl.slotId, sl)
      byKey.set(sl.section.id, sl)
    }

    const visited = new Set<string>()
    const visiting = new Set<string>()
    const result: SectionSlot<any>[] = []

    const visit = (sl: SectionSlot<any>): void => {
      if (visited.has(sl.slotId)) return
      if (visiting.has(sl.slotId)) return
      visiting.add(sl.slotId)
      const deps = sl.substrate?.kind === 'computed' ? (sl.substrate.dependsOn ?? []) : []
      for (const depId of deps) {
        const depSlot = byKey.get(depId)
        if (depSlot && depSlot !== sl) {
          visit(depSlot)
        }
      }
      visiting.delete(sl.slotId)
      visited.add(sl.slotId)
      result.push(sl)
    }

    for (const sl of slots) {
      visit(sl)
    }
    return result
  }

  private async rehydrateDependents(
    changedSlotId: string,
    changedSectionId: string,
    caps: Record<string, any>,
    readSection: <TOther = Record<string, any>>(target: DependencyTarget) => TOther
  ): Promise<void> {
    const queue: Array<{ slotId: string; sectionId: string }> = [{ slotId: changedSlotId, sectionId: changedSectionId }]
    const refreshed = new Set<string>()

    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const sl of this.slotsById.values()) {
        if (refreshed.has(sl.slotId)) continue
        if (sl.substrate?.kind !== 'computed') continue
        const deps = sl.substrate.dependsOn ?? []
        if (deps.includes(cur.slotId) || deps.includes(cur.sectionId)) {
          refreshed.add(sl.slotId)
          await sl.hydrate(caps, readSection)
          queue.push({ slotId: sl.slotId, sectionId: sl.section.id })
        }
      }
    }
  }

  private emitOutputProtocols(def: SectionDefinition<any, any, any>, payload: any): void {
    for (const outName of Object.keys(def.protocols)) {
      if (def.protocols[outName].direction === 'output') {
        void this.router.emitOutput(def.id, outName, payload)
      }
    }
  }
}
