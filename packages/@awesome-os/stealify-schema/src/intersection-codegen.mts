/**
 * @file intersection-codegen.mts
 * @description Declarative introspection, HTTP/JSON router mounting, and erasable TypeScript RPC synthesis
 * for hydrated `IntersectionDefinition`s and their physical `SectionSlot`s.
 *
 * Strictly `types: []` and `erasableSyntaxOnly: true` clean (zero `node:*` imports).
 */

import { type IntersectionContainer } from './intersection-container.mts'
import { type IntersectionDefinition } from './schema-definition.mts'

export interface IntersectionSlotDescriptor {
  readonly slotId: string
  readonly index: number
  readonly sectionId: string
  readonly substrateKind: string
  readonly offset: number
  readonly size: number
  readonly alignBytes: number
  readonly required: boolean
}

export interface IntersectionOpDescriptor {
  readonly slotId: string
  readonly sectionId: string
  readonly substrateKind: string
  readonly opName: string
  readonly httpRoute: string
  readonly slotRoute: string
  readonly sabOffset: number
  readonly sabSize: number
}

export interface MinimalIntersectionRouterLike {
  get(path: string, handler: (c: any) => any): any
  post(path: string, handler: (c: any) => any): any
}

export function describeIntersectionSlots(def: IntersectionDefinition<any, any, any>): IntersectionSlotDescriptor[] {
  return def.slots.map((sl) => ({
    slotId: sl.slotId,
    index: sl.index,
    sectionId: sl.section.id,
    substrateKind: sl.substrate?.kind ?? 'memory-arena',
    offset: sl.offset,
    size: sl.size,
    alignBytes: sl.alignBytes,
    required: sl.required,
  }))
}

export function describeIntersectionOps(
  def: IntersectionDefinition<any, any, any>,
  basePath: string = '/api/intersections'
): IntersectionOpDescriptor[] {
  const cleanBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const ops: IntersectionOpDescriptor[] = []
  for (const sl of def.slots) {
    const opNames = Object.keys(sl.section.ops ?? {})
    for (const opName of opNames) {
      ops.push({
        slotId: sl.slotId,
        sectionId: sl.section.id,
        substrateKind: sl.substrate?.kind ?? 'memory-arena',
        opName,
        httpRoute: `${cleanBase}/${def.id}/${sl.section.id}/${opName}`,
        slotRoute: `${cleanBase}/${def.id}/slots/${sl.slotId}/${opName}`,
        sabOffset: sl.offset,
        sabSize: sl.size,
      })
    }
  }
  return ops
}

/**
 * Mounts `GET ${basePath}/${def.id}/state` and `POST ${basePath}/${def.id}/...` op routes
 * onto any Stealify/Hono-compatible router so every Intersection + its SectionSlots can be reused across servers.
 */
export function mountIntersectionOnRouter(
  router: MinimalIntersectionRouterLike,
  container: IntersectionContainer,
  def: IntersectionDefinition<any, any, any>,
  capsProvider: Record<string, any> | (() => Record<string, any>),
  basePath: string = '/api/intersections'
): { stateRoute: string; opRoutes: string[] } {
  container.register(def)
  const cleanBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const stateRoute = `${cleanBase}/${def.id}/state`
  const opRoutes: string[] = []

  router.get(stateRoute, (c: any) => {
    const runtimeSlots = container.slotsFor(def).map((runtimeSlot, index) => ({
      slotId: runtimeSlot.slotId,
      index,
      sectionId: runtimeSlot.section.id,
      substrateKind: runtimeSlot.substrate?.kind ?? 'memory-arena',
      byteOffset: runtimeSlot.byteOffset,
      byteLength: runtimeSlot.byteLength,
      alignBytes: runtimeSlot.alignBytes,
      ops: runtimeSlot.listOps(),
    }))
    return c.json({
      ok: true,
      id: def.id,
      version: def.version,
      structSize: def.structSize,
      slots: runtimeSlots,
      sections: runtimeSlots.map((s) => ({
        id: s.sectionId,
        slotId: s.slotId,
        substrate: s.substrateKind,
        offset: s.byteOffset,
        size: s.byteLength,
      })),
      ops: describeIntersectionOps(def, cleanBase),
      state: container.readSabState(def),
    })
  })

  for (const sl of def.slots) {
    const opNames = Object.keys(sl.section.ops ?? {})
    for (const opName of opNames) {
      const sectionRoute = `${cleanBase}/${def.id}/${sl.section.id}/${opName}`
      const slotRoute = `${cleanBase}/${def.id}/slots/${sl.slotId}/${opName}`
      const handler = async (c: any) => {
        try {
          const body = await c.req.json().catch(() => ({}))
          const caps = typeof capsProvider === 'function' ? capsProvider() : capsProvider
          const result = await container.invokeOp(def, sl.slotId, opName, body, caps)
          return c.json({
            ok: true,
            intersection: def.id,
            slotId: sl.slotId,
            section: sl.section.id,
            op: opName,
            result,
            state: container.readSabState(def),
          })
        } catch (err: any) {
          const msg = String(err?.message ?? err)
          const status = msg.startsWith('[403]') ? 403 : 400
          return c.json({ ok: false, error: msg }, status)
        }
      }
      router.post(sectionRoute, handler)
      opRoutes.push(sectionRoute)
      if (slotRoute !== sectionRoute) {
        router.post(slotRoute, handler)
        opRoutes.push(slotRoute)
      }
    }
  }

  return { stateRoute, opRoutes }
}

/**
 * Generates pure capability-injected (`types: []`, `erasableSyntaxOnly: true`) TypeScript client source
 * for any Intersection and its `SectionSlot` operations.
 */
export function synthesizeIntersectionModuleSource(
  def: IntersectionDefinition<any, any, any>,
  options: { exportPrefix?: string; basePath?: string } = {}
): string {
  const cleanBase = (options.basePath ?? '/api/intersections').replace(/\/$/, '')
  const slots = describeIntersectionSlots(def)
  const ops = describeIntersectionOps(def, cleanBase)

  return `/**
 * Auto-generated by @awesome-os/stealify-schema (synthesizeIntersectionModuleSource)
 * Intersection: ${def.id} v${def.version} (structSize=${def.structSize}B, slots=${slots.length})
 * Zero ambient Node globals (\`types: []\` + \`erasableSyntaxOnly: true\` compliant).
 */

export const INTERSECTION_ID = ${JSON.stringify(def.id)} as const
export const INTERSECTION_VERSION = ${JSON.stringify(def.version)} as const
export const INTERSECTION_STRUCT_SIZE = ${def.structSize} as const

export const INTERSECTION_SLOTS = ${JSON.stringify(slots, null, 2)} as const

export const INTERSECTION_OPS = ${JSON.stringify(ops, null, 2)} as const

export interface IntersectionFetchResponse<T = unknown> {
  readonly ok: boolean
  readonly result?: T
  readonly state?: Record<string, unknown>
  readonly error?: string
}

export function createIntersectionRpcClient(
  fetchImpl: typeof fetch,
  origin: string
) {
  const baseOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin

  return {
    async getState(): Promise<Record<string, unknown>> {
      const res = await fetchImpl(\`\${baseOrigin}${cleanBase}/${def.id}/state\`)
      return (await res.json()) as Record<string, unknown>
    },
    async invoke<TOut = unknown>(
      sectionOrSlotId: string,
      opName: string,
      input: Record<string, unknown> = {}
    ): Promise<IntersectionFetchResponse<TOut>> {
      const res = await fetchImpl(
        \`\${baseOrigin}${cleanBase}/${def.id}/\${sectionOrSlotId}/\${opName}\`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
      return (await res.json()) as IntersectionFetchResponse<TOut>
    },
  }
}
`
}
