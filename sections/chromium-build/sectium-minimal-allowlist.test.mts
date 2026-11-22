import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DROPPED_CHROME_BLOAT_SUBSYSTEMS,
  SECTIUM_AUTARKIC_PROFILE,
  SECTIUM_MINIMAL_SPARSE_PATHS,
  SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST,
  classifyChromiumPath,
  generateSparseCheckoutPatterns,
} from './sectium-minimal-allowlist.mts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = resolve(
  __dirname,
  '..',
  '..',
  'intersections',
  'b8g-upstream-maintainer',
  'registry.json',
)

test('SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST defines exactly 7 frozen core subtrees with all 16 canonical paths', () => {
  assert.equal(SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST.length, 7)
  assert.ok(Object.isFrozen(SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST))

  const flatPaths = SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST.flatMap((s) => [...s.paths])
  assert.deepEqual(flatPaths, [
    'v8/',
    'third_party/blink/renderer/',
    'third_party/skia/',
    'third_party/dawn/',
    'third_party/angle/',
    'components/viz/',
    'gpu/',
    'ui/gfx/',
    'ui/aura/',
    'net/',
    'crypto/',
    'third_party/boringssl/',
    'base/',
    'third_party/ipcz/',
    'mojo/',
    'tools/clang/',
  ])

  for (const subtree of SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST) {
    assert.ok(Object.isFrozen(subtree))
    assert.ok(Object.isFrozen(subtree.paths))
    assert.ok(subtree.id.length > 0)
    assert.ok(subtree.layer.length > 0)
    assert.ok(subtree.rationale.length > 0)
  }
})

test('DROPPED_CHROME_BLOAT_SUBSYSTEMS maps all 12 bloated Chrome paths to sovereign Awesome-OS replacements', () => {
  assert.ok(Object.isFrozen(DROPPED_CHROME_BLOAT_SUBSYSTEMS))
  assert.equal(Object.keys(DROPPED_CHROME_BLOAT_SUBSYSTEMS).length, 12)

  assert.equal(DROPPED_CHROME_BLOAT_SUBSYSTEMS['chrome/browser/ash'], 'dropped')
  assert.equal(DROPPED_CHROME_BLOAT_SUBSYSTEMS['chrome/android'], 'dropped')
  assert.equal(DROPPED_CHROME_BLOAT_SUBSYSTEMS['ios'], 'dropped')
  assert.equal(DROPPED_CHROME_BLOAT_SUBSYSTEMS['fuchsia_web'], 'dropped')
  assert.equal(DROPPED_CHROME_BLOAT_SUBSYSTEMS['components/autofill'], 'CloudCredentialVault')
  assert.equal(
    DROPPED_CHROME_BLOAT_SUBSYSTEMS['components/sync'],
    'CasModuleRegistry + CloudDeviceMesh',
  )
  assert.equal(
    DROPPED_CHROME_BLOAT_SUBSYSTEMS['components/safe_browsing'],
    '7-tuple C_cloud + CloudEdgePlane',
  )
  assert.equal(
    DROPPED_CHROME_BLOAT_SUBSYSTEMS['components/optimization_guide'],
    'globalThis.ai Sovereign Bridge',
  )
  assert.equal(
    DROPPED_CHROME_BLOAT_SUBSYSTEMS['components/password_manager'],
    'CloudCredentialVault',
  )
  assert.equal(
    DROPPED_CHROME_BLOAT_SUBSYSTEMS['components/translate'],
    'globalThis.ai Sovereign Bridge',
  )
  assert.equal(DROPPED_CHROME_BLOAT_SUBSYSTEMS['chrome/updater'], 'b8g-upstream-maintainer')
  assert.equal(
    DROPPED_CHROME_BLOAT_SUBSYSTEMS['third_party/tflite_support'],
    'globalThis.ai Sovereign Bridge',
  )
})

test('classifyChromiumPath accurately classifies keep-core, drop-bloat, and neutral paths across POSIX and Windows formats', () => {
  // Core subtree exact & nested matches
  assert.equal(classifyChromiumPath('v8'), 'keep-core')
  assert.equal(classifyChromiumPath('v8/src/api/api.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('third_party\\blink\\renderer\\core\\dom\\node.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('./third_party/skia/src/core/SkCanvas.cpp'), 'keep-core')
  assert.equal(classifyChromiumPath('/third_party/dawn/src/dawn/native/Device.cpp'), 'keep-core')
  assert.equal(classifyChromiumPath('third_party/angle/src/libANGLE/Context.cpp'), 'keep-core')
  assert.equal(classifyChromiumPath('components/viz/service/display/display.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('gpu/command_buffer/service/gles2_cmd_decoder.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('ui/gfx/geometry/rect.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('ui/aura/window.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('net/http/http_network_transaction.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('crypto/sha2.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('third_party/boringssl/src/ssl/tls13_client.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('base/memory/raw_ptr.h'), 'keep-core')
  assert.equal(classifyChromiumPath('third_party/ipcz/src/ipcz/node.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('mojo/core/core.cc'), 'keep-core')
  assert.equal(classifyChromiumPath('tools/clang/scripts/update.py'), 'keep-core')

  // Dropped bloat exact & nested matches
  assert.equal(classifyChromiumPath('chrome/browser/ash/login/session.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('chrome\\android\\java\\ChromeActivity.java'), 'drop-bloat')
  assert.equal(classifyChromiumPath('ios/chrome/app/main.mm'), 'drop-bloat')
  assert.equal(classifyChromiumPath('fuchsia_web/runners/cast/main.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('components/autofill/core/browser/autofill_manager.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('components/sync/engine/sync_engine.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('components/safe_browsing/core/browser/db.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('components/optimization_guide/core/model.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('components/password_manager/core/browser/store.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('components/translate/core/browser/translate.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('chrome/updater/updater.cc'), 'drop-bloat')
  assert.equal(classifyChromiumPath('third_party/tflite_support/src/task.cc'), 'drop-bloat')

  // Boundary safety: sibling prefix names must NOT false-match
  assert.equal(classifyChromiumPath('v8_inspector_extra/foo.cc'), 'neutral')
  assert.equal(classifyChromiumPath('base_unittests_extra/bar.cc'), 'neutral')
  assert.equal(classifyChromiumPath('ios_compat/stub.cc'), 'neutral')
  assert.equal(classifyChromiumPath('net_experimental/baz.cc'), 'neutral')
  assert.equal(classifyChromiumPath('gpu_custom/test.cc'), 'neutral')

  // Neutral root & unmapped paths
  assert.equal(classifyChromiumPath(''), 'neutral')
  assert.equal(classifyChromiumPath('/'), 'neutral')
  assert.equal(classifyChromiumPath('BUILD.gn'), 'neutral')
  assert.equal(classifyChromiumPath('DEPS'), 'neutral')
  assert.equal(classifyChromiumPath('content/browser/web_contents/web_contents_impl.cc'), 'neutral')
})

test('generateSparseCheckoutPatterns emits 16 positive core patterns and 12 negative bloat exclusions', () => {
  const patterns = generateSparseCheckoutPatterns()
  const patterns2 = generateSparseCheckoutPatterns()
  assert.notEqual(patterns, patterns2, 'must return a fresh array copy')
  assert.equal(patterns.length, 16 + 12)
  assert.equal(new Set(patterns).size, patterns.length, 'patterns must be deduplicated')

  const includes = patterns.filter((p) => !p.startsWith('!'))
  const excludes = patterns.filter((p) => p.startsWith('!'))
  assert.equal(includes.length, 16)
  assert.equal(excludes.length, 12)

  for (const p of includes) {
    assert.ok(p.endsWith('/'), `include pattern must end with '/': ${p}`)
    assert.equal(classifyChromiumPath(p), 'keep-core')
  }
  for (const p of excludes) {
    assert.ok(p.endsWith('/'), `exclude pattern must end with '/': ${p}`)
    assert.equal(classifyChromiumPath(p.slice(1)), 'drop-bloat')
  }
})

test('b8g-upstream-maintainer registry.json chromium entry pins autarkicProfile and sparsePaths cleanly', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
    upstreams: Array<{
      id: string
      autarkicProfile?: string
      sparsePaths?: string[]
    }>
  }

  assert.equal(registry.upstreams.length, 12)
  const chromium = registry.upstreams.find((u) => u.id === 'chromium')
  assert.ok(chromium, 'chromium upstream entry must exist')
  assert.equal(chromium.autarkicProfile, SECTIUM_AUTARKIC_PROFILE)
  assert.deepEqual(chromium.sparsePaths, [...SECTIUM_MINIMAL_SPARSE_PATHS])
})
