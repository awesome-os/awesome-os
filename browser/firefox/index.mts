/**
 * @file browser/firefox/index.mts
 * @description Public API for @awesome-os/firefox: Holo v11 CAS hydration,
 *   24/24 shared library verification, and zero-telemetry launch helpers.
 */

export {
  applyKeepLast5Pin,
  B8G_ABI_MAGIC_V3,
  ensureFirefoxBinary,
  fetchHoloIndex,
  getCasCacheDir,
  getFirefoxAssetKey,
  getFirefoxExecutableRelPath,
  HOLO_CAS_BASE_URL,
  HOLO_INDEX_URL,
  loadFirefoxProfile,
  loadMozconfig,
  MOZCONFIG_PATH,
  PROFILE_PATH,
  resolveFirefoxEntry,
  resolveV11BlobPath,
  tryResolveFirefoxEntry,
  verifySharedV11Deps,
  type FirefoxSharedLibEntry,
  type FirefoxV11Profile,
  type HoloCasEntry,
  type HoloCasHistoryItem,
  type HoloIndex,
  type HydratedFirefoxResult,
  type VerifyDepsResult,
} from './hydrate.mts';

export {
  buildLaunchPlan,
  DEFAULT_FIREFOX_FLAGS,
  FIREFOX_CLI_VERSION,
  parseCliArgs,
  runCli,
  type LaunchPlan,
  type ParsedCliArgs,
} from './cli.mts';
