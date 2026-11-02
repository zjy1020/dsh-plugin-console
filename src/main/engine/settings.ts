/**
 * engine/settings.ts —— 插件台自身的设置存储。
 *
 * 落盘位置：<userData>/settings.json（Windows 下一般是
 *   C:\Users\<user>\AppData\Roaming\DSH 插件台\settings.json）
 *
 * 设计要点：
 * - 全程同步 + 内存缓存；读取失败 / 文件不存在一律退回 DEFAULT_SETTINGS。
 * - 写入失败静默兜底：绝不把异常抛到 IPC 层，内存值照常生效（UI 乐观更新）。
 * - 本模块不 import env.ts，避免与 env → settings 形成循环依赖。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type {
  AppSettings,
  ThemeSpec,
  WallpaperAdjust,
  WallpaperPalette,
  WallpaperRef
} from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/ipc'

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

let pathCache: string | null = null

/** settings.json 的绝对路径（带缓存） */
export function getSettingsPath(): string {
  if (pathCache) return pathCache
  let base = ''
  try {
    base = app.getPath('userData')
  } catch {
    base = ''
  }
  if (!base || typeof base !== 'string') base = join(homedir(), '.dsh-plugin-console')
  pathCache = join(base, 'settings.json')
  return pathCache
}

/* ------------------------------------------------------------------ *
 * 归一化（= 与 DEFAULT_SETTINGS 的深合并 + 类型校验）
 * ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asString(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt
}

/** 可空的路径 / URL 类字段：空串视作未设置 */
function asNullableString(v: unknown, dflt: string | null): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v
  if (v === null) return null
  return dflt
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return dflt
  const i = Math.round(n)
  return Math.min(max, Math.max(min, i))
}

/* ---- 外观字段用到的取值器 ---------------------------------------- */

function asEnum<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
}

/** 连续数值：不取整（透明度、模糊半径这些要小数） */
function asNum(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/**
 * hex 颜色。空串是**合法值**（含义是「不指定，跟随主题 / 壁纸」），所以不能当无效丢掉；
 * 只有「非空但格式不对」才退回默认值。
 */
function asHex(v: unknown, dflt: string): string {
  if (typeof v !== 'string') return dflt
  const s = v.trim()
  if (s === '') return ''
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : dflt
}

function normalizeAdjust(raw: unknown): WallpaperAdjust {
  const o = isPlainObject(raw) ? raw : {}
  const d = DEFAULT_SETTINGS.wallpaperAdjust
  return {
    brightness: asNum(o.brightness, d.brightness, 0.2, 2),
    saturation: asNum(o.saturation, d.saturation, 0, 2),
    contrast: asNum(o.contrast, d.contrast, 0.2, 2),
    blur: asNum(o.blur, d.blur, 0, 64),
    scale: asNum(o.scale, d.scale, 1, 3),
    offsetX: asNum(o.offsetX, d.offsetX, -1, 1),
    offsetY: asNum(o.offsetY, d.offsetY, -1, 1),
    maskDark: asNum(o.maskDark, d.maskDark, 0, 1),
    maskLight: asNum(o.maskLight, d.maskLight, 0, 1)
  }
}

function normalizePalette(raw: unknown): WallpaperPalette | null {
  if (!isPlainObject(raw)) return null
  const o = raw
  const hex = (v: unknown): string => (/^#[0-9a-f]{6}$/i.test(typeof v === 'string' ? v : '') ? (v as string) : '#808080')
  const unit = (v: unknown): number => asNum(v, 0.5, 0, 1)
  return {
    dominant: hex(o.dominant),
    secondary: hex(o.secondary),
    lightest: hex(o.lightest),
    darkest: hex(o.darkest),
    luma: unit(o.luma),
    p10: unit(o.p10),
    p50: unit(o.p50),
    p90: unit(o.p90),
    saturation: unit(o.saturation),
    detail: unit(o.detail),
    suggestedMode: asEnum(o.suggestedMode, ['dark', 'light'] as const, 'dark')
  }
}

/** 壁纸引用：path 是必须的（没有落盘路径的引用没有意义），其余可缺 */
function normalizeWallpaperRef(raw: unknown): WallpaperRef | null {
  if (!isPlainObject(raw)) return null
  const o = raw
  const path = asString(o.path, '')
  if (!path) return null
  const id = asString(o.id, '')
  return {
    id: id || `wp-${Date.now().toString(36)}`,
    name: asString(o.name, '未命名壁纸'),
    path,
    thumbPath: asNullableString(o.thumbPath, null),
    palette: normalizePalette(o.palette),
    width: typeof o.width === 'number' && Number.isFinite(o.width) ? Math.round(o.width) : null,
    height: typeof o.height === 'number' && Number.isFinite(o.height) ? Math.round(o.height) : null,
    kind: asEnum(o.kind, ['image', 'animated'] as const, 'image'),
    addedAt: asNum(o.addedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER)
  }
}

function normalizeTheme(raw: unknown): ThemeSpec | null {
  if (!isPlainObject(raw)) return null
  const o = raw
  const name = asString(o.name, '').trim()
  const id = asString(o.id, '').trim()
  if (!name || !id) return null
  const now = Date.now()
  return {
    id,
    name,
    // 内置主题从不落进 customThemes；从外部导入的包一律按自定义处理
    builtin: false,
    description: asString(o.description, ''),
    wallpaperId: asNullableString(o.wallpaperId, null),
    mode: asEnum(o.mode, ['dark', 'light'] as const, 'dark'),
    accent: asHex(o.accent, '#6ea8ff'),
    accent2: asHex(o.accent2, '#59e2d0'),
    ambient: asHex(o.ambient, '#2a3a5c'),
    sidebarOpacity: asNum(o.sidebarOpacity, 0.62, 0.2, 1),
    sidebarBlur: asNum(o.sidebarBlur, 28, 0, 64),
    sidebarRadius: asNum(o.sidebarRadius, 16, 0, 32),
    maskDark: asNum(o.maskDark, 0.35, 0, 1),
    maskLight: asNum(o.maskLight, 0.22, 0, 1),
    borderBrightness: asNum(o.borderBrightness, 0.16, 0, 1),
    shadowStrength: asNum(o.shadowStrength, 0.5, 0, 1),
    motionLevel: asEnum(o.motionLevel, ['full', 'reduced', 'off'] as const, 'full'),
    sidebarWidth: asInt(o.sidebarWidth, 248, 180, 420),
    sidebarExpanded: asBool(o.sidebarExpanded, true),
    createdAt: asNum(o.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: asNum(o.updatedAt, now, 0, Number.MAX_SAFE_INTEGER)
  }
}

/**
 * 把任意来源（磁盘 JSON / IPC patch / 手改文件）归一成一份完整 AppSettings。
 * 以 DEFAULT_SETTINGS 为底 → 新增字段自动带上默认值（这就是「深合并」：
 * AppSettings 是扁平的一层，唯独壁纸调参、壁纸引用、主题数组要单独深挖）。
 */
function normalize(raw: unknown): AppSettings {
  const o = isPlainObject(raw) ? raw : {}
  const d = DEFAULT_SETTINGS
  const theme = o.theme
  const rawThemes = Array.isArray(o.customThemes) ? o.customThemes : []
  const customThemes: ThemeSpec[] = []
  const seenThemeIds = new Set<string>()
  for (const t of rawThemes) {
    const spec = normalizeTheme(t)
    // 同 id 的主题只留第一条：手改配置文件很容易复制出重复 id，UI 上会变成两张点不动的卡
    if (spec && !seenThemeIds.has(spec.id)) {
      seenThemeIds.add(spec.id)
      customThemes.push(spec)
    }
  }
  return {
    dshHome: asNullableString(o.dshHome, d.dshHome),
    installRoot: asNullableString(o.installRoot, d.installRoot),
    defaultProfile: asNullableString(o.defaultProfile, d.defaultProfile),
    registry: asString(o.registry, d.registry).trim() || d.registry,
    proxy: asNullableString(o.proxy, d.proxy),
    extraPnpmArgs: asString(o.extraPnpmArgs, d.extraPnpmArgs),
    concurrency: asInt(o.concurrency, d.concurrency, 1, 64),
    forceBundle: asBool(o.forceBundle, d.forceBundle),
    // 老配置文件里没有这个字段 → 走默认值 true（收进托盘），行为跟升级前一致：点 ✕ 不直接退出
    minimizeToTray: asBool(o.minimizeToTray, d.minimizeToTray),
    theme: theme === 'dark' || theme === 'light' || theme === 'system' ? theme : d.theme,

    appearanceMode: asEnum(
      o.appearanceMode,
      ['dark', 'light', 'system'] as const,
      // 老配置只有 theme，用它兜底，别让升级把用户的深浅模式重置回暗色
      theme === 'light' || theme === 'dark' ? theme : d.appearanceMode
    ),
    material: asEnum(o.material, ['css', 'acrylic', 'mica'] as const, d.material),
    accent: asHex(o.accent, d.accent),
    ambient: asHex(o.ambient, d.ambient),
    motionLevel: asEnum(o.motionLevel, ['full', 'reduced', 'off'] as const, d.motionLevel),
    reduceTransparency: asBool(o.reduceTransparency, d.reduceTransparency),
    enhanceContrast: asBool(o.enhanceContrast, d.enhanceContrast),

    wallpaper: normalizeWallpaperRef(o.wallpaper),
    wallpaperFit: asEnum(
      o.wallpaperFit,
      ['cover', 'contain', 'fill', 'tile', 'center'] as const,
      d.wallpaperFit
    ),
    wallpaperAdjust: normalizeAdjust(o.wallpaperAdjust),
    wallpaperAuto: asBool(o.wallpaperAuto, d.wallpaperAuto),

    sidebarExpanded: asBool(o.sidebarExpanded, d.sidebarExpanded),
    sidebarWidth: asInt(o.sidebarWidth, d.sidebarWidth, 180, 420),
    sidebarRadius: asInt(o.sidebarRadius, d.sidebarRadius, 0, 32),
    sidebarOpacity: asNum(o.sidebarOpacity, d.sidebarOpacity, 0.2, 1),
    sidebarBlur: asInt(o.sidebarBlur, d.sidebarBlur, 0, 64),
    sidebarShowQuickActions: asBool(o.sidebarShowQuickActions, d.sidebarShowQuickActions),
    sidebarShowStatus: asBool(o.sidebarShowStatus, d.sidebarShowStatus),
    sidebarAutoHide: asBool(o.sidebarAutoHide, d.sidebarAutoHide),

    // 0 = 跟随主题。范围下限给 0.2 而不是 0：0 被哨兵占了，
    // 而 20% 以下的内容面板基本读不出字，本来也不该给到手。
    panelOpacity: asNum(o.panelOpacity, d.panelOpacity, 0, 1),
    panelBlur: asInt(o.panelBlur, d.panelBlur, 0, 60),

    activeThemeId: asString(o.activeThemeId, d.activeThemeId) || d.activeThemeId,
    customThemes
  }
}

/**
 * 归一化会造出新的嵌套对象，但 DEFAULT_SETTINGS 里的 wallpaperAdjust 是**同一个**字面量。
 * 谁要是拿 get() 的返回值改一笔，就会污染全局默认值 —— 所以出口处克隆一次嵌套结构。
 * 只在读盘 / set 时调，频率极低，不用心疼这点开销。
 */
function cloneSettings(s: AppSettings): AppSettings {
  return {
    ...s,
    wallpaper: s.wallpaper ? { ...s.wallpaper, palette: s.wallpaper.palette ? { ...s.wallpaper.palette } : null } : null,
    wallpaperAdjust: { ...s.wallpaperAdjust },
    customThemes: s.customThemes.map((t) => ({ ...t }))
  }
}


/* ------------------------------------------------------------------ *
 * 缓存 + 读
 * ------------------------------------------------------------------ */

let cache: AppSettings | null = null

function readFromDisk(): AppSettings {
  const p = getSettingsPath()
  try {
    if (!existsSync(p)) return cloneSettings({ ...DEFAULT_SETTINGS })
    const text = readFileSync(p, 'utf8')
    if (!text.trim()) return cloneSettings({ ...DEFAULT_SETTINGS })
    return normalize(JSON.parse(text))
  } catch {
    return cloneSettings({ ...DEFAULT_SETTINGS })
  }
}

/** 同步读取设置（带缓存，只在首次 / set 后重新读盘） */
export function get(): AppSettings {
  if (cache) return cache
  cache = readFromDisk()
  return cache
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

function persist(s: AppSettings): void {
  const p = getSettingsPath()
  try {
    mkdirSync(dirname(p), { recursive: true })
  } catch {
    /* 目录建不出来下面写盘也会失败，安静兜底 */
  }
  const body = JSON.stringify(s, null, 2)
  try {
    const tmp = `${p}.tmp`
    writeFileSync(tmp, body, 'utf8')
    try {
      renameSync(tmp, p)
    } catch {
      writeFileSync(p, body, 'utf8')
    }
  } catch {
    try {
      writeFileSync(p, body, 'utf8')
    } catch {
      /* 静默兜底：写不动就算了，内存值已经生效 */
    }
  }
}

const listeners = new Set<(s: AppSettings) => void>()

function emit(s: AppSettings): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb(s)
    } catch {
      /* 单个监听器出错不影响其它监听器 */
    }
  }
}

/** 局部更新设置，返回合并后的完整设置（写盘失败也不抛） */
export function set(patch: Partial<AppSettings>): AppSettings {
  const base = get()
  const merged: Record<string, unknown> = isPlainObject(patch) ? { ...base, ...patch } : { ...base }
  // wallpaperAdjust 是唯一会被「只改一项」地调用的嵌套对象：
  // 只传 brightness 时不能把其余 8 个键抹掉（滑杆逐个拖动就是这种调用方式）
  if (isPlainObject(patch) && isPlainObject(patch.wallpaperAdjust)) {
    merged.wallpaperAdjust = { ...base.wallpaperAdjust, ...patch.wallpaperAdjust }
  }
  const next = normalize(merged)
  cache = next
  persist(next)
  emit(next)
  return next
}

/** 订阅设置变化；返回取消订阅函数 */
export function onChange(cb: (s: AppSettings) => void): () => void {
  if (typeof cb !== 'function') return () => {}
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/* ------------------------------------------------------------------ *
 * 外观一键还原
 * ------------------------------------------------------------------ */

/**
 * 哪些字段算「外观」。
 *
 * 判断标准：**改了之后只影响这一台机器上的样子，不影响装插件的行为**。
 * 所以代理、并发数、registry、安装目录、DSH_HOME、托盘、默认 profile 都不在名单里 ——
 * 用户点「还原外观」是因为界面调乱了，不是想把配好的代理也清掉。
 * `customThemes` 也不在名单里：那是用户自己存的资产，「还原」不该删创作物。
 */
const APPEARANCE_KEYS = [
  'appearanceMode',
  'material',
  'accent',
  'ambient',
  'motionLevel',
  'reduceTransparency',
  'enhanceContrast',
  'wallpaper',
  'wallpaperFit',
  'wallpaperAdjust',
  'wallpaperAuto',
  'sidebarExpanded',
  'sidebarWidth',
  'sidebarRadius',
  'sidebarOpacity',
  'sidebarBlur',
  'sidebarShowQuickActions',
  'sidebarShowStatus',
  'sidebarAutoHide',
  'panelOpacity',
  'panelBlur',
  'activeThemeId'
] as const

/**
 * 把外观字段全部退回出厂默认，返回还原后的整份设置。
 *
 * 注意 `wallpaper` 默认是 null —— 这只表示「不选中任何壁纸」，`<userData>/wallpapers/`
 * 下的图片文件一个都不删。否则用户手一抖点还原，之前导入的图就全没了。
 */
export function resetAppearance(): AppSettings {
  const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const key of APPEARANCE_KEYS) {
    const value = d[key]
    // 深拷一层：wallpaperAdjust 直接引用 DEFAULT_SETTINGS 的字面量，后面谁改一笔就污染全局默认
    patch[key] = value && typeof value === 'object' ? { ...(value as object) } : value
  }
  return set(patch as Partial<AppSettings>)
}
