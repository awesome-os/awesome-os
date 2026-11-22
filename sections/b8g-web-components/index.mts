/**
 * @file sections/b8g-web-components/index.mts
 * @description Canonical 6-tag `<b8g-*>` Streaming Web Components standard.
 *
 * Uses standard HTML5 `data-*` attributes (`el.dataset.*`) for all custom properties
 * (`data-kind`, `data-surface`, `data-liveness`, `data-op`, `data-with`, `data-src`,
 * `data-backend`, `data-accept`, `data-onmount`, `data-persona`, `data-locality`)
 * while preserving standard HTML attributes (`id`, `style`, `width`, `height`).
 *
 * Strictly portable: zero external dependencies, zero `node:*` imports,
 * `erasableSyntaxOnly: true`.
 */

import {
  defineSection,
  f,
  p,
  s,
  personaRank,
  localityRank,
  validateSectionShape,
  type ExecutionContext,
  type LocalityZone,
  type PersonaPlane,
  type SectionKind,
  type UiSurfaceBackend,
} from '../../packages/@awesome-os/stealify-schema/src/index.mts'

export { renderB8gWebComponentsRuntimeScript } from './browser-runtime.mts'

/**
 * The 6 canonical `<b8g-*>` Web Component tags.
 */
export const B8G_STANDARD_TAGS = [
  'b8g-section',
  'b8g-intersection',
  'b8g-stream',
  'b8g-surface',
  'b8g-dropzone',
  'b8g-gate',
] as const

export type B8gTagName = (typeof B8G_STANDARD_TAGS)[number]

export type B8gStreamLiveness = 'progress-bar' | 'overlay' | 'stream'
export type B8gIntersectionOp = 'wedge' | 'meet'

export interface B8gTagSpec {
  readonly tag: B8gTagName
  readonly attributes: readonly string[]
}

export const B8G_TAG_SPECS: Readonly<Record<B8gTagName, B8gTagSpec>> = Object.freeze({
  'b8g-section': Object.freeze({
    tag: 'b8g-section',
    attributes: Object.freeze(['id', 'data-kind', 'data-surface', 'data-liveness']),
  }),
  'b8g-intersection': Object.freeze({
    tag: 'b8g-intersection',
    attributes: Object.freeze(['data-op', 'data-with']),
  }),
  'b8g-stream': Object.freeze({
    tag: 'b8g-stream',
    attributes: Object.freeze(['data-src', 'data-liveness']),
  }),
  'b8g-surface': Object.freeze({
    tag: 'b8g-surface',
    attributes: Object.freeze(['data-backend', 'width', 'height']),
  }),
  'b8g-dropzone': Object.freeze({
    tag: 'b8g-dropzone',
    attributes: Object.freeze(['data-accept', 'data-onmount']),
  }),
  'b8g-gate': Object.freeze({
    tag: 'b8g-gate',
    attributes: Object.freeze(['data-persona', 'data-locality']),
  }),
})

export interface B8gMarkupNode {
  readonly tag: B8gTagName | (string & {})
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly B8gMarkupNode[]
  readonly textContent?: string
}

export interface B8gMarkupValidationResult {
  readonly valid: boolean
  readonly errors: string[]
}

const STANDARD_TAG_SET: ReadonlySet<string> = new Set<string>(B8G_STANDARD_TAGS)

const VALID_SECTION_KINDS: ReadonlySet<SectionKind> = new Set<SectionKind>([
  'ui-surface',
  'storage-cas',
  'compute-runtime',
  'game-sim',
  'devops-plane',
  'protocol-bridge',
])

const VALID_SURFACE_BACKENDS: ReadonlySet<UiSurfaceBackend> = new Set<UiSurfaceBackend>([
  'html-dom',
  'canvas-2d',
  'canvas-3d',
  'framebuffer',
  'unknown-framebuffer',
])

const VALID_LIVENESS: ReadonlySet<B8gStreamLiveness> = new Set<B8gStreamLiveness>([
  'progress-bar',
  'overlay',
  'stream',
])

const VALID_INTERSECTION_OPS: ReadonlySet<B8gIntersectionOp> = new Set<B8gIntersectionOp>([
  'wedge',
  'meet',
])

const VALID_PERSONAS: ReadonlySet<PersonaPlane> = new Set<PersonaPlane>([
  'consumer',
  'creator',
  'devops',
  'kernel-audit',
])

const VALID_LOCALITIES: ReadonlySet<LocalityZone> = new Set<LocalityZone>([
  'local-arena',
  'lan-peer',
  'sovereign-edge',
  'cloud-region',
])

function readDataAttr(attrs: Readonly<Record<string, string>>, key: string): string | undefined {
  return attrs[`data-${key}`] ?? attrs[key]
}

function parseAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(rawAttrs)) !== null) {
    const name = match[1]!.toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    attrs[name] = value
  }
  return attrs
}

interface MutableMarkupNode {
  tag: string
  attributes: Record<string, string>
  children: MutableMarkupNode[]
  textParts: string[]
}

function freezeNode(node: MutableMarkupNode): B8gMarkupNode {
  const text = node.textParts.join('').trim()
  const base: B8gMarkupNode = {
    tag: node.tag,
    attributes: Object.freeze({ ...node.attributes }),
    children: Object.freeze(node.children.map(freezeNode)),
    ...(text.length > 0 ? { textContent: text } : {}),
  }
  return Object.freeze(base)
}

/**
 * Lightweight zero-DOM parser extracting `<b8g-*>` tags, attributes, and nested children.
 * Non-`<b8g-*>` wrapper tags and HTML comments are transparently skipped while still
 * extracting any `<b8g-*>` descendants inside them.
 */
export function parseB8gMarkup(markup: string): B8gMarkupNode[] {
  const cleaned = markup.replace(/<!--[\s\S]*?-->/g, '')
  const roots: MutableMarkupNode[] = []
  const stack: MutableMarkupNode[] = []

  const tokenRe = /<(\/)?(b8g-[a-z0-9-]+)((?:\s+[^<>]*?)?)(\/)?>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(cleaned)) !== null) {
    const textChunk = cleaned.slice(lastIndex, match.index)
    if (textChunk.length > 0 && stack.length > 0) {
      const stripped = textChunk.replace(/<[^>]+>/g, '').trim()
      if (stripped.length > 0) {
        stack[stack.length - 1]!.textParts.push(stripped)
      }
    }
    lastIndex = tokenRe.lastIndex

    const isClosing = match[1] === '/'
    const tagName = match[2]!.toLowerCase()
    const rawAttrs = match[3] ?? ''
    const isSelfClosing = match[4] === '/'

    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.tag === tagName) {
          stack.length = i
          break
        }
      }
      continue
    }

    const node: MutableMarkupNode = {
      tag: tagName,
      attributes: parseAttributes(rawAttrs),
      children: [],
      textParts: [],
    }

    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(node)
    } else {
      roots.push(node)
    }

    if (!isSelfClosing) {
      stack.push(node)
    }
  }

  return roots.map(freezeNode)
}

/**
 * Enforces algebraic projection & collapse over parsed `<b8g-*>` markup nodes
 * for a given caller `ExecutionContext`:
 *   - Any `<b8g-gate data-persona="...">` where `personaRank(callerCtx.persona) < personaRank(gatePersona)`
 *     collapses cleanly to `0` nodes (removing the gate and its entire subtree).
 *   - Any `<b8g-gate data-locality="...">` where `localityRank(callerCtx.locality) > localityRank(gateLocality)`
 *     collapses cleanly to `0` nodes.
 *   - Any `<b8g-surface>` when `callerCtx.display === 'headless'` collapses cleanly to `0` nodes.
 */
export function projectB8gMarkup(
  nodes: readonly B8gMarkupNode[],
  callerCtx: ExecutionContext
): B8gMarkupNode[] {
  const projected: B8gMarkupNode[] = []
  const callerPersona: PersonaPlane = callerCtx.persona ?? 'consumer'

  for (const node of nodes) {
    if (node.tag === 'b8g-gate') {
      const gatePersonaAttr = readDataAttr(node.attributes, 'persona')
      if (gatePersonaAttr !== undefined && gatePersonaAttr.length > 0) {
        const gatePersona = VALID_PERSONAS.has(gatePersonaAttr as PersonaPlane)
          ? (gatePersonaAttr as PersonaPlane)
          : 'kernel-audit'
        if (personaRank(callerPersona) < personaRank(gatePersona)) {
          continue
        }
      }

      const gateLocalityAttr = readDataAttr(node.attributes, 'locality')
      if (gateLocalityAttr !== undefined && gateLocalityAttr.length > 0) {
        const gateLocality = VALID_LOCALITIES.has(gateLocalityAttr as LocalityZone)
          ? (gateLocalityAttr as LocalityZone)
          : 'local-arena'
        if (localityRank(callerCtx.locality) > localityRank(gateLocality)) {
          continue
        }
      }
    }

    if (node.tag === 'b8g-surface' && callerCtx.display === 'headless') {
      continue
    }

    const projectedChildren = projectB8gMarkup(node.children, callerCtx)
    projected.push(
      Object.freeze({
        tag: node.tag,
        attributes: node.attributes,
        children: Object.freeze(projectedChildren),
        ...(node.textContent !== undefined ? { textContent: node.textContent } : {}),
      })
    )
  }

  return projected
}

/**
 * Validates parsed `<b8g-*>` markup trees against the canonical 6-tag schema,
 * `SectionKind`, `UiSurfaceBackend`, and `validateSectionShape`.
 */
export function validateB8gMarkup(nodes: readonly B8gMarkupNode[]): B8gMarkupValidationResult {
  const errors: string[] = []

  function visit(node: B8gMarkupNode, path: string): void {
    const label = `${path}/${node.tag}`

    if (!STANDARD_TAG_SET.has(node.tag)) {
      errors.push(`${label}: unknown b8g tag "${node.tag}" (expected one of ${B8G_STANDARD_TAGS.join(', ')})`)
    }

    if (node.tag === 'b8g-section') {
      const kind = readDataAttr(node.attributes, 'kind')
      const surface = readDataAttr(node.attributes, 'surface')
      const liveness = readDataAttr(node.attributes, 'liveness')

      if (kind !== undefined && kind.length > 0 && !VALID_SECTION_KINDS.has(kind as SectionKind)) {
        errors.push(`${label}: invalid SectionKind "${kind}"`)
      }

      if (surface !== undefined && surface.length > 0 && !VALID_SURFACE_BACKENDS.has(surface as UiSurfaceBackend)) {
        errors.push(`${label}: invalid UiSurfaceBackend "${surface}"`)
      }

      if (liveness !== undefined && liveness.length > 0 && !VALID_LIVENESS.has(liveness as B8gStreamLiveness)) {
        errors.push(`${label}: invalid liveness "${liveness}"`)
      }

      if (kind === 'ui-surface' && surface !== undefined && surface.length > 0) {
        const shapeViolations = validateSectionShape('ui-surface', {
          surface,
          liveness: (liveness && liveness.length > 0 ? liveness : 'stream') as B8gStreamLiveness,
          htmlTagged: surface === 'html-dom' ? true : undefined,
          actions: ['render'],
        })
        for (const v of shapeViolations) {
          errors.push(`${label}: ${v}`)
        }
      }
    } else if (node.tag === 'b8g-intersection') {
      const op = readDataAttr(node.attributes, 'op')
      if (op !== undefined && op.length > 0 && !VALID_INTERSECTION_OPS.has(op as B8gIntersectionOp)) {
        errors.push(`${label}: invalid intersection op "${op}" (expected "wedge" | "meet")`)
      }
    } else if (node.tag === 'b8g-stream') {
      const liveness = readDataAttr(node.attributes, 'liveness')
      if (liveness !== undefined && liveness.length > 0 && !VALID_LIVENESS.has(liveness as B8gStreamLiveness)) {
        errors.push(`${label}: invalid stream liveness "${liveness}"`)
      }
    } else if (node.tag === 'b8g-surface') {
      const backend = readDataAttr(node.attributes, 'backend')
      if (backend !== undefined && backend.length > 0 && !VALID_SURFACE_BACKENDS.has(backend as UiSurfaceBackend)) {
        errors.push(`${label}: invalid surface backend "${backend}"`)
      }
    } else if (node.tag === 'b8g-gate') {
      const persona = readDataAttr(node.attributes, 'persona')
      if (persona !== undefined && persona.length > 0 && !VALID_PERSONAS.has(persona as PersonaPlane)) {
        errors.push(`${label}: invalid gate persona "${persona}"`)
      }
      const locality = readDataAttr(node.attributes, 'locality')
      if (locality !== undefined && locality.length > 0 && !VALID_LOCALITIES.has(locality as LocalityZone)) {
        errors.push(`${label}: invalid gate locality "${locality}"`)
      }
    }

    for (let i = 0; i < node.children.length; i += 1) {
      visit(node.children[i]!, `${label}[${i}]`)
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    visit(nodes[i]!, `[${i}]`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Canonical Section definition for the 6-tag `<b8g-*>` Streaming Web Components surface.
 */
export const B8gWebComponentsSection = defineSection({
  id: 'b8g.web.components',
  version: '1.0.0',
  description: 'Canonical 6-tag <b8g-*> Streaming Web Components standard (parse, validate, project, browser runtime).',
  kind: 'ui-surface',
  shape: {
    surface: 'html-dom',
    liveness: 'stream',
    htmlTagged: true,
    actions: ['register', 'parse', 'project'],
  },
  substrate: s.httpOrigin({ basePath: '/b8g-web-components' }),
  fields: {
    registeredTags: f.array('string').default(() => [...B8G_STANDARD_TAGS]),
    activeStreams: f.int32().default(0),
    lastProjectedNodeCount: f.int32().default(0),
    runtimeVersion: f.string().default('1.0.0'),
  },
  protocols: {
    markupIn: p.input('http', '/b8g-web-components/markup'),
    runtimeOut: p.output('http', '/b8g-web-components/runtime.js'),
  },
  ops: {
    register(ctx, input: { readonly tags?: readonly string[] } = {}) {
      const tags = input.tags ? [...input.tags] : [...B8G_STANDARD_TAGS]
      ctx.patchState({ registeredTags: tags })
      return { registered: tags }
    },
    parse(_ctx, input: { readonly markup: string }) {
      const nodes = parseB8gMarkup(input.markup)
      const validation = validateB8gMarkup(nodes)
      return { nodes, validation }
    },
    project(ctx, input: { readonly markup: string; readonly callerCtx: ExecutionContext }) {
      const parsed = parseB8gMarkup(input.markup)
      const projected = projectB8gMarkup(parsed, input.callerCtx)
      ctx.patchState({ lastProjectedNodeCount: projected.length })
      return { nodes: projected }
    },
  },
})
