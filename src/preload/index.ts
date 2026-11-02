import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH, EV } from '../shared/ipc'
import type { DshConsoleApi, ToastPayload } from '../shared/ipc'
import type {
  AppSettings,
  DiscoveryStep,
  DshActionResult,
  DshStatus,
  ManifestExportResult,
  ManifestPreview,
  PluginIconResult,
  MarketList,
  GalleryResult,
  ProxyTestResult,
  ProvisionProgress,
  ProvisionResult,
  RuntimeSourceInfo,
  VersionList,
  InstallPreview,
  OpLogLine,
  OpRequest,
  OpResult,
  ParsedSpec,
  PluginRecord,
  ProfileSummary,
  RegistryPackument,
  RuntimeInfo,
  SearchHit,
  ThemeFileResult,
  ThemeSpec,
  UpdateCheckProgress,
  WallpaperAutoFit,
  WallpaperEntry,
  WallpaperImportResult,
  WindowState
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: DshConsoleApi = {
  runtimeInfo: () => ipcRenderer.invoke(CH.runtimeInfo) as Promise<RuntimeInfo>,
  profiles: () => ipcRenderer.invoke(CH.profiles) as Promise<ProfileSummary[]>,
  plugins: (profile, opts) => ipcRenderer.invoke(CH.plugins, profile, opts) as Promise<PluginRecord[]>,

  checkUpdates: (profile, names) =>
    ipcRenderer.invoke(CH.checkUpdates, profile, names) as Promise<Record<string, PluginRecord>>,
  registryLookup: (profile, name) =>
    ipcRenderer.invoke(CH.registryLookup, profile, name) as Promise<RegistryPackument>,
  registrySearch: (query, limit) =>
    ipcRenderer.invoke(CH.registrySearch, query, limit) as Promise<SearchHit[]>,

  parseSpec: (input) => ipcRenderer.invoke(CH.parseSpec, input) as Promise<ParsedSpec>,
  installPreview: (profile, input) =>
    ipcRenderer.invoke(CH.installPreview, profile, input) as Promise<InstallPreview>,

  runOp: (req: OpRequest) => ipcRenderer.invoke(CH.runOp, req) as Promise<OpResult>,
  cancelOp: (opId) => ipcRenderer.invoke(CH.cancelOp, opId) as Promise<boolean>,

  revealPath: (target) => ipcRenderer.invoke(CH.revealPath, target) as Promise<boolean>,
  openExternal: (url) => ipcRenderer.invoke(CH.openExternal, url) as Promise<boolean>,
  restartDsh: () =>
    ipcRenderer.invoke(CH.restartDsh) as Promise<{ ok: boolean; message: string }>,

  settingsGet: () => ipcRenderer.invoke(CH.settingsGet) as Promise<AppSettings>,
  settingsSet: (patch) => ipcRenderer.invoke(CH.settingsSet, patch) as Promise<AppSettings>,
  probeDir: (dir) =>
    ipcRenderer.invoke(CH.probeDir, dir) as Promise<{
      ok: boolean
      exists: boolean
      isDir: boolean
      note: string
    }>,

  versions: (input, opts) => ipcRenderer.invoke(CH.versions, input, opts) as Promise<VersionList>,

  pluginIcon: (profile, name) =>
    ipcRenderer.invoke(CH.pluginIcon, profile, name) as Promise<PluginIconResult>,
  proxyTest: (input) => ipcRenderer.invoke(CH.proxyTest, input) as Promise<ProxyTestResult>,

  dshStatus: () => ipcRenderer.invoke(CH.dshStatus) as Promise<DshStatus>,
  dshStart: () => ipcRenderer.invoke(CH.dshStart) as Promise<DshActionResult>,
  dshStop: () => ipcRenderer.invoke(CH.dshStop) as Promise<DshActionResult>,

  exportManifest: (profile) =>
    ipcRenderer.invoke(CH.exportManifest, profile) as Promise<ManifestExportResult>,
  importManifest: (profile, text) =>
    ipcRenderer.invoke(CH.importManifest, profile, text) as Promise<ManifestPreview>,

  marketList: (opts) => ipcRenderer.invoke(CH.marketList, opts) as Promise<MarketList>,
  pluginGallery: (profile, name) =>
    ipcRenderer.invoke(CH.pluginGallery, profile, name) as Promise<GalleryResult>,

  /* ── 外观：壁纸 ─────────────────────────────────────── */

  wallpaperImport: () => ipcRenderer.invoke(CH.wallpaperImport) as Promise<WallpaperImportResult>,
  wallpaperFromPath: (filePath) =>
    ipcRenderer.invoke(CH.wallpaperFromPath, filePath) as Promise<WallpaperImportResult>,
  wallpaperList: () => ipcRenderer.invoke(CH.wallpaperList) as Promise<WallpaperEntry[]>,
  wallpaperSet: (id) => ipcRenderer.invoke(CH.wallpaperSet, id) as Promise<AppSettings>,
  wallpaperRemove: (id) => ipcRenderer.invoke(CH.wallpaperRemove, id) as Promise<boolean>,
  wallpaperPin: (id, pinned) =>
    ipcRenderer.invoke(CH.wallpaperPin, id, pinned) as Promise<boolean>,
  wallpaperAutoFit: (id, apply) =>
    ipcRenderer.invoke(CH.wallpaperAutoFit, id, apply) as Promise<WallpaperAutoFit>,

  /* ── 外观：主题 ─────────────────────────────────────── */

  themesList: () => ipcRenderer.invoke(CH.themesList) as Promise<ThemeSpec[]>,
  themeApply: (id) => ipcRenderer.invoke(CH.themeApply, id) as Promise<AppSettings>,
  themeSave: (spec) => ipcRenderer.invoke(CH.themeSave, spec) as Promise<ThemeSpec>,
  themeDelete: (id) => ipcRenderer.invoke(CH.themeDelete, id) as Promise<boolean>,
  themeExport: (id) => ipcRenderer.invoke(CH.themeExport, id) as Promise<ThemeFileResult>,
  themeImport: (text) => ipcRenderer.invoke(CH.themeImport, text) as Promise<ThemeSpec>,
  appearanceReset: () => ipcRenderer.invoke(CH.appearanceReset) as Promise<AppSettings>,

  /* ── 环境：手动挑选 + 重新探测 ─────────────────────── */

  pickDirectory: (title, defaultPath) =>
    ipcRenderer.invoke(CH.pickDirectory, title, defaultPath) as Promise<string | null>,
  pickDshExe: () =>
    ipcRenderer.invoke(CH.pickDshExe) as Promise<{ exe: string; dir: string } | null>,
  envRedetect: () => ipcRenderer.invoke(CH.envRedetect) as Promise<RuntimeInfo>,
  envDiagnose: () => ipcRenderer.invoke(CH.envDiagnose) as Promise<DiscoveryStep[]>,
  runtimeSource: () => ipcRenderer.invoke(CH.runtimeSource) as Promise<RuntimeSourceInfo>,
  runtimeProvision: (parts) =>
    ipcRenderer.invoke(CH.runtimeProvision, parts) as Promise<ProvisionResult>,
  onProvisionProgress: (cb) => subscribe<ProvisionProgress>(EV.provisionProgress, cb),

  /**
   * 拖拽文件的真实本地路径。
   * Electron 32+ 去掉了 File.path，官方替代是 webUtils.getPathForFile —— 必须在 preload
   * 里同步调用，因为 File 对象过不了 IPC 的结构化克隆。拿不到就返回空串。
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  windowMinimize: () => ipcRenderer.invoke(CH.windowMinimize) as Promise<void>,
  windowToggleMaximize: () => ipcRenderer.invoke(CH.windowToggleMaximize) as Promise<boolean>,
  windowClose: () => ipcRenderer.invoke(CH.windowClose) as Promise<void>,
  windowState: () => ipcRenderer.invoke(CH.windowState) as Promise<WindowState>,

  onOpLog: (cb) => subscribe<OpLogLine>(EV.opLog, cb),
  onOpDone: (cb) => subscribe<OpResult>(EV.opDone, cb),
  onUpdateProgress: (cb) => subscribe<UpdateCheckProgress>(EV.updateProgress, cb),
  onWindowState: (cb) => subscribe<WindowState>(EV.windowState, cb),
  onToast: (cb) => subscribe<ToastPayload>(EV.toast, cb),
  onDshStatus: (cb) => subscribe<DshStatus>(EV.dshStatus, cb),
  onEnvChanged: (cb) => subscribe<RuntimeInfo>(EV.envChanged, cb)
}

contextBridge.exposeInMainWorld('dsh', api)
