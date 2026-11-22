/**
 * @file binary-layout.mts
 * @description Zero-copy binary struct packer and memory arena layout generator for B8G Microkernel.
 */

import type { ComponentDefinition, FieldDef, PrimitiveType } from './schema-definition.mts'

export interface FieldOffsetMeta {
  readonly name: string
  readonly type: PrimitiveType
  readonly offset: number
  readonly size: number
}

export interface StructLayoutMeta {
  readonly totalSize: number
  readonly alignment: number
  readonly fields: FieldOffsetMeta[]
}

const TYPE_SIZES: Record<string, number> = {
  float64: 8,
  timestamp: 8,
  int32: 4,
  number: 4,
  boolean: 1,
  uuid: 36,
}

export function computeStructLayout(def: ComponentDefinition): StructLayoutMeta {
  let currentOffset = 0
  let maxAlign = 4
  const fields: FieldOffsetMeta[] = []

  const fieldEntries = Object.entries(def.fields) as Array<[string, FieldDef<any>]>
  for (const [name, field] of fieldEntries) {
    const size = field.maxBytesVal ?? TYPE_SIZES[field.type] ?? 8
    const align = size >= 8 ? 8 : size >= 4 ? 4 : 1
    if (align > maxAlign) maxAlign = align

    // Align offset
    const remainder = currentOffset % align
    if (remainder !== 0) {
      currentOffset += align - remainder
    }

    fields.push({
      name,
      type: field.type,
      offset: currentOffset,
      size,
    })

    currentOffset += size
  }

  // Final struct padding
  const structPad = currentOffset % maxAlign
  if (structPad !== 0) {
    currentOffset += maxAlign - structPad
  }

  return {
    totalSize: currentOffset,
    alignment: maxAlign,
    fields,
  }
}

export class BinaryArenaCodec {
  private readonly layout: StructLayoutMeta
  private readonly textEncoder = new TextEncoder()
  private readonly textDecoder = new TextDecoder()

  constructor(def: ComponentDefinition) {
    this.layout = computeStructLayout(def)
  }

  public get structSize(): number {
    return this.layout.totalSize
  }

  public pack(data: Record<string, any>, target: Uint8Array | ArrayBufferLike, byteOffset: number = 0): number {
    const u8 = target instanceof Uint8Array ? target : new Uint8Array(target)
    const view = new DataView(u8.buffer, u8.byteOffset + byteOffset, this.layout.totalSize)

    for (const f of this.layout.fields) {
      const val = data[f.name]
      if (val === undefined || val === null) continue

      switch (f.type) {
        case 'float64':
        case 'timestamp':
          view.setFloat64(f.offset, Number(val), true)
          break
        case 'int32':
          if (f.size === 1) {
            view.setInt8(f.offset, Number(val))
          } else if (f.size === 2) {
            view.setInt16(f.offset, Number(val), true)
          } else {
            view.setInt32(f.offset, Number(val), true)
          }
          break
        case 'number':
          view.setFloat32(f.offset, Number(val), true)
          break
        case 'boolean':
          view.setUint8(f.offset, val ? 1 : 0)
          break
        case 'string':
        case 'uuid': {
          const encoded = this.textEncoder.encode(String(val))
          const copyLen = Math.min(encoded.length, f.size)
          u8.set(encoded.subarray(0, copyLen), byteOffset + f.offset)
          // Null terminate or pad
          if (copyLen < f.size) {
            u8[byteOffset + f.offset + copyLen] = 0
          }
          break
        }
      }
    }

    return this.layout.totalSize
  }

  public unpack(source: Uint8Array | ArrayBufferLike, byteOffset: number = 0): Record<string, any> {
    const u8 = source instanceof Uint8Array ? source : new Uint8Array(source)
    const view = new DataView(u8.buffer, u8.byteOffset + byteOffset, this.layout.totalSize)
    const result: Record<string, any> = {}

    for (const f of this.layout.fields) {
      switch (f.type) {
        case 'float64':
        case 'timestamp':
          result[f.name] = view.getFloat64(f.offset, true)
          break
        case 'int32':
          if (f.size === 1) {
            result[f.name] = view.getInt8(f.offset)
          } else if (f.size === 2) {
            result[f.name] = view.getInt16(f.offset, true)
          } else {
            result[f.name] = view.getInt32(f.offset, true)
          }
          break
        case 'number':
          result[f.name] = view.getFloat32(f.offset, true)
          break
        case 'boolean':
          result[f.name] = view.getUint8(f.offset) === 1
          break
        case 'string':
        case 'uuid': {
          const rawSlice = u8.subarray(byteOffset + f.offset, byteOffset + f.offset + f.size)
          // Find null terminator if any
          let len = rawSlice.indexOf(0)
          if (len === -1) len = rawSlice.length
          result[f.name] = this.textDecoder.decode(rawSlice.subarray(0, len))
          break
        }
        default:
          result[f.name] = null
          break
      }
    }

    return result
  }
}
