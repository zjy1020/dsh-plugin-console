/**
 * DSH 插件台 —— 主进程 / 渲染进程共享类型契约。
 *
 * 这里的类型是唯一真相：main/engine 产出它们，preload 透传，renderer 只消费。
 * 任何改动都必须同时改 engine 与 renderer。
 */

/* ------------------------------------------------------------------ *
 * 环境
 * ------------------------------------------------------------------ */

/** 一个插件包在 profile 的 dependencies 里写的 spec 属于哪一类来源 */
export type SourceKind =
  | 'npm' // 1.2.3 / ^1.2.3 / latest
  | 'link' // link:D:\path —— 本地开发目录
  | 'file' // file:xxx.tgz —— 本地 tarball
  | 'git' // github:owner/repo / git+https://... / git+ssh://...
  | 'tarball' // https://.../x.tgz —— 远程 tarball
  | 'workspace' // workspace:*
  | 'unknown'

/**
 * 一条探测记录。
 *
 * 为什么要记这个：探测有十来条互相独立的路径（设置、环境变量、注册表、快捷方式、
 * 运行中的进程、常见目录、受限的磁盘扫描…），任何一条出问题都表现为同一句
 * 「找不到 DSH」，用户除了截图什么也给我们不了。把每条试过什么、为什么不成
 * 摊开在界面上，远程排障就不用再猜了。
 */
export interface DiscoveryStep {
  /** 这一条属于哪一组，例如「注册表」「快捷方式」「磁盘扫描」 */
  group: string
  /** 具体试了什么（路径 / 命令），能给用户看的形如 D:\Dowloads\DeepSeekHarness */
  path: string
  /** 这一条是否命中 */
  ok: boolean
  /** 没命中时为什么；命中时说明依据（例如「resources\app\package.json 的 name 对得上」） */
  detail: string
}

/** DSH 运行环境的探测结果 */
export interface RuntimeInfo {
  /** DSH_HOME，默认 <home>/.dsh */
  dshHome: string
  /** dshHome 是怎么定下来的（哪条路由命中的），给界面显示与排障用 */
  dshHomeFrom: string
  /** 桌面端安装根，例如 D:\Dowloads\DeepSeekHarness；没找到为 null */
  installRoot: string | null
  /** installRoot 是怎么找到的（哪条路由命中的）；没找到为 null */
  installRootFrom: string | null
  /** 本次探测按顺序试过的每一条（无论成败），给「环境诊断」面板显示 */
  discovery: DiscoveryStep[]
  /** 桌面端版本（resources/app/package.json 的 version） */
  desktopVersion: string | null
  /** 随包 runtime 版本（resources/app/dsh/package.json 的 version） */
  runtimeVersion: string | null
  /** dsh CLI 入口 lib/bin.js 的绝对路径 */
  dshCliPath: string | null
  /** 用来跑 pnpm 的 node.exe 绝对路径 */
  nodePath: string | null
  nodeVersion: string | null
  /** pnpm 入口（pnpm.cjs / pnpm.mjs）绝对路径 */
  pnpmPath: string | null
  pnpmVersion: string | null
  /**
   * 这对 node/pnpm 是哪来的：
   *   'dsh'     —— DSH 随包的那一份（版本最贴，官方通道也认它）
   *   'bundled' —— 插件台自带的那一份（electron 当 node + resources/pnpm）
   *   null      —— 两条都没有（只有安装包被手工删过文件才会这样）
   *
   * 为什么要把它暴露给界面：用户看到「运行时在哪」才知道自己要不要管它。
   * 自带那一条永远可用，所以界面上不该再出现「缺 node / 缺 pnpm」这种拦人的话。
   */
  runtimeSource: 'dsh' | 'bundled' | null
  /** 探测过程中产生的告警，给 UI 的「环境」面板显示 */
  warnings: string[]
}

/** profiles/<name> 的概览 */
export interface ProfileSummary {
  name: string
  dir: string
  packageJsonPath: string
  /** node_modules 是否存在（未初始化的 profile 可能没有） */
  hasNodeModules: boolean
  /** dependencies 条目数（= 用户装过的包） */
  depCount: number
  /** dsh.profile.bundles 条目数（= 实际会被加载的层） */
  bundleCount: number
}

/* ------------------------------------------------------------------ *
 * 插件记录
 * ------------------------------------------------------------------ */

/** 更新类型 */
export type UpdateKind = 'npm' | 'git' | 'relink' | 'none'

export interface PluginRecord {
  /** 稳定 id：`${profile}::${name}` */
  id: string
  profile: string
  /** package.json dependencies 里的键，即包名 */
  name: string
  /** dependencies 里写的原始 spec */
  spec: string
  sourceKind: SourceKind

  /** node_modules 里是否真的存在 */
  installed: boolean
  /** 实际安装版本（node_modules/<name>/package.json 的 version）；link 类型为 null */
  version: string | null
  /** spec 里声明的版本约束（link/file 为 null） */
  specVersion: string | null

  /** npm registry 上的 latest；未查询为 null */
  latestVersion: string | null
  updateAvailable: boolean
  updateKind: UpdateKind
  /** 更新检查失败原因（网络 / 包不存在 / 私有包） */
  updateError: string | null
  /** 上次检查更新的时间戳 */
  checkedAt: number | null

  description: string | null
  /**
   * 插件市场目录里的中文简介（catalogZh 那一层补的）。
   * 只在目录已经抓到本地时才有值（首次运行 / 没进过市场页就是 null），
   * 而且只覆盖「目录里有这一条」的包 —— 本地自己写的插件目录里没有，仍是 null。
   * 界面上的用法是 `descZh ?? description`：有中文就用中文。
   */
  descZh: string | null
  homepage: string | null
  repository: string | null
  author: string | null
  license: string | null
  keywords: string[]
  /** 是否声明了 dsh.client（有前端注入） */
  hasClient: boolean
  /** 是否声明了 dsh.bundle / dsh（有服务端插件） */
  hasServer: boolean
  /** 是否声明了 dsh.profile 或 dsh.bundle.patch —— 属于 bundle 层 */
  isBundlePackage: boolean

  /** 是否在 dsh.profile.bundles 名单里 */
  inBundles: boolean
  /** 在 bundles 数组里的下标，不在为 null */
  bundleIndex: number | null
  /** 在 bundles 里但被移出了 → 我们判定为「已停用」 */
  disabled: boolean
  /** cordis.patch.yml 里存在 `- id: X` + `disabled: true` 的对应条目 */
  disabledInPatch: boolean
  /** 随 runtime 发布的官方包（@deepseek-ai/*）—— 默认受保护，不允许卸载 */
  builtin: boolean
  /** 是否可卸载（builtin / 被别的包依赖时会提示） */
  removable: boolean

  /** 该包自己的 dependencies 数量 */
  depsCount: number
  /** node_modules/<name> 目录占用字节；link 类型统计目标目录 */
  sizeBytes: number | null
  /** node_modules/<name> 目录的 mtime */
  installedAt: number | null
  /** 安装位置绝对路径 */
  path: string | null

  /**
   * 本地来源（file / link / workspace）的包，如果它在自己的 package.json 里
   * 声明了远程出处（dsh.install.git / repository.url / GitHub 首页），
   * 这里记下归一化后的 git 地址 —— 有它才能查远端标签、给出更新按钮。
   * 其它来源一律 null（它们本来就按自己的 spec 走）。
   */
  remoteGitUrl: string | null
  /** 远程坐标是从哪个字段读到的（dsh.install.git / repository / homepage），给界面写说明用 */
  remoteFrom: string | null
  /**
   * 更新时真正要装的 spec。绝大多数情况与 `spec` 相同；
   * 只有当本地 tarball 追到了远程 tag 时，这里才是 `github:owner/repo#vX.Y.Z` ——
   * 也就是说「更新」会把 spec 从 `file:` 改写成远程坐标（这正是用户要的：
   * 不再被一个下载下来的本地 tgz 绑死）。
   */
  remoteSpec: string | null
}

/* ------------------------------------------------------------------ *
 * registry / 更新检查
 * ------------------------------------------------------------------ */

export interface RegistryPackument {
  name: string
  /** dist-tags.latest */
  latest: string | null
  distTags: Record<string, string>
  description: string | null
  homepage: string | null
  repository: string | null
  deprecated: string | null
  /** 该包名字是否不存在（404） */
  notFound: boolean
  error: string | null
}

export interface SearchHit {
  name: string
  version: string
  description: string | null
  /** 目录里的中文简介（npm 搜索接口只给英文）；目录里没有这个包就是 null */
  descZh: string | null
  keywords: string[]
  publisher: string | null
  updatedAt: string | null
  score: number
  links: { npm: string | null; homepage: string | null; repository: string | null }
}

export interface UpdateCheckProgress {
  profile: string
  done: number
  total: number
  name: string
  result: 'ok' | 'error' | 'skipped'
}

/* ------------------------------------------------------------------ *
 * 安装来源解析
 * ------------------------------------------------------------------ */

export interface ParsedSpec {
  ok: boolean
  /** 用户原始输入 */
  raw: string
  kind: SourceKind | 'invalid'
  /** 归一化后可以直接喂给 `pnpm add` 的 spec */
  normalized: string | null
  /** 若是 GitHub 形式，拆出来的信息（给 UI 预览用） */
  owner: string | null
  repo: string | null
  /** git ref（分支 / tag / commit） */
  ref: string | null
  /** monorepo 子目录 */
  subdir: string | null
  /** npm 包名（kind === 'npm' 时） */
  packageName: string | null
  /** 人话说明这份输入被当成了什么 */
  reason: string
  /** 解析失败原因 */
  error: string | null
}

/** 解析 + 预检结果（会去网络上确认包/仓库存在） */
export interface InstallPreview {
  parsed: ParsedSpec
  /** 归一化后的包名（若能确定） */
  resolvedName: string | null
  /** 远端可读到的版本 */
  resolvedVersion: string | null
  /** 远端描述 */
  resolvedDescription: string | null
  /** 该包是否声明了 dsh 插件字段 —— 决定它能不能进 bundles */
  isDshPlugin: boolean
  /** 已经装过了？（同名包） */
  alreadyInstalled: string | null
  /** 预检告警（比如「这个包看起来不是 DSH 插件，装上但不会加载」） */
  warnings: string[]
  /** 目标 profile 名 */
  profile: string
  error: string | null
}

/* ------------------------------------------------------------------ *
 * 操作（安装 / 卸载 / 更新 / 停用 / 启用）
 * ------------------------------------------------------------------ */

export type OpKind =
  | 'install'
  | 'uninstall'
  | 'update'
  | 'update-all'
  | 'enable'
  | 'disable'
  | 'repair'
  | 'install-manifest'

export interface OpRequest {
  kind: OpKind
  profile: string
  /**
   * 要操作的包名（uninstall / update / enable / disable）。
   *
   * update-all 也允许带它，而且带了就以它为准 —— 用户在确认弹窗里看到的那几个包，
   * 必须就是真正拿去执行的那几个；主进程不再自己从磁盘清单里猜「哪些包可更新」
   * （清单里的 updateAvailable 恒为 false，靠它挑目标只会挑出空集）。
   */
  targets?: string[]
  /**
   * 包名 → 该包要装到的版本（渲染层「最新版本」那一列显示的值）。
   *
   * 为什么要把版本从渲染层传下来，而不是让主进程自己再查一次：
   *   1) 主进程重新联网查的结果可能和界面上显示的不一样（registry 缓存/CDN 抖动、
   *      期间又发了新版本），装完那一行还亮着「可更新」，用户看到的就是「点了没反应」；
   *   2) 钉到用户确认时看到的那一个版本，结果才是确定的、可复现的；
   *   3) pnpm 11 的供应链冷却会主动把新版本压回旧版 —— 钉版本时才会命中
   *      ERR_PNPM_MINIMUM_RELEASE_AGE，从而走 runPnpmAddish 里的豁免重试那条路。
   * 缺省/某个包没给 → 主进程退回用清单里的 latestVersion，最后才用 @latest。
   */
  versions?: Record<string, string>
  /**
   * 包名 → 该包更新时要用哪个 spec（目前只有「本地 tarball 追到了远程 tag」这一种情况要传：
   * `github:owner/repo#v1.6.70`）。
   *
   * 为什么要渲染层传：这条 spec 是「检查更新」那一刻问远端问出来的，只活在渲染层的
   * 更新结论快照里；主进程重读磁盘时 PluginRecord.remoteSpec 是 null（那要联网才知道）。
   * 不传也不致命 —— 主进程会自己再问一次远端，只是多花几秒、且结果可能比界面上新一档。
   */
  specs?: Record<string, string>
  /** install 时的 spec（原始输入或已归一化 spec） */
  spec?: string
}

export interface OpLogLine {
  opId: string
  at: number
  channel: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface OpChange {
  name: string
  from: string | null
  to: string | null
  action: 'added' | 'removed' | 'updated' | 'bundled' | 'unbundled' | 'unchanged'
}

export interface OpResult {
  opId: string
  kind: OpKind
  profile: string
  ok: boolean
  code: number | null
  startedAt: number
  endedAt: number
  changes: OpChange[]
  message: string
  /** 是否需要重启 DSH 才生效 */
  restartRequired: boolean
  /**
   * 部分成功：有失败条目，但确实也装上了东西。
   *
   * 界面用「部分完成」而不是「操作失败」—— 一次导入清单装了 15 个、漏了 1 个，
   * 报成整片红色失败会让人以为白干了。
   */
  partial?: boolean
  /** 完整日志（UI 的日志抽屉用） */
  log: string
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export interface AppSettings {
  /** 覆盖 DSH_HOME */
  dshHome: string | null
  /** 覆盖安装根 */
  installRoot: string | null
  /** 默认操作的 profile */
  defaultProfile: string | null
  /** npm registry，默认 https://registry.npmjs.org */
  registry: string
  /** 走代理，如 http://127.0.0.1:7890 */
  proxy: string | null
  /** pnpm 额外参数（空格分隔） */
  extraPnpmArgs: string
  /** 更新检查并发 */
  concurrency: number
  /** 是否把非 DSH 插件也一并加入 bundles（危险，默认 false） */
  forceBundle: boolean
  /** 关窗口时收进系统托盘而不是退出 */
  minimizeToTray: boolean
  /** 主题（旧字段，等价于 appearanceMode；保留是为了兼容老配置文件） */
  theme: 'dark' | 'light' | 'system'

  /* ── 外观 ─────────────────────────────────────────────── */

  /** 深浅模式。system = 跟随系统 */
  appearanceMode: AppearanceMode
  /** 壳层材质用自绘壁纸还是系统亚克力 / Mica */
  material: MaterialKind
  /** 品牌强调色，hex；空串 = 由主题 / 壁纸自动决定 */
  accent: string
  /** 环境光色，hex；空串 = 由主题 / 壁纸自动决定 */
  ambient: string
  /** 动效等级 */
  motionLevel: MotionLevel
  /** 减少透明效果（无障碍：低视力 / 晕动 / 低端机） */
  reduceTransparency: boolean
  /** 增强对比度 */
  enhanceContrast: boolean

  /* ── 壁纸 ─────────────────────────────────────────────── */

  /** 当前壁纸；null = 不用壁纸（纯色底） */
  wallpaper: WallpaperRef | null
  wallpaperFit: WallpaperFit
  wallpaperAdjust: WallpaperAdjust
  /** 换壁纸时自动跑一次适配 */
  wallpaperAuto: boolean

  /* ── 侧边栏 ───────────────────────────────────────────── */

  sidebarExpanded: boolean
  /** 展开态宽度，px */
  sidebarWidth: number
  sidebarRadius: number
  /** 面板不透明度 0 – 1 */
  sidebarOpacity: number
  /** 面板毛玻璃强度，px */
  sidebarBlur: number
  sidebarShowQuickActions: boolean
  sidebarShowStatus: boolean
  sidebarAutoHide: boolean

  /* ── 内容面板（主区 + 详情） ───────────────────────────── */

  /** 主区衬底的不透明度 0.2 – 1；**0 = 跟随主题**（此时由主题的衬底 alpha 推导，
   *  深色约 0.86 / 浅色约 0.94）。用 0 当哨兵而不是 null：设置面板的滑杆只认数字，
   *  而「跟随主题」本来就是「不指定」的语义。 */
  panelOpacity: number
  /** 主区毛玻璃强度 px 0 – 60；**0 = 跟随主题**（深色约 18px / 浅色约 15.6px）。 */
  panelBlur: number

  /* ── 主题 ─────────────────────────────────────────────── */

  /** 当前主题 id；'custom' = 手动改过参数、不归属任何主题 */
  activeThemeId: string
  customThemes: ThemeSpec[]
}

/* ------------------------------------------------------------------ *
 * 窗口控制
 * ------------------------------------------------------------------ */

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
}

/* ───────────────────────── 插件图标 ───────────────────────── */

export interface PluginIconResult {
  ok: boolean
  name: string
  /** `data:image/png;base64,...` —— 直接给 <img src>；找不到就是 null */
  dataUrl: string | null
  /** 从哪找到的：package / registry / repo；找不到是 null */
  source: string | null
  error: string | null
}

/* ───────────────────────── 代理测速 ───────────────────────── */

export interface ProxyTestResult {
  ok: boolean
  /** 归一化后的代理地址，例如 http://127.0.0.1:7890 */
  target: string
  /**
   * 代理 hop 耗时：TCP 连上代理 + 代理回 CONNECT 应答，不含隧道里的 TLS 与 HTTPS 往返。
   * 这才是「代理本身有多快」；本地代理通常是个位数毫秒。
   */
  latencyMs: number | null
  /**
   * 全链路耗时：从发起连接到隧道里拿到第一个响应头，含出境、TLS 握手与 HTTPS 往返。
   * 真正决定「装插件快不快」的是这个数，所以它和 latencyMs 一起报，
   * 免得本地 hop 只有 3ms 却让人以为整个代理是 3ms（跨境那一段可能 1.8 秒）。
   */
  totalMs: number | null
  status: number | null
  error: string | null
}

/* ───────────────────────── DSH 进程 ───────────────────────── */

export interface DshStatus {
  running: boolean
  pids: number[]
  exePath: string | null
  installRoot: string | null
  /** 探测时间戳（毫秒） */
  checkedAt: number
}

export interface DshActionResult {
  ok: boolean
  message: string
  status: DshStatus
}

/* ───────────────────────── 清单导出 / 导入 ───────────────────────── */

export interface ManifestEntry {
  name: string
  spec: string
  sourceKind: SourceKind
  version: string | null
  inBundles: boolean
  disabled: boolean
}

export interface ManifestFile {
  /** 固定标记，导入时用来认自家文件 */
  kind: 'dsh-plugin-console/manifest'
  version: 1
  exportedAt: string
  dshVersion: string | null
  profile: string
  plugins: ManifestEntry[]
}

export interface ManifestExportResult {
  ok: boolean
  path: string | null
  count: number
  /**
   * 写了清单、但因为来源是本机路径（`link:` / `file:`）而**没被写进去**的包名。
   *
   * 清单的意义是「拿去另一台机器能装回来」，本地路径来源换台机器就断了，
   * 所以导出时直接不写 —— 这里把它们的名字带出来，好在提示里说清少了谁，
   * 而不是让人事后翻清单发现少了几条。
   */
  skipped: string[]
  error: string | null
}

export interface ManifestPreview {
  ok: boolean
  profile: string
  total: number
  /** 清单里有、当前 profile 也有的包名 */
  present: string[]
  /** 清单里有、当前 profile 没有的条目 */
  missing: ManifestEntry[]
  /** 逐条安装时要交给 pnpm 的 spec（按清单顺序） */
  specs: string[]
  warnings: string[]
  error: string | null
}

/* ───────────────────────── 版本选择 / 降级 ───────────────────────── */


/* ───────────────────────── 插件市场（dshmarket 目录） ───────────────────────── */

/**
 * 目录里的一条插件。
 *
 * 数据来自 `dsh-plugin-catalog` 这个 npm 包里携带的 `plugins.json`
 * （dshmarket 用的就是它）—— 所以字段名沿用那份文件的原始拼写。
 */
export interface MarketEntry {
  /** 目录里的名字（多数情况下等于 npm 包名） */
  name: string
  /** GitHub 仓库地址 */
  url: string
  owner: string
  /** 一个或多个分类 id */
  categories: string[]
  /** 多语言描述，键是语言码 */
  description: Record<string, string>
  /** npm 包名；没有发布到 npm 的插件这里是 null */
  npm: string | null
  /** 目录声明的图标地址 */
  icon: string | null
  version: string | null
  stars: number | null
  downloads: number | null
  /** 交给 pnpm 的安装 spec（目录直接给的 `install`） */
  install: string
  /** 目录声明的加入时间 */
  added: string
  deprecated: boolean
  replacement: string | null
  /** 静态扫描声明会碰的东西：shell / network / credentials / fs-read … */
  capabilities: string[]
  /** 从未扫描过是 null；空数组表示扫过但没检出 */
  capabilityCheckedAt: string | null
  /** 当前 profile 里是否已经装了这个包 */
  installed: boolean
}

export interface MarketCategory {
  id: string
  /** 分类显示名（多语言） */
  labels: Record<string, string>
  count: number
}

export interface MarketList {
  ok: boolean
  /** 目录构建时间（原样透传） */
  updated: string | null
  /** 目录里的插件总数（过滤前） */
  total: number
  categories: MarketCategory[]
  plugins: MarketEntry[]
  /** 数据实际从哪来的，界面上要能说清 */
  source: 'npm-package' | 'origin' | null
  /** 是否走了磁盘缓存 */
  cached: boolean
  fetchedAt: number
  warnings: string[]
  error: string | null
}

/* ───────────────────────── 插件图集（README 截图） ───────────────────────── */

export interface GalleryImage {
  /** data: URL（已经在主进程里取好字节，渲染层不需要再联网） */
  dataUrl: string
  /** 原图地址，用于「打开原图」 */
  url: string
  width: number | null
  height: number | null
  /** 从哪找到的 */
  source: 'readme' | 'npm-readme' | 'catalog'
  /** markdown 里的 alt 文本，可能为空 */
  alt: string | null
  bytes: number
}

export interface GalleryResult {
  ok: boolean
  name: string
  images: GalleryImage[]
  /** 找到图片的那份 readme 的来源说明，如 `README.md` / `npm registry` */
  origin: string | null
  /** README 原文里的外链（放到「相关链接」里更有价值，不去抓） */
  links: { label: string; url: string }[]
  warnings: string[]
  error: string | null
}
export interface VersionOption {
  /** 直接交给 pnpm 的完整 spec，如 `dsh-context@1.2.3`、`github:owner/repo#v1.0.0` */
  spec: string
  /** 界面上显示的主文本：版本号 / 标签名 / 分支名 */
  label: string
  /** 版本号、dist-tag 名或 git ref */
  value: string
  /** npm 的正式版本 / npm 的 dist-tag / git 标签 / git 分支 */
  kind: 'version' | 'dist-tag' | 'tag' | 'branch'
  /** 发布时间（npm 有，git 没有） */
  publishedAt: string | null
  /** 相对当前已装版本：升 / 降 / 同 / 无法比较 */
  direction: 'up' | 'down' | 'same' | null
}

export interface VersionList {
  ok: boolean
  /** 来源类型 */
  kind: 'npm' | 'git' | 'unknown'
  /** 包名，或 `owner/repo` */
  name: string
  /** npm 的 latest，或 git 的默认分支 */
  latest: string | null
  /** 当前已装的版本 / ref */
  current: string | null
  options: VersionOption[]
  /** 版本太多被截断了吗 */
  truncated: boolean
  warnings: string[]
  error: string | null
}

/* ------------------------------------------------------------------ *
 * 外观：壁纸 / 材质 / 动效 / 主题
 * ------------------------------------------------------------------ */

/** 深浅模式。system = 跟随系统 */
export type AppearanceMode = 'dark' | 'light' | 'system'

/** 窗口材质的实现方式 */
export type MaterialKind =
  /** 窗口内自绘壁纸层 + CSS backdrop-filter（默认；任何壁纸都能用） */
  | 'css'
  /** Windows 11 系统亚克力：模糊的是**桌面**，自定义壁纸层会关掉 */
  | 'acrylic'
  /** Windows 11 Mica：同上，系统按桌面壁纸自动着色 */
  | 'mica'

/** 动效等级。off = 只保留必要的即时状态变化 */
export type MotionLevel = 'full' | 'reduced' | 'off'

export type WallpaperKind = 'image' | 'animated'

/** 壁纸填充方式 */
export type WallpaperFit = 'cover' | 'contain' | 'fill' | 'tile' | 'center'

/** 壁纸调参。数值都留了「1 / 0 是中性」的语义，便于自动适配回写 */
export interface WallpaperAdjust {
  /** 0.2 – 2，1 = 原样 */
  brightness: number
  /** 0 – 2，1 = 原样 */
  saturation: number
  /** 0.2 – 2，1 = 原样 */
  contrast: number
  /** px，0 = 不模糊 */
  blur: number
  /** 1 = 刚好铺满，>1 放大 */
  scale: number
  /** -1 – 1，相对可用空间的比例偏移 */
  offsetX: number
  offsetY: number
  /** 0 – 1，深色模式下压暗壁纸的遮罩强度 */
  maskDark: number
  /** 0 – 1，浅色模式下压亮壁纸的遮罩强度 */
  maskLight: number
}

/** 从壁纸图像里算出来的客观特征。自动适配的所有判断都基于它 */
export interface WallpaperPalette {
  /** 占比最高的显著色，hex */
  dominant: string
  secondary: string
  lightest: string
  darkest: string
  /** 整图平均亮度 0 – 1（感知亮度，非算术平均） */
  luma: number
  /** 亮度分位数 */
  p10: number
  p50: number
  p90: number
  /** 饱和度均值 0 – 1 */
  saturation: number
  /** 高频能量 0 – 1：越大越「复杂」（人物 / 密集图案） */
  detail: number
  /** 根据 luma 推出的建议模式 */
  suggestedMode: 'dark' | 'light'
}

/** 一张已导入的壁纸 */
export interface WallpaperRef {
  id: string
  name: string
  /** 原图在我们自己目录里的路径（永远不引用用户原位置，避免被移走） */
  path: string
  /** 缩略图路径；生成失败为 null（UI 要能没有缩略图） */
  thumbPath: string | null
  palette: WallpaperPalette | null
  width: number | null
  height: number | null
  kind: WallpaperKind
  addedAt: number
}

/** 最近使用 / 预设壁纸的列表项 */
export interface WallpaperEntry {
  id: string
  name: string
  /** 预设壁纸没有落盘原图，只有一段描述 */
  path: string | null
  thumbPath: string | null
  /* 这三项是 WallpaperRef 里也有的字段，列表一起带出来 ——
   * 设置面板要点选一张壁纸时得拼出一份完整的 Ref 塞进草稿，
   * 少了它们就只能额外再多一次 IPC 往返。 */
  palette: WallpaperPalette | null
  width: number | null
  height: number | null
  kind: WallpaperKind
  /** 是不是我们预置的（不是用户导入的） */
  preset: boolean
  pinned: boolean
  addedAt: number
}

/** 「自动适配」算出来的一整套参数 */
export interface WallpaperAutoFit {
  mode: 'dark' | 'light'
  sidebarOpacity: number
  sidebarBlur: number
  maskDark: number
  maskLight: number
  borderBrightness: number
  /** 建议的品牌强调色（从壁纸取色，已做可读性校正） */
  accent: string
  /** 环境光色，用于面板边缘的极弱光晕 */
  ambient: string
  textTone: 'light' | 'dark'
  /** 壁纸太复杂导致文字危险时置 true，UI 应该主动提示并提高不透明度 */
  enhanceReadability: boolean
  /** 给人看的判断依据（中文，逐条）。
   *  这不是装饰 —— 自动适配是个黑箱，必须能解释它为什么这么调。 */
  reasons: string[]
}

export interface WallpaperImportResult {
  ok: boolean
  ref: WallpaperRef | null
  autoFit: WallpaperAutoFit | null
  error: string | null
}

/**
 * 一套主题 = 一整套侧边栏环境，不是一组颜色。
 * 字段和 AppSettings 里的外观字段一一对应，应用主题就是把这些值写回 settings。
 */
export interface ThemeSpec {
  id: string
  name: string
  /** 内置主题不许改名 / 删除 */
  builtin: boolean
  /** 一句话说明这套主题适合什么场景 */
  description: string
  /** null = 跟随当前壁纸，不锁定 */
  wallpaperId: string | null
  mode: 'dark' | 'light'
  accent: string
  /** 辅助色：状态点、次强调 */
  accent2: string
  ambient: string
  sidebarOpacity: number
  sidebarBlur: number
  sidebarRadius: number
  maskDark: number
  maskLight: number
  borderBrightness: number
  shadowStrength: number
  motionLevel: MotionLevel
  sidebarWidth: number
  sidebarExpanded: boolean
  createdAt: number
  updatedAt: number
}

/** 主题包（导出成 .dsh-theme.json 的顶层形状） */
export interface ThemeExportFile {
  format: 'dsh-plugin-console-theme'
  version: 1
  exportedAt: number
  theme: ThemeSpec
  /** 壁纸图片本身不随主题包走（太大），只带走调参 */
  wallpaperAdjust: WallpaperAdjust | null
}

export interface ThemeFileResult {
  ok: boolean
  path: string | null
  error: string | null
}

/* ------------------------------------------------------------------ *
 * 运行时补全（把 DSH 随包的 primary-runtime 拷进 <DSH_HOME>）
 * ------------------------------------------------------------------ */

/** primary-runtime 里可以被统计的三块载荷 */
export type RuntimePayloadPart = 'node' | 'pnpm' | 'python'

export interface RuntimePartSize {
  bytes: number
  files: number
}

/**
 * 「能不能补、从哪儿补、要拷多少」。
 *
 * 为什么要在拷之前先把这些摊开给用户：这是 257 MB、六千多个文件的拷贝，
 * 点下去要等十几秒。不告诉体积就直接开拷，用户会以为卡死了。
 */
export interface RuntimeSourceInfo {
  /** 找到了可用且平台/架构对得上的载荷源 */
  ok: boolean
  /** 源目录，例如 D:\Dowloads\DeepSeekHarness\resources\runtime\primary-runtime */
  dir: string | null
  /** 这个源是哪条路由找到的（安装根 / 已有的运行时副本 …） */
  from: string | null
  /** 目标目录，<DSH_HOME>/dsh-runtimes/dsh-primary-runtime */
  target: string | null
  /** 源 runtime.json 里记的版本信息 */
  desktopVersion: string | null
  platform: string | null
  arch: string | null
  node: string | null
  pnpm: string | null
  python: string | null
  /** 整份载荷的体积 */
  total: RuntimePartSize
  /** 三块分别多大（给界面说清「python 那 146 MB 是 Office 技能用的，但少了 DSH 会认为运行时是坏的」） */
  parts: Record<RuntimePayloadPart, RuntimePartSize>
  /** 目标已经是同一份了 —— 不需要再拷 */
  upToDate: boolean
  /** ok 为 false 时说明为什么 */
  problem: string | null
}

export interface ProvisionProgress {
  phase: 'scan' | 'copy' | 'verify' | 'swap' | 'done' | 'fail'
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  /** 正在拷哪个相对路径（只给诊断日志用，界面别显示 —— 太长会跳） */
  current: string | null
  /** 一句人话 */
  message: string
}

export interface ProvisionResult {
  ok: boolean
  message: string
  /** 补完之后的运行时根 */
  root: string | null
  /** 这次真的拷了（false = 本来就已经是同一份） */
  copied: boolean
  bytes: number
  files: number
  ms: number
  error: string | null
}

/* ------------------------------------------------------------------ *
 * DSH 本体字体
 *
 * 这些是 `src/main/engine/fonts.ts` 里那几个接口的**字段镜像**，必须与那边保持一致
 * （那边是权威实现）。要重写一遍的原因很实在：渲染进程的 tsconfig.web.json 只 include
 * src/renderer、src/shared、src/preload/*.d.ts —— src/main 一个字符都不在里面，
 * 面板组件拿不到那边的类型。
 *
 * 为什么改的是 profile 的 cordis.patch.yml 而不是注入 CSS：
 * DSH 本体（dsh-client-ui-theme）自己就有 textFontFamily / codeFontFamily /
 * terminalFontFamily 三个配置项，而且是 volatile 的（改完 hmr 热生效、不用重启）。
 * 往别人的界面里塞 style 标签是插件没办法时的做法，我们做的是宿主工具，走配置正门。
 * ------------------------------------------------------------------ */

export type FontRole = 'text' | 'code' | 'terminal'

/** 三个角色的当前值；空串 = 没设置 = 交给 DSH 内置字体栈 */
export interface FontFamilyValues {
  text: string
  code: string
  terminal: string
}

/** 单个键在补丁文件里的落点：present=false 表示文件里压根没有这一行 */
export interface FontKeyState {
  present: boolean
  value: string
  line: number | null
}

export interface SystemFontsResult {
  fonts: string[]
  source: 'registry' | 'fontdir' | 'none'
  count: number
  scannedAt: number
  note: string
}

export interface FontsReadResult {
  ok: boolean
  error: string | null
  /** 入参原样（profile 名或绝对路径） */
  profile: string
  profileDir: string
  patchPath: string
  patchExists: boolean
  /** 补丁里有没有 `- id: ui-theme` 这一条 */
  entryFound: boolean
  /** 条目所在行号（1 起，找不到为 null） */
  entryLine: number | null
  /** 从 profile 补丁读到的值（'' = 没写） */
  values: FontFamilyValues
  /** 每个键的明细：UI 用它区分「没写」和「写了空串」 */
  keys: Record<FontRole, FontKeyState>
  /** 全 profile 补丁（~/.dsh/cordis.patch.yml）：它压住 profile 补丁，存在就得在 UI 上提示 */
  homePatchPath: string
  homePatchExists: boolean
  homePatchEntryFound: boolean
  homePatchValues: FontFamilyValues
  /** home 补丁是否真的写了这三个键（都空不算） */
  homePatchSetsFonts: boolean
  /** 读的时候的 mtime，写的时候带上它做冲突检测 */
  mtimeMs: number | null
  note: string
}

/** 要写哪些键：缺省 = 不动；null 或空串 = 删掉这个键（回到 DSH 默认） */
export interface FontsWriteInput {
  text?: string | null
  code?: string | null
  terminal?: string | null
}

export interface FontsWriteResult {
  ok: boolean
  error: string | null
  /** DSH 在我们动手前后改过这个文件，本次放弃写入 */
  conflict: boolean
  patchPath: string
  backup: string | null
  createdPatch: boolean
  createdEntry: boolean
  createdConfig: boolean
  /** config 下最后一个键被删掉，顺手收掉了 config: 行 */
  removedConfigLine: boolean
  /** 实际改动的角色 */
  changed: FontRole[]
  /** 想改但没法改的（块标量、超长…） */
  skipped: { role: FontRole; reason: string }[]
  /** 写完后回读的真实值 */
  values: FontFamilyValues
  note: string
  mtimeMs: number | null
}

