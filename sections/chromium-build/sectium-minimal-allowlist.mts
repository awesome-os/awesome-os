/**
 * @file sections/chromium-build/sectium-minimal-allowlist.mts
 * @description Canonical 7-Subtree minimal upstream Chromium allowlist and
 * dropped Chrome bloat subsystem ledger for **Sectium** (`sectium-minimal-7`).
 *
 * Sectium tracks ONLY the lean core substrate needed from upstream Chromium
 * while dropping all replaced or bloated Chrome/Google subsystems in favor of
 * sovereign Awesome-OS components.
 *
 * Strictly `types: []`, `erasableSyntaxOnly: true`, zero external dependencies.
 */

export type ChromiumPathClassification = 'keep-core' | 'drop-bloat' | 'neutral'

export type SovereignReplacement =
  | 'CloudCredentialVault'
  | 'CasModuleRegistry + CloudDeviceMesh'
  | '7-tuple C_cloud + CloudEdgePlane'
  | 'globalThis.ai Sovereign Bridge'
  | 'b8g-upstream-maintainer'
  | 'dropped'

export interface SectiumAllowlistSubtree {
  readonly id: string
  readonly layer: string
  readonly paths: readonly string[]
  readonly rationale: string
}

export const SECTIUM_AUTARKIC_PROFILE = 'sectium-minimal-7' as const

/**
 * The 7 lean core upstream Chromium subtrees retained by Sectium.
 */
export const SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST: readonly SectiumAllowlistSubtree[] = Object.freeze([
  Object.freeze({
    id: 'v8',
    layer: 'JavaScript & WebAssembly Engine',
    paths: Object.freeze(['v8/']),
    rationale: 'Core V8 JS/WASM execution engine and B8G_ARENA_V1 host substrate.',
  }),
  Object.freeze({
    id: 'blink-renderer',
    layer: 'Blink Rendering Engine',
    paths: Object.freeze(['third_party/blink/renderer/']),
    rationale: 'HTML/CSS/DOM layout, style, and Blink fastpath rendering core.',
  }),
  Object.freeze({
    id: 'graphics-stack',
    layer: '2D / WebGPU / 3D Graphics Stack',
    paths: Object.freeze(['third_party/skia/', 'third_party/dawn/', 'third_party/angle/']),
    rationale: 'Skia 2D rasterizer, Dawn WebGPU implementation, and ANGLE GL/Vulkan translation.',
  }),
  Object.freeze({
    id: 'compositor-ui',
    layer: 'Compositor, GPU Service & Windowing',
    paths: Object.freeze(['components/viz/', 'gpu/', 'ui/gfx/', 'ui/aura/']),
    rationale: 'Viz display compositor, GPU command buffer, gfx primitives, and Aura windowing.',
  }),
  Object.freeze({
    id: 'net-crypto',
    layer: 'Networking & Cryptography',
    paths: Object.freeze(['net/', 'crypto/', 'third_party/boringssl/']),
    rationale: 'HTTP/QUIC network stack, crypto primitives, and BoringSSL TLS engine.',
  }),
  Object.freeze({
    id: 'base-ipc',
    layer: 'Base Runtime & IPC Transport',
    paths: Object.freeze(['base/', 'third_party/ipcz/', 'mojo/']),
    rationale: 'Base threading/memory utilities, ipcz zero-copy IPC, and Mojo bindings.',
  }),
  Object.freeze({
    id: 'clang-toolchain',
    layer: 'Hermetic Clang/LLVM Toolchain Scripts',
    paths: Object.freeze(['tools/clang/']),
    rationale: 'Upstream Clang/LLVM pin and hermetic toolchain update scripts.',
  }),
])

/**
 * Upstream Chrome subsystems explicitly dropped from Sectium, mapped to their
 * sovereign Awesome-OS replacement (or `'dropped'` when platform-irrelevant).
 */
export const DROPPED_CHROME_BLOAT_SUBSYSTEMS: Readonly<Record<string, SovereignReplacement>> =
  Object.freeze({
    'chrome/browser/ash': 'dropped',
    'chrome/android': 'dropped',
    ios: 'dropped',
    fuchsia_web: 'dropped',
    'components/autofill': 'CloudCredentialVault',
    'components/sync': 'CasModuleRegistry + CloudDeviceMesh',
    'components/safe_browsing': '7-tuple C_cloud + CloudEdgePlane',
    'components/optimization_guide': 'globalThis.ai Sovereign Bridge',
    'components/password_manager': 'CloudCredentialVault',
    'components/translate': 'globalThis.ai Sovereign Bridge',
    'chrome/updater': 'b8g-upstream-maintainer',
    'third_party/tflite_support': 'globalThis.ai Sovereign Bridge',
  })

/**
 * Flat list of all canonical core allowlist paths (without trailing slash)
 * for direct consumption by `registry.json` `sparsePaths` and tooling.
 */
export const SECTIUM_MINIMAL_SPARSE_PATHS: readonly string[] = Object.freeze(
  SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST.flatMap((subtree) =>
    subtree.paths.map((p) => p.replace(/\/+$/, '')),
  ),
)

const NORMALIZED_CORE_PREFIXES: readonly string[] = SECTIUM_MINIMAL_SPARSE_PATHS
const NORMALIZED_BLOAT_PREFIXES: readonly string[] = Object.freeze(
  Object.keys(DROPPED_CHROME_BLOAT_SUBSYSTEMS).map((p) => p.replace(/\/+$/, '')),
)

function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
}

function matchesPrefix(normalizedPath: string, prefix: string): boolean {
  return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
}

/**
 * Classifies a Chromium-relative path against the 7-subtree core allowlist
 * and the dropped Chrome bloat subsystem ledger.
 */
export function classifyChromiumPath(relPath: string): ChromiumPathClassification {
  const normalized = normalizeRelPath(relPath)
  if (normalized.length === 0) {
    return 'neutral'
  }

  for (const corePrefix of NORMALIZED_CORE_PREFIXES) {
    if (matchesPrefix(normalized, corePrefix)) {
      return 'keep-core'
    }
  }

  for (const bloatPrefix of NORMALIZED_BLOAT_PREFIXES) {
    if (matchesPrefix(normalized, bloatPrefix)) {
      return 'drop-bloat'
    }
  }

  return 'neutral'
}

/**
 * Generates deterministic git sparse-checkout patterns:
 * positive inclusions for all 7 core subtrees followed by explicit `!`
 * exclusions for all dropped Chrome bloat subsystems.
 */
export function generateSparseCheckoutPatterns(): string[] {
  const includePatterns = SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST.flatMap((subtree) =>
    subtree.paths.map((p) => (p.endsWith('/') ? p : `${p}/`)),
  )
  const excludePatterns = NORMALIZED_BLOAT_PREFIXES.map((p) => `!${p}/`)
  return [...includePatterns, ...excludePatterns]
}
