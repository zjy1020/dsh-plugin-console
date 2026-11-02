/**
 * IPC 契约：通道名常量 + 渲染进程可见的 API 形状。
 * main 侧用 CH 注册 handler，preload 侧用 CH 桥接，renderer 侧只认 `window.dsh`。
 */

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
  VersionList,
  InstallPreview,
  OpRequest,
  OpResult,
  OpLogLine,
  ParsedSpec,
  PluginRecord,
  ProfileSummary,
  ProvisionProgress,
  ProvisionResult,
  RegistryPackument,
  RuntimeInfo,
  RuntimePayloadPart,
  RuntimeSourceInfo,
  SearchHit,
  ThemeExportFile,
  ThemeFileResult,
  ThemeSpec,
  UpdateCheckProgress,
  WallpaperAutoFit,
  WallpaperEntry,
  WallpaperImportResult,
  WindowState
} from './types'

/** 请求-响应型通道（ipcRenderer.invoke） */
export const CH = {
  runtimeInfo: 'api:runtime-info',
  profiles: 'api:profiles',
  plugins: 'api:plugins',
  checkUpdates: 'api:check-updates',
  registryLookup: 'api:registry-lookup',
  registrySearch: 'api:registry-search',
  parseSpec: 'api:parse-spec',
  installPreview: 'api:install-preview',
  runOp: 'api:run-op',
  cancelOp: 'api:cancel-op',
  revealPath: 'api:reveal-path',
  openExternal: 'api:open-external',
  restartDsh: 'api:restart-dsh',
  settingsGet: 'api:settings-get',
  settingsSet: 'api:settings-set',
  marketList: 'api:market-list',
  pluginGallery: 'api:plugin-gallery',
  probeDir: 'api:probe-dir',
  versions: 'api:versions',
  pluginIcon: 'api:plugin-icon',
  proxyTest: 'api:proxy-test',
  dshStatus: 'api:dsh-status',
  dshStart: 'api:dsh-start',
  dshStop: 'api:dsh-stop',
  exportManifest: 'api:export-manifest',
  importManifest: 'api:import-manifest',

  /* 外观：壁纸 */
  wallpaperImport: 'api:wallpaper-import',
  wallpaperFromPath: 'api:wallpaper-from-path',
  wallpaperList: 'api:wallpaper-list',
  wallpaperSet: 'api:wallpaper-set',
  wallpaperRemove: 'api:wallpaper-remove',
  wallpaperPin: 'api:wallpaper-pin',
  wallpaperAutoFit: 'api:wallpaper-auto-fit',

  /* 外观：主题 */
  themesList: 'api:themes-list',
  themeApply: 'api:theme-apply',
  themeSave: 'api:theme-save',
  themeDelete: 'api:theme-delete',
  themeExport: 'api:theme-export',
  themeImport: 'api:theme-import',

  /* 外观：一键还原 */
  appearanceReset: 'api:appearance-reset',

  /* 环境：手动挑选目录 + 重新探测 */
  pickDirectory: 'api:pick-directory',
  pickDshExe: 'api:pick-dsh-exe',
  envRedetect: 'api:env-redetect',
  envDiagnose: 'api:env-diagnose',

  /* 环境：补全随包运行时 */
  runtimeSource: 'api:runtime-source',
  runtimeProvision: 'api:runtime-provision',

  windowMinimize: 'win:minimize',
  windowToggleMaximize: 'win:toggle-maximize',
  windowClose: 'win:close',
  windowState: 'win:state'
} as const

/** 推送型事件（ipcRenderer.on） */
export const EV = {
  opLog: 'ev:op-log',
  opDone: 'ev:op-done',
  updateProgress: 'ev:update-progress',
  windowState: 'ev:window-state',
  toast: 'ev:toast',
  dshStatus: 'ev:dsh-status',
  /**
   * 环境在后台被重新认出来了。
   *
   * 为什么必须有这条推送：同步路由（设置 / 环境变量 / 提示文件 / 几个常见目录名）
   * 是「猜」，新电脑上经常一条都不中 —— 而真正可靠的来源（注册表卸载项、正在运行的
   * 进程、桌面快捷方式、有界磁盘扫描）都得起子进程，几百毫秒到几秒，只能异步跑。
   * 异步跑完如果只是「写进主进程缓存」，界面上的引导卡还停在「找不到 DSH」，
   * 用户看到的是「这软件自己都不知道 DSH 在哪」—— 明明几秒后就已经知道了。
   * 所以命中之后必须主动推一次，让界面自己好起来，而不是等用户去点「自动检测一遍」。
   */
  envChanged: 'ev:env-changed',
  /**
   * 补全运行时的进度。
   *
   * 拷的是 257 MB / 六千多个文件，实测要十几秒。没有进度的话，用户点完「一键补全」
   * 看到的是一个不动的按钮 —— 和卡死没有区别。只在这一条链路上推，其它操作不需要。
   */
  provisionProgress: 'ev:provision-progress'
} as const

export interface ToastPayload {
  level: 'info' | 'success' | 'warn' | 'error'
  title: string
  detail?: string
}

/** preload 注入到 window 上的对象形状 */
export interface DshConsoleApi {
  runtimeInfo(): Promise<RuntimeInfo>
  profiles(): Promise<ProfileSummary[]>
  plugins(profile: string, opts?: { deep?: boolean }): Promise<PluginRecord[]>

  checkUpdates(profile: string, names?: string[]): Promise<Record<string, PluginRecord>>
  registryLookup(profile: string, name: string): Promise<RegistryPackument>
  registrySearch(query: string, limit?: number): Promise<SearchHit[]>

  parseSpec(input: string): Promise<ParsedSpec>
  installPreview(profile: string, input: string): Promise<InstallPreview>

  runOp(req: OpRequest): Promise<OpResult>
  cancelOp(opId: string): Promise<boolean>

  revealPath(target: string): Promise<boolean>
  openExternal(url: string): Promise<boolean>
  restartDsh(): Promise<{ ok: boolean; message: string }>

  settingsGet(): Promise<AppSettings>
  settingsSet(patch: Partial<AppSettings>): Promise<AppSettings>
  probeDir(dir: string): Promise<{ ok: boolean; exists: boolean; isDir: boolean; note: string }>

  /** 列出可安装的版本 / 标签 / 分支；input 可以是包名、npm spec 或 GitHub 链接 */
  versions(
    input: string,
    opts?: { profile?: string; current?: string | null }
  ): Promise<VersionList>

  /** 插件图标（dataURL）；读不到返回 ok:false */
  pluginIcon(profile: string, name: string): Promise<PluginIconResult>
  /** 测代理连通性和延迟；输入可以是 7890 / 127.0.0.1:7890 / http://... */
  proxyTest(input: string): Promise<ProxyTestResult>

  /** DSH 桌面端进程状态 */
  dshStatus(): Promise<DshStatus>
  dshStart(): Promise<DshActionResult>
  dshStop(): Promise<DshActionResult>

  /** 弹出保存对话框，把当前 profile 的已装清单导出成 JSON */
  exportManifest(profile: string): Promise<ManifestExportResult>
  /** 只解析不安装：算出清单里哪些缺、哪些已有 */
  importManifest(profile: string, text: string): Promise<ManifestPreview>

  /* ── 外观：壁纸 ─────────────────────────────────────── */

  /** 弹文件选择框导入壁纸：复制进我们自己的目录 + 生成缩略图 + 取色 */
  wallpaperImport(): Promise<WallpaperImportResult>
  /** 拖拽进来的本地绝对路径导入壁纸（路径用 pathForFile 拿） */
  wallpaperFromPath(filePath: string): Promise<WallpaperImportResult>
  /** 最近使用 + 预设壁纸 */
  wallpaperList(): Promise<WallpaperEntry[]>
  /** 设为当前壁纸；null = 关掉壁纸 */
  wallpaperSet(id: string | null): Promise<AppSettings>
  /** 删掉一张导入的壁纸（同时把它从最近使用里摘掉） */
  wallpaperRemove(id: string): Promise<boolean>
  /** 收藏 / 取消收藏（预设壁纸不可收藏） */
  wallpaperPin(id: string, pinned: boolean): Promise<boolean>
  /** 按壁纸算一整套适配参数；不传 id 就用当前壁纸 */
  wallpaperAutoFit(id?: string | null, apply?: boolean): Promise<WallpaperAutoFit>

  /* ── 外观：主题 ─────────────────────────────────────── */

  /** 内置 + 自定义主题 */
  themesList(): Promise<ThemeSpec[]>
  /** 应用一套主题（把它的参数写回 settings） */
  themeApply(id: string): Promise<AppSettings>
  /** 新建或覆盖一套自定义主题 */
  themeSave(spec: Partial<ThemeSpec> & { name: string }): Promise<ThemeSpec>
  /** 删掉一套自定义主题（内置的拒绝） */
  themeDelete(id: string): Promise<boolean>
  /** 导出主题包（弹保存对话框） */
  themeExport(id: string): Promise<ThemeFileResult>
  /** 从主题包 JSON 文本导入 */
  themeImport(text: string): Promise<ThemeSpec>

  /**
   * 把**外观相关字段**一键还原成出厂默认，并返回还原后的整份设置。
   *
   * 只还原外观（深浅模式 / 材质 / 强调色 / 氛围色 / 动效 / 侧边栏 / 壁纸选择 /
   * 遮罩 / 已应用主题），**不动**代理、并发数、安装目录、DSH_HOME、托盘这些
   * 需要重启或会影响安装行为的东西 —— 用户点「还原」的意思通常是「我这界面调乱了」，
   * 不是「把我配的代理也清了」。
   *
   * 壁纸文件本身不删（只是取消选中），否则还原一次就把用户导入的图弄没了。
   */
  appearanceReset(): Promise<AppSettings>

  /* ── 环境：手动挑选 + 重新探测 ─────────────────────── */

  /**
   * 弹一个「选择文件夹」对话框，返回用户选中的绝对路径；取消返回 null。
   *
   * 存在的理由：新电脑上 DSH 可能装在任何一个盘、任何一个目录名（甚至是从别的机器
   * 整目录拷过来的），自动探测不可能覆盖所有情况。与其让用户手打路径，不如给个
   * 系统原生的选择框 —— 这也是「找不到 DSH」那条错误里唯一的出口。
   */
  pickDirectory(title: string, defaultPath?: string): Promise<string | null>

  /**
   * 弹「选程序文件」对话框（只认 .exe），返回选中的 exe 与它所在目录；取消返回 null。
   *
   * 存在的理由：`pickDirectory` 要求用户理解「安装根」的结构（里面应该有 resources
   * 和 exe）—— 用户永远知道的是「程序本身在哪」，而不是我们的内部目录结构。
   * 选到 exe 的那一刻，dirname 就一定是安装根，没有「选错一层」的可能。
   * 这条通道是「启动 DSH 失败」的终极出口，优先于手打路径与选目录。
   */
  pickDshExe(): Promise<{ exe: string; dir: string } | null>

  /**
   * 清掉探测缓存并**完整重跑一遍**环境探测（含注册表 / 快捷方式 / 进程 / 磁盘扫描），
   * 返回新的 RuntimeInfo。用户手动指了目录、或者在 DSH 装好之后才打开插件台时用。
   *
   * 与 `runtimeInfo()` 的区别：后者读缓存，这个一定重算。
   */
  envRedetect(): Promise<RuntimeInfo>

  /**
   * 只做诊断不写任何东西：把「每条路由试了什么、成没成、为什么」原样列出来。
   *
   * 用在探测失败时的「环境诊断」面板 —— 用户截一张图就能把问题说清，
   * 不用再靠猜对方机器上的目录结构。
   */
  envDiagnose(): Promise<DiscoveryStep[]>

  /**
   * 「能不能自己补上运行时、要拷多少」。
   *
   * 存在的理由（Master 的原话：「有时候还会缺前置，比如说这些，需要补全前置功能」）：
   * 以前缺 node/pnpm 只能报错 + 让用户自己去装 DSH 桌面端跑一遍。而 DSH 桌面端
   * 本身就把这份载荷随包带着（`<安装根>/resources/runtime/primary-runtime`），
   * 它启动时做的事就是把它拷进 `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime`。
   * 那我们自己也能做同一件事 —— 只是要先把体积、来源、目标说清楚。
   */
  runtimeSource(): Promise<RuntimeSourceInfo>

  /**
   * 真的把随包运行时拷进 <DSH_HOME>。幂等：目标已经是同一份就直接返回 copied:false。
   * 进度走 `onProvisionProgress`。拷贝期间不要并发发起第二次。
   *
   * `parts` 决定拷哪几块载荷，默认 `['node','pnpm']` —— 装插件只需要这两块（111 MB）。
   * python 是 Office 技能用的（146 MB），界面上是个可选项：不传就不拷。
   * 只拷部分时**不会**写 runtime.json（见 provision.ts 里的说明），
   * 这样 DSH 桌面端下次启动仍会自己补齐，不会出现「运行时看着齐了、python 永远缺」。
   */
  runtimeProvision(parts?: RuntimePayloadPart[]): Promise<ProvisionResult>

  /**
   * 拿拖拽进来的 File 的真实本地路径。
   * Electron 早就移除了 File.path，官方替代是 preload 里同步调用 webUtils.getPathForFile。
   * 所以这个方法**不是 IPC**，是 preload 直接算出来的同步返回值。
   */
  pathForFile(file: File): string

  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<boolean>
  windowClose(): Promise<void>
  windowState(): Promise<WindowState>

  onOpLog(cb: (line: OpLogLine) => void): () => void
  onOpDone(cb: (result: OpResult) => void): () => void
  onUpdateProgress(cb: (p: UpdateCheckProgress) => void): () => void
  onWindowState(cb: (s: WindowState) => void): () => void
  onToast(cb: (t: ToastPayload) => void): () => void
  /** 拉插件市场目录（默认走磁盘缓存，force 强制重拉） */
  marketList(opts?: { force?: boolean }): Promise<MarketList>
  /** 找这个插件 README 里的截图，取好字节以 data URL 返回 */
  pluginGallery(profile: string, name: string): Promise<GalleryResult>
  onDshStatus(cb: (s: DshStatus) => void): () => void
  /**
   * 环境在后台被认出来了（异步路由命中安装根 / 用户改了路径设置后重探成功）。
   * 订阅方拿到新的 RuntimeInfo 后直接 applyRuntime + 重拉即可，不用再自己探一遍。
   */
  onEnvChanged(cb: (info: RuntimeInfo) => void): () => void
  /** 补全运行时的进度（拷 257 MB 期间每秒几帧，界面据此画进度条） */
  onProvisionProgress(cb: (p: ProvisionProgress) => void): () => void
}

export const DEFAULT_SETTINGS: AppSettings = {
  dshHome: null,
  installRoot: null,
  defaultProfile: null,
  registry: 'https://registry.npmjs.org',
  proxy: null,
  extraPnpmArgs: '',
  concurrency: 6,
  forceBundle: false,
  minimizeToTray: true,
  theme: 'dark',

  appearanceMode: 'dark',
  material: 'css',
  accent: '',
  ambient: '',
  motionLevel: 'full',
  reduceTransparency: false,
  enhanceContrast: false,

  wallpaper: null,
  wallpaperFit: 'cover',
  // 中性值：1 = 不调、0 = 不加遮罩。
  // maskDark/maskLight 给了一点点缺省值 —— 完全不遮的话，任何壁纸都会把面板对比度打穿。
  wallpaperAdjust: {
    brightness: 1,
    saturation: 1,
    contrast: 1,
    blur: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    maskDark: 0.35,
    maskLight: 0.22
  },
  wallpaperAuto: true,

  sidebarExpanded: true,
  sidebarWidth: 248,
  sidebarRadius: 16,
  sidebarOpacity: 0.62,
  sidebarBlur: 28,
  sidebarShowQuickActions: true,
  sidebarShowStatus: true,
  sidebarAutoHide: false,

  // 0 = 跟随主题（由 --gl-bed-alpha / --gl-panel-blur 推导，深色 0.86 / 18px，
  // 浅色 0.94 / 15.6px）。给 0 是为了让升级上来的用户观感一字不变。
  panelOpacity: 0,
  panelBlur: 0,

  activeThemeId: 'deep-sea-blue',
  customThemes: []
}
