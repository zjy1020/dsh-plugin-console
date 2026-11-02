/**
 * 契约层 v5 —— 外观系统（壁纸 / 材质 / 侧边栏 / 动效 / 主题）
 *
 * 一次性脚本，用 Node 做精确定位替换（PowerShell 里反引号转义 template literal 会翻车）。
 * 打三处：
 *   1. src/shared/types.ts   —— AppSettings 加外观字段 + 追加外观相关类型
 *   2. src/shared/ipc.ts     —— CH / import / DshConsoleApi / DEFAULT_SETTINGS
 *   3. src/preload/index.ts  —— 桥接新方法 + pathForFile（webUtils 同步调用，不走 IPC）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2]
if (!ROOT) throw new Error('用法: node patch-contract-v5.mjs <项目根>')

const results = []
function patch(rel, label, fn) {
  const file = join(ROOT, rel)
  const before = readFileSync(file, 'utf8')
  const after = fn(before)
  if (after === before) {
    results.push({ rel, label, changed: false })
    return
  }
  writeFileSync(file, after)
  results.push({ rel, label, changed: true })
}
function replaceOnce(src, from, to, where) {
  const i = src.indexOf(from)
  if (i < 0) throw new Error(`找不到锚点（${where}）: ${from.slice(0, 90)}`)
  if (src.indexOf(from, i + 1) >= 0) throw new Error(`锚点不唯一（${where}）`)
  return src.slice(0, i) + to + src.slice(i + from.length)
}

/* ───────────────────────── 1. types.ts ───────────────────────── */

const APPEARANCE_TYPES = `

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
`

patch('src/shared/types.ts', 'AppSettings 外观字段', (src) => {
  // 幂等：上一次跑已经打过了就跳过（这个脚本会分阶段重跑）
  if (src.includes('appearanceMode')) return src
  let out = replaceOnce(
    src,
    `  /** 主题 */
  theme: 'dark' | 'light' | 'system'
}`,
    `  /** 主题（旧字段，等价于 appearanceMode；保留是为了兼容老配置文件） */
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

  /* ── 主题 ─────────────────────────────────────────────── */

  /** 当前主题 id；'custom' = 手动改过参数、不归属任何主题 */
  activeThemeId: string
  customThemes: ThemeSpec[]
}`,
    'types.ts AppSettings'
  )
  out = out.trimEnd() + APPEARANCE_TYPES + '\n'
  return out
})

/* ───────────────────────── 2. ipc.ts ───────────────────────── */

patch('src/shared/ipc.ts', 'ipc 契约', (src) => {
  let out = src

  out = replaceOnce(
    out,
    `  UpdateCheckProgress,
  WindowState
} from './types'`,
    `  ThemeExportFile,
  ThemeFileResult,
  ThemeSpec,
  UpdateCheckProgress,
  WallpaperAutoFit,
  WallpaperEntry,
  WallpaperImportResult,
  WindowState
} from './types'`,
    'ipc imports'
  )

  out = replaceOnce(
    out,
    `  importManifest: 'api:import-manifest',`,
    `  importManifest: 'api:import-manifest',

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
`,
    'ipc CH'
  )

  out = out.replace(
    `  windowMinimize(): Promise<void>`,
    `  /* ── 外观：壁纸 ─────────────────────────────────────── */

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
  wallpaperAutoFit(id?: string | null): Promise<WallpaperAutoFit>

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
   * 拿拖拽进来的 File 的真实本地路径。
   * Electron 早就移除了 File.path，官方替代是 preload 里同步调用 webUtils.getPathForFile。
   * 所以这个方法**不是 IPC**，是 preload 直接算出来的同步返回值。
   */
  pathForFile(file: File): string

  windowMinimize(): Promise<void>`
  )

  out = replaceOnce(
    out,
    `  minimizeToTray: true,
  theme: 'dark'
}`,
    `  minimizeToTray: true,
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

  activeThemeId: 'deep-sea-blue',
  customThemes: []
}`
  )

  return out
})

/* ───────────────────────── 3. preload ───────────────────────── */

patch('src/preload/index.ts', 'preload 桥接', (src) => {
  let out = src

  // 3.1 引入 webUtils
  if (!out.includes(`webUtils`)) {
    out = replaceOnce(
      out,
      `import { contextBridge, ipcRenderer } from 'electron'`,
      `import { contextBridge, ipcRenderer, webUtils } from 'electron'`,
      'preload electron import'
    )
  }

  // 3.2 类型 import
  out = replaceOnce(
    out,
    `    windowMinimize: () =>`,
    `    windowMinimize: () =>`,
    'preload anchor check'
  ).replace(
    `\n  windowMinimize: () =>`,
    `
  /* ── 外观：壁纸 ─────────────────────────────────────── */

  wallpaperImport: () => ipcRenderer.invoke(CH.wallpaperImport) as Promise<WallpaperImportResult>,
  wallpaperFromPath: (filePath: string) =>
    ipcRenderer.invoke(CH.wallpaperFromPath, filePath) as Promise<WallpaperImportResult>,
  wallpaperList: () => ipcRenderer.invoke(CH.wallpaperList) as Promise<WallpaperEntry[]>,
  wallpaperSet: (id: string | null) =>
    ipcRenderer.invoke(CH.wallpaperSet, id) as Promise<AppSettings>,
  wallpaperRemove: (id: string) => ipcRenderer.invoke(CH.wallpaperRemove, id) as Promise<boolean>,
  wallpaperPin: (id: string, pinned: boolean) =>
    ipcRenderer.invoke(CH.wallpaperPin, id, pinned) as Promise<boolean>,
  wallpaperAutoFit: (id?: string | null) =>
    ipcRenderer.invoke(CH.wallpaperAutoFit, id) as Promise<WallpaperAutoFit>,

  /* ── 外观：主题 ─────────────────────────────────────── */

  themesList: () => ipcRenderer.invoke(CH.themesList) as Promise<ThemeSpec[]>,
  themeApply: (id: string) => ipcRenderer.invoke(CH.themeApply, id) as Promise<AppSettings>,
  themeSave: (spec: Partial<ThemeSpec> & { name: string }) =>
    ipcRenderer.invoke(CH.themeSave, spec) as Promise<ThemeSpec>,
  themeDelete: (id: string) => ipcRenderer.invoke(CH.themeDelete, id) as Promise<boolean>,
  themeExport: (id: string) => ipcRenderer.invoke(CH.themeExport, id) as Promise<ThemeFileResult>,
  themeImport: (text: string) => ipcRenderer.invoke(CH.themeImport, text) as Promise<ThemeSpec>,

  /**
   * 拖拽文件的真实本地路径。
   * Electron 32+ 去掉了 File.path，官方替代就是 webUtils.getPathForFile —— 它必须在
   * preload 里同步调用（File 对象过不了 IPC 的结构化克隆）。
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  windowMinimize: () =>`
  )

  return out
})

for (const r of results) {
  console.log(`${r.changed ? 'OK  ' : 'SKIP'} ${r.rel}  (${r.label})`)
}
console.log('\n契约 v5 落盘完成')
