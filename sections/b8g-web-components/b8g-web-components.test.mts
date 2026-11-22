/**
 * @file sections/b8g-web-components/b8g-web-components.test.mts
 * @description Verification suite for the canonical 6-tag `<b8g-*>` Streaming Web Components standard
 * using HTML5 `data-*` attributes (`el.dataset.*`).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  B8G_STANDARD_TAGS,
  B8G_TAG_SPECS,
  B8gWebComponentsSection,
  parseB8gMarkup,
  projectB8gMarkup,
  validateB8gMarkup,
  renderB8gWebComponentsRuntimeScript,
} from './index.mts'
import type { ExecutionContext } from '../../packages/@awesome-os/stealify-schema/src/index.mts'

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    boundary: 'in-process',
    display: 'interactive-fg',
    lifetime: 'window-bound',
    transport: 'arena-sab',
    capability: {
      tenantId: 'tenant-test',
      scopes: ['*'],
      epoch: 1,
    },
    locality: 'local-arena',
    persona: 'consumer',
    ...overrides,
  }
}

describe('B8gWebComponentsSection & 6-tag standard', () => {
  it('defines B8gWebComponentsSection with canonical ui-surface shape, 6 tags, and HTML5 data-* attribute specs', () => {
    assert.equal(B8gWebComponentsSection.id, 'b8g.web.components')
    assert.equal(B8gWebComponentsSection.version, '1.0.0')
    assert.equal(B8gWebComponentsSection.kind, 'ui-surface')
    assert.deepEqual(B8gWebComponentsSection.shape, {
      surface: 'html-dom',
      liveness: 'stream',
      htmlTagged: true,
      actions: ['register', 'parse', 'project'],
    })
    assert.deepEqual([...B8G_STANDARD_TAGS], [
      'b8g-section',
      'b8g-intersection',
      'b8g-stream',
      'b8g-surface',
      'b8g-dropzone',
      'b8g-gate',
    ])
    assert.equal(Object.keys(B8G_TAG_SPECS).length, 6)
    assert.deepEqual([...B8G_TAG_SPECS['b8g-section'].attributes], ['id', 'data-kind', 'data-surface', 'data-liveness'])
    assert.deepEqual([...B8G_TAG_SPECS['b8g-intersection'].attributes], ['data-op', 'data-with'])
    assert.deepEqual([...B8G_TAG_SPECS['b8g-stream'].attributes], ['data-src', 'data-liveness'])
    assert.deepEqual([...B8G_TAG_SPECS['b8g-surface'].attributes], ['data-backend', 'width', 'height'])
    assert.deepEqual([...B8G_TAG_SPECS['b8g-dropzone'].attributes], ['data-accept', 'data-onmount'])
    assert.deepEqual([...B8G_TAG_SPECS['b8g-gate'].attributes], ['data-persona', 'data-locality'])
  })

  it('parses nested <b8g-*> tags, HTML5 data-* attributes, self-closing tags, and ignores comments/wrapper HTML', () => {
    const markup = `
      <!-- header comment -->
      <div class="host-wrapper">
        <b8g-section id="desktop.hud" data-kind="ui-surface" data-surface="html-dom" data-liveness="stream">
          <b8g-intersection data-op="wedge" data-with="telemetry,display">
            <b8g-stream data-src="/events/hud" data-liveness="overlay" />
            <b8g-surface data-backend="canvas-3d" width="1280" height="720"></b8g-surface>
          </b8g-intersection>
          <b8g-dropzone data-accept=".b8p,.wasm" data-onmount="loadPack"></b8g-dropzone>
          <b8g-gate data-persona="devops" data-locality="local-arena">
            <b8g-stream data-src="/debug/traces" data-liveness="stream"></b8g-stream>
          </b8g-gate>
        </b8g-section>
      </div>
    `
    const nodes = parseB8gMarkup(markup)
    assert.equal(nodes.length, 1)

    const section = nodes[0]!
    assert.equal(section.tag, 'b8g-section')
    assert.equal(section.attributes['id'], 'desktop.hud')
    assert.equal(section.attributes['data-kind'], 'ui-surface')
    assert.equal(section.attributes['data-surface'], 'html-dom')
    assert.equal(section.attributes['data-liveness'], 'stream')
    assert.equal(section.children.length, 3)

    const intersection = section.children[0]!
    assert.equal(intersection.tag, 'b8g-intersection')
    assert.equal(intersection.attributes['data-op'], 'wedge')
    assert.equal(intersection.attributes['data-with'], 'telemetry,display')
    assert.equal(intersection.children.length, 2)
    assert.equal(intersection.children[0]!.tag, 'b8g-stream')
    assert.equal(intersection.children[0]!.attributes['data-src'], '/events/hud')
    assert.equal(intersection.children[1]!.tag, 'b8g-surface')
    assert.equal(intersection.children[1]!.attributes['data-backend'], 'canvas-3d')
    assert.equal(intersection.children[1]!.attributes['width'], '1280')

    const dropzone = section.children[1]!
    assert.equal(dropzone.tag, 'b8g-dropzone')
    assert.equal(dropzone.attributes['data-accept'], '.b8p,.wasm')
    assert.equal(dropzone.attributes['data-onmount'], 'loadPack')

    const gate = section.children[2]!
    assert.equal(gate.tag, 'b8g-gate')
    assert.equal(gate.attributes['data-persona'], 'devops')
    assert.equal(gate.attributes['data-locality'], 'local-arena')
    assert.equal(gate.children.length, 1)
    assert.equal(gate.children[0]!.tag, 'b8g-stream')
  })

  it('collapses <b8g-gate data-persona="devops"> to 0 nodes for consumer/creator callers and preserves for devops/kernel-audit', () => {
    const markup = `
      <b8g-gate data-persona="devops">
        <b8g-section id="debug.panel" data-kind="devops-plane">
          <b8g-stream data-src="/debug/flamegraph" data-liveness="stream" />
        </b8g-section>
      </b8g-gate>
    `
    const parsed = parseB8gMarkup(markup)
    assert.equal(parsed.length, 1)

    const consumerProjected = projectB8gMarkup(parsed, makeContext({ persona: 'consumer' }))
    assert.equal(consumerProjected.length, 0)

    const creatorProjected = projectB8gMarkup(parsed, makeContext({ persona: 'creator' }))
    assert.equal(creatorProjected.length, 0)

    const devopsProjected = projectB8gMarkup(parsed, makeContext({ persona: 'devops' }))
    assert.equal(devopsProjected.length, 1)
    assert.equal(devopsProjected[0]!.children.length, 1)

    const auditProjected = projectB8gMarkup(parsed, makeContext({ persona: 'kernel-audit' }))
    assert.equal(auditProjected.length, 1)
  })

  it('collapses <b8g-gate data-locality="local-arena"> to 0 nodes for remote callers', () => {
    const parsed = parseB8gMarkup('<b8g-gate data-locality="local-arena"><b8g-stream data-src="/local" /></b8g-gate>')
    assert.equal(projectB8gMarkup(parsed, makeContext({ locality: 'cloud-region' })).length, 0)
    assert.equal(projectB8gMarkup(parsed, makeContext({ locality: 'local-arena' })).length, 1)
  })

  it('collapses <b8g-surface> to 0 nodes when caller display is headless', () => {
    const markup = `
      <b8g-section id="viewport" data-kind="ui-surface" data-surface="canvas-2d" data-liveness="stream">
        <b8g-surface data-backend="canvas-2d" width="800" height="600" />
        <b8g-stream data-src="/frames" data-liveness="progress-bar" />
      </b8g-section>
    `
    const parsed = parseB8gMarkup(markup)

    // Top-level surface collapses directly to 0 nodes
    const directSurface = parseB8gMarkup('<b8g-surface data-backend="canvas-3d" width="640" height="480" />')
    assert.equal(projectB8gMarkup(directSurface, makeContext({ display: 'headless' })).length, 0)
    assert.equal(projectB8gMarkup(directSurface, makeContext({ display: 'interactive-fg' })).length, 1)

    // Nested surface inside b8g-section collapses while sibling b8g-stream survives
    const headlessProjected = projectB8gMarkup(parsed, makeContext({ display: 'headless' }))
    assert.equal(headlessProjected.length, 1)
    assert.equal(headlessProjected[0]!.children.length, 1)
    assert.equal(headlessProjected[0]!.children[0]!.tag, 'b8g-stream')
  })

  it('validates b8g-section data-kind & data-surface and rejects invalid attributes', () => {
    const validNodes = parseB8gMarkup(`
      <b8g-section id="app.main" data-kind="ui-surface" data-surface="html-dom" data-liveness="stream">
        <b8g-intersection data-op="meet" data-with="auth" />
        <b8g-surface data-backend="canvas-2d" width="320" height="240" />
        <b8g-stream data-src="/live" data-liveness="progress-bar" />
        <b8g-gate data-persona="creator" data-locality="lan-peer" />
      </b8g-section>
    `)
    const ok = validateB8gMarkup(validNodes)
    assert.equal(ok.valid, true)
    assert.deepEqual(ok.errors, [])

    const invalidNodes = parseB8gMarkup(`
      <b8g-section id="bad" data-kind="not-a-kind" data-surface="bogus-gpu" data-liveness="forever">
        <b8g-intersection data-op="xor" />
        <b8g-surface data-backend="ascii-art" />
        <b8g-gate data-persona="root-god" data-locality="mars" />
        <b8g-unknown />
      </b8g-section>
    `)
    const bad = validateB8gMarkup(invalidNodes)
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.some((e) => e.includes('invalid SectionKind')))
    assert.ok(bad.errors.some((e) => e.includes('invalid UiSurfaceBackend')))
    assert.ok(bad.errors.some((e) => e.includes('invalid intersection op')))
    assert.ok(bad.errors.some((e) => e.includes('invalid surface backend')))
    assert.ok(bad.errors.some((e) => e.includes('invalid gate persona')))
    assert.ok(bad.errors.some((e) => e.includes('invalid gate locality')))
    assert.ok(bad.errors.some((e) => e.includes('unknown b8g tag')))
  })

  it('renders a syntactically valid browser runtime script defining all 6 custom elements with data-* attributes', () => {
    const script = renderB8gWebComponentsRuntimeScript()
    assert.equal(typeof script, 'string')
    assert.ok(script.length > 500)

    // Syntax check via new Function() and safe no-op execution in headless Node (no customElements)
    const fn = new Function(script)
    assert.doesNotThrow(() => fn())

    for (const tag of B8G_STANDARD_TAGS) {
      assert.ok(script.includes(`'${tag}'`), `Runtime script must register <${tag}>`)
    }
    assert.ok(script.includes('customElements.define'))
    assert.ok(script.includes('AbortController'))
    assert.ok(script.includes('disconnectedCallback'))
    assert.ok(script.includes('b8g-drop'))
    assert.ok(script.includes('canvas-2d'))
    assert.ok(script.includes('canvas-3d'))
    assert.ok(script.includes('b8gPersona'))
    assert.ok(script.includes('data-kind'))
    assert.ok(script.includes('data-surface'))
    assert.ok(script.includes('data-backend'))
    assert.ok(script.includes('data-persona'))
    assert.ok(script.includes('data-src'))
  })
})
