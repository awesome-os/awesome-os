/**
 * @file protocol-adapters.mts
 * @description Protocol router binding I/O channels (Kafka, NATS, UDP, WebSockets, gRPC) to component schemas.
 */

import type { ProtocolBinding, SectionDefinition } from './schema-definition.mts'

export type ProtocolHandler = (channel: string, target: string, payload: any) => Promise<void> | void

export interface IngestResult<T = any> {
  readonly success: boolean
  readonly data?: T
  readonly errors?: string[]
}

export class ProtocolRouter {
  private readonly inputBindings = new Map<string, { def: SectionDefinition; binding: ProtocolBinding }>()
  private readonly outputBindings = new Map<string, { def: SectionDefinition; binding: ProtocolBinding }>()
  private readonly outputSinks = new Map<string, Set<ProtocolHandler>>()

  public registerSection(def: SectionDefinition): void {
    const protocolEntries = Object.entries(def.protocols) as Array<[string, ProtocolBinding]>
    for (const [name, binding] of protocolEntries) {
      const routeKey = `${binding.protocol}:${binding.target}`
      if (binding.direction === 'input') {
        this.inputBindings.set(routeKey, { def, binding })
      } else {
        this.outputBindings.set(`${def.id}:${name}`, { def, binding })
      }
    }
  }

  /** @deprecated Use `registerSection`. */
  public registerComponent(def: SectionDefinition): void {
    this.registerSection(def)
  }

  public registerOutputSink(protocol: string, handler: ProtocolHandler): void {
    if (!this.outputSinks.has(protocol)) {
      this.outputSinks.set(protocol, new Set())
    }
    this.outputSinks.get(protocol)!.add(handler)
  }

  public ingest(protocol: string, target: string, rawData: unknown): IngestResult {
    const routeKey = `${protocol}:${target}`
    const match = this.inputBindings.get(routeKey)
    if (!match) {
      return { success: false, errors: [`No input channel registered for ${routeKey}`] }
    }

    let parsed: any = rawData
    if (typeof rawData === 'string') {
      try {
        parsed = JSON.parse(rawData)
      } catch {
        parsed = { rawPayload: rawData }
      }
    }

    const val = match.def.validate(parsed)
    if (!val.valid) {
      return { success: false, errors: val.errors }
    }

    return { success: true, data: parsed }
  }

  public async emitOutput(componentId: string, outputName: string, deltaPayload: any): Promise<void> {
    const match = this.outputBindings.get(`${componentId}:${outputName}`)
    if (!match) return

    const sinks = this.outputSinks.get(match.binding.protocol)
    if (sinks) {
      for (const fn of sinks) {
        await fn(outputName, match.binding.target, deltaPayload)
      }
    }
  }
}
