/** 第三方扩展的公共入口：manifest 校验、安装/列表/卸载、GitHub 搜索。 */

export {
  EXTENSION_ID_RE,
  EXTENSION_PROVIDES,
  EXTENSION_VERSION_RE,
  ManifestError,
  V2_MANIFEST_FILE,
  isValidEntryName,
  isValidExtensionId,
  isValidExtensionVersion,
  parseManifest,
} from "./manifest.js";
export type {
  ExtensionBackend,
  ExtensionFetchChannel,
  ExtensionManifest,
  ExtensionManifestV2,
  ExtensionProvide,
  ExtensionSearchEngine,
} from "./manifest.js";

export {
  extensionsDir,
  installExtension,
  isValidRepo,
  listExtensions,
  loadInstalledManifest,
  parseChecksums,
  removeExtension,
  searchExtensions,
} from "./install.js";
export { loadExtensions } from "./loader.js";
export type { LoadExtensionsOptions, LoadedExtensions } from "./loader.js";
export type { PluginBackendState, PluginBackends } from "./paths.js";
export type {
  Download,
  ExtensionSearchItem,
  FetchJson,
  InstalledExtension,
  InstalledExtensionInfo,
  InstallDeps,
  InstallExtensionOptions,
  RequestOptions,
  SearchExtensionsOptions,
  Sha256File,
} from "./install.js";
