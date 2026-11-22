/**
 * @file storage-mappers.mts
 * @description Automatic SQL DDL, Redis, and TimescaleDB Schema & Query Generators.
 */

import type { FieldDef, IntersectionDefinition, PrimitiveType, SectionDefinition } from './schema-definition.mts'

export interface SlotManifestEntry {
  readonly slotId: string
  readonly index: number
  readonly sectionId: string
  readonly offset: number
  readonly size: number
  readonly alignBytes: number
  readonly substrate: string
}

export interface IntersectionSlotManifest {
  readonly intersectionId: string
  readonly version: string
  readonly structSize: number
  readonly slots: SlotManifestEntry[]
}

export class StorageMapper {
  public static generateSlotManifest(def: IntersectionDefinition<any, any, any>): IntersectionSlotManifest {
    return {
      intersectionId: def.id,
      version: def.version,
      structSize: def.structSize,
      slots: def.slots.map((sl) => ({
        slotId: sl.slotId,
        index: sl.index,
        sectionId: sl.section.id,
        offset: sl.offset,
        size: sl.size,
        alignBytes: sl.alignBytes,
        substrate: sl.substrate?.kind ?? 'memory-arena',
      })),
    }
  }

  public static generatePostgresDdl(def: SectionDefinition): string {
    const tableName = def.id.replace(/\./g, '_')
    const cols: string[] = []
    const indices: string[] = []

    const fieldEntries = Object.entries(def.fields) as Array<[string, FieldDef<any>]>
    for (const [name, field] of fieldEntries) {
      const sqlType = this.mapToPostgresType(field.type, field.precisionVal)
      const pk = field.isPrimaryKey ? ' PRIMARY KEY' : ''
      const notNull = !field.isNullable && !field.isOptional ? ' NOT NULL' : ''
      cols.push(`  "${name}" ${sqlType}${pk}${notNull}`)

      if (field.isIndexed && !field.isPrimaryKey) {
        indices.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_${name}" ON "${tableName}" ("${name}");`)
      }
    }

    const ddl = [
      `CREATE TABLE IF NOT EXISTS "${tableName}" (`,
      cols.join(',\n'),
      ');',
      ...indices,
    ].join('\n')

    return ddl
  }

  public static generateTimescaleDdl(def: SectionDefinition): string {
    const baseTable = this.generatePostgresDdl(def)
    const tableName = def.id.replace(/\./g, '_')
    const timeCol = def.storage?.partitionBy ?? 'timestamp'

    const timescaleStmt = `SELECT create_hypertable('${tableName}', '${timeCol}', if_not_exists => TRUE);`
    return `${baseTable}\n${timescaleStmt}`
  }

  public static generateSqliteDdl(def: SectionDefinition): string {
    const tableName = def.id.replace(/\./g, '_')
    const cols: string[] = []
    const indices: string[] = []

    const fieldEntries = Object.entries(def.fields) as Array<[string, FieldDef<any>]>
    for (const [name, field] of fieldEntries) {
      const sqlType = this.mapToSqliteType(field.type)
      const pk = field.isPrimaryKey ? ' PRIMARY KEY' : ''
      const notNull = !field.isNullable && !field.isOptional ? ' NOT NULL' : ''
      cols.push(`  "${name}" ${sqlType}${pk}${notNull}`)

      if (field.isIndexed && !field.isPrimaryKey) {
        indices.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_${name}" ON "${tableName}" ("${name}");`)
      }
    }

    return [
      `CREATE TABLE IF NOT EXISTS "${tableName}" (`,
      cols.join(',\n'),
      ');',
      ...indices,
    ].join('\n')
  }

  public static formatRedisKey(def: SectionDefinition, primaryKey: string): string {
    return `${def.id}:${primaryKey}`
  }

  private static mapToPostgresType(type: PrimitiveType, precision?: number): string {
    switch (type) {
      case 'string':
        return 'TEXT'
      case 'uuid':
        return 'UUID'
      case 'float64':
        return 'DOUBLE PRECISION'
      case 'int32':
        return 'INTEGER'
      case 'number':
        return precision ? `NUMERIC(18, ${precision})` : 'DOUBLE PRECISION'
      case 'timestamp':
        return 'BIGINT'
      case 'boolean':
        return 'BOOLEAN'
      case 'array':
      case 'record':
      case 'object':
        return 'JSONB'
    }
  }

  private static mapToSqliteType(type: PrimitiveType): string {
    switch (type) {
      case 'string':
      case 'uuid':
      case 'array':
      case 'record':
      case 'object':
        return 'TEXT'
      case 'int32':
      case 'timestamp':
      case 'boolean':
        return 'INTEGER'
      case 'float64':
      case 'number':
        return 'REAL'
    }
  }
}
