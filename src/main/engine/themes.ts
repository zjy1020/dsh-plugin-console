/**
 * engine/themes.ts —— 主题（= 一整套侧边栏环境，不是一组颜色）。
 *
 * 两个来源：
 * - **内置 5 套**：写死在代码里的常量数组，`builtin: true`，不许改名 / 删除。
 *   它们同时也是「界面参数探针」—— 用户不知道怎么调的时候，选一套内置的就能回到
 *   一个被认真调过的状态。
 * - **用户自定义**：存在 `settings.customThemes` 里（settings.json 的一部分）。
 *
 * 应用一套主题 = 把 ThemeSpec 的字段逐个写回 AppSettings。字段名是**一一对应**的，
 * 这是契约 v5 定下的规矩：加一个外观字段就要同时想清楚主题要不要覆盖它，
 * 否则用户会发现「换主题时有些东西没跟着变」。
 *
 * 导出成 `.dsh-theme.json` 时**不带壁纸图片本身**（可能几十兆），只带壁纸调参 ——
 * 主题包的意义是「换台机器也能得到同一套观感」，壁纸让用户自己配。
 */

import { dialog } from 'electron'
import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AppSettings, ThemeExportFile, ThemeFileResult, ThemeSpec } from '../../shared/types'
import * as settings from './settings'

export const THEME_FILE_FORMAT = 'dsh-plugin-console-theme'

/* ------------------------------------------------------------------ *
 * 内置主题
 * ------------------------------------------------------------------ */

function spec(part: Omit<ThemeSpec, 'builtin' | 'createdAt' | 'updatedAt'>): ThemeSpec {
  // 内置主题不落盘，时间戳只为了让类型完整；用 0 表明「不是用户创建的」
  return { ...part, builtin: true, createdAt: 0, updatedAt: 0 }
}

/**
 * 五套内置主题。
 * 每套都同时定死了深/浅模式、强调色、环境光、透明度、模糊、遮罩与边框亮度 ——
 * 只改一个强调色那叫换皮，不叫主题。
 */
const BUILTIN: ThemeSpec[] = [
  spec({
    id: 'deep-sea-blue',
    name: '深海蓝',
    description: '深蓝黑底 + 蓝紫强调 + 青色状态点。适合开发和夜间长时间使用。',
    wallpaperId: null,
    mode: 'dark',
    accent: '#6ea8ff',
    accent2: '#59e2d0',
    ambient: '#1c2a47',
    sidebarOpacity: 0.6,
    sidebarBlur: 30,
    sidebarRadius: 16,
    maskDark: 0.38,
    maskLight: 0.22,
    borderBrightness: 0.18,
    shadowStrength: 0.58,
    motionLevel: 'full',
    sidebarWidth: 248,
    sidebarExpanded: true
  }),
  spec({
    id: 'aurora-purple',
    name: '极光紫',
    description: '紫与青的环境光，透明度偏高，面板更像一层玻璃。适合 AI 创作和视觉型工具。',
    wallpaperId: null,
    mode: 'dark',
    accent: '#b48cff',
    accent2: '#5ee0ff',
    ambient: '#2e1f4d',
    sidebarOpacity: 0.5,
    sidebarBlur: 34,
    sidebarRadius: 18,
    maskDark: 0.3,
    maskLight: 0.2,
    borderBrightness: 0.2,
    shadowStrength: 0.5,
    motionLevel: 'full',
    sidebarWidth: 248,
    sidebarExpanded: true
  }),
  spec({
    id: 'morning-mist',
    name: '柔和晨雾',
    description: '浅灰蓝底 + 白色亚克力面板 + 低饱和蓝按钮。适合白天办公和明亮壁纸。',
    wallpaperId: null,
    mode: 'light',
    accent: '#4a72c8',
    accent2: '#3f9e8c',
    ambient: '#dce4f0',
    sidebarOpacity: 0.72,
    sidebarBlur: 26,
    sidebarRadius: 16,
    maskDark: 0.3,
    maskLight: 0.3,
    borderBrightness: 0.1,
    shadowStrength: 0.34,
    motionLevel: 'full',
    sidebarWidth: 248,
    sidebarExpanded: true
  }),
  spec({
    id: 'crimson-night',
    name: '深红夜幕',
    description: '深色底 + 暗红与紫色高光。适合游戏、创作和沉浸式场景。',
    wallpaperId: null,
    mode: 'dark',
    accent: '#ff6b7a',
    accent2: '#c17bff',
    ambient: '#3a1220',
    sidebarOpacity: 0.62,
    sidebarBlur: 30,
    sidebarRadius: 14,
    maskDark: 0.42,
    maskLight: 0.24,
    borderBrightness: 0.19,
    shadowStrength: 0.6,
    motionLevel: 'full',
    sidebarWidth: 248,
    sidebarExpanded: true
  }),
  spec({
    id: 'mono-graphite',
    name: '极简灰阶',
    description: '几乎不引入环境光，透明度和模糊都压到最低。适合专注工作和信息密集型场景。',
    wallpaperId: null,
    mode: 'dark',
    accent: '#9aa6b8',
    accent2: '#7f8ea3',
    ambient: '#20242b',
    sidebarOpacity: 0.86,
    sidebarBlur: 12,
    sidebarRadius: 10,
    maskDark: 0.5,
    maskLight: 0.34,
    borderBrightness: 0.12,
    shadowStrength: 0.28,
    motionLevel: 'reduced',
    sidebarWidth: 248,
    sidebarExpanded: true
  })
]

/** 没有激活主题 / 主题被删掉时的兜底 */
const FALLBACK_ID = 'deep-sea-blue'

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

export function builtins(): ThemeSpec[] {
  return BUILTIN.map((t) => ({ ...t }))
}

/** 内置 + 自定义，内置在前 */
export function list(): ThemeSpec[] {
  const custom = settings.get().customThemes ?? []
  return [...builtins(), ...custom.map((t) => ({ ...t, builtin: false }))]
}

export function find(id: string): ThemeSpec | null {
  const hit = BUILTIN.find((t) => t.id === id)
  if (hit) return { ...hit }
  const c = (settings.get().customThemes ?? []).find((t) => t.id === id)
  return c ? { ...c, builtin: false } : null
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

/**
 * 把主题写回 AppSettings。
 * 只覆盖外观字段 —— 主题不是「设置快照」，不能顺手把 registry / 代理那些也改了。
 */
export function apply(id: string): AppSettings {
  const t = find(id)
  if (!t) {
    console.warn(`[主题] 找不到主题 ${id}，保持当前设置不变`)
    return settings.get()
  }
  return settings.set({
    activeThemeId: t.id,
    appearanceMode: t.mode,
    accent: t.accent,
    ambient: t.ambient,
    sidebarOpacity: t.sidebarOpacity,
    sidebarBlur: t.sidebarBlur,
    sidebarRadius: t.sidebarRadius,
    sidebarWidth: t.sidebarWidth,
    sidebarExpanded: t.sidebarExpanded,
    motionLevel: t.motionLevel,
    wallpaperAdjust: {
      ...settings.get().wallpaperAdjust,
      maskDark: t.maskDark,
      maskLight: t.maskLight
    }
  })
}

/**
 * 启动时把「当前主题」的强调色与环境色真正补进设置。
 *
 * 为什么需要这一步：`accent` / `ambient` 的语义是「空串 = 跟随当前主题」，
 * 但渲染层只认具体颜色值 —— 空串会让它落回 tokens.css 里那个通用默认蓝。
 * 结果就是：界面说「当前主题：深海蓝」，画的却是默认蓝，五套主题看起来只剩
 * 深浅模式的差别。设置文件和界面对齐了，用户才不会觉得主题是摆设。
 *
 * 只在为空时补，且不碰用户在设置面板里手调过的值。
 */
export function syncActiveTheme(): AppSettings {
  const cur = settings.get()
  if (cur.accent && cur.ambient) return cur
  const t = find(cur.activeThemeId || '')
  if (!t) return cur
  return settings.set({
    ...(cur.accent ? {} : { accent: t.accent }),
    ...(cur.ambient ? {} : { ambient: t.ambient })
  })
}

/* ------------------------------------------------------------------ *
 * 自定义主题的增删
 * ------------------------------------------------------------------ */

function newThemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const rand = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')
  return `custom-${slug || 'theme'}-${rand}`
}

/**
 * 保存自定义主题。
 * - 带 id 且存在 → 更新（内置主题拒绝更新，返回 BuiltinProtectedError 语义的结果由调用方处理）
 * - 不带 id → 以当前设置为底新建一套
 */
export function save(input: Partial<ThemeSpec> & { name: string }): ThemeSpec {
  const cur = settings.get()
  const name = (input.name ?? '').trim() || '未命名主题'
  const now = Date.now()

  const base: ThemeSpec = {
    id: input.id ?? '',
    name,
    builtin: false,
    description: input.description ?? '',
    wallpaperId: input.wallpaperId ?? cur.wallpaper?.id ?? null,
    mode: input.mode ?? (cur.appearanceMode === 'light' ? 'light' : 'dark'),
    accent: input.accent || cur.accent || '#6ea8ff',
    accent2: input.accent2 || '#59e2d0',
    ambient: input.ambient || cur.ambient || '#1c2a47',
    sidebarOpacity: input.sidebarOpacity ?? cur.sidebarOpacity,
    sidebarBlur: input.sidebarBlur ?? cur.sidebarBlur,
    sidebarRadius: input.sidebarRadius ?? cur.sidebarRadius,
    maskDark: input.maskDark ?? cur.wallpaperAdjust.maskDark,
    maskLight: input.maskLight ?? cur.wallpaperAdjust.maskLight,
    borderBrightness: input.borderBrightness ?? 0.18,
    shadowStrength: input.shadowStrength ?? 0.5,
    motionLevel: input.motionLevel ?? cur.motionLevel,
    sidebarWidth: input.sidebarWidth ?? cur.sidebarWidth,
    sidebarExpanded: input.sidebarExpanded ?? cur.sidebarExpanded,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  }

  const existing = base.id ? (cur.customThemes ?? []).find((t) => t.id === base.id) : undefined
  if (existing) {
    base.createdAt = existing.createdAt
    base.builtin = false
    const next = (cur.customThemes ?? []).map((t) => (t.id === base.id ? base : t))
    settings.set({ customThemes: next })
    return base
  }

  if (!base.id) base.id = newThemeId(name)
  // id 撞了内置主题 → 换一个，别让自定义主题抢走内置的 id
  if (BUILTIN.some((t) => t.id === base.id)) base.id = newThemeId(name)
  settings.set({ customThemes: [...(cur.customThemes ?? []), base] })
  return base
}

/** 删除自定义主题。内置主题删不掉，返回 false */
export function remove(id: string): boolean {
  if (BUILTIN.some((t) => t.id === id)) return false
  const cur = settings.get()
  const before = cur.customThemes ?? []
  const next = before.filter((t) => t.id !== id)
  if (next.length === before.length) return false
  const patch: Partial<AppSettings> = { customThemes: next }
  // 删掉的正好是当前激活的主题 → 退回内置兜底，否则界面会停在一套不存在的参数上
  if (cur.activeThemeId === id) patch.activeThemeId = FALLBACK_ID
  settings.set(patch)
  return true
}

/* ------------------------------------------------------------------ *
 * 导出 / 导入
 * ------------------------------------------------------------------ */

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'theme'
}

export async function exportTheme(win: BrowserWindow | null, id: string): Promise<ThemeFileResult> {
  const t = find(id)
  if (!t) return { ok: false, path: null, error: '找不到这套主题' }
  try {
    const opts: SaveDialogOptions = {
      title: '导出主题',
      defaultPath: `${sanitizeFileName(t.name)}.dsh-theme.json`,
      filters: [{ name: 'DSH 主题包', extensions: ['json'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, path: null, error: '已取消' }

    const payload: ThemeExportFile = {
      format: THEME_FILE_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      theme: { ...t, builtin: false },
      // 壁纸图片本身不带走，只带调参
      wallpaperAdjust: settings.get().wallpaperAdjust
    }
    writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: res.filePath, error: null }
  } catch (err) {
    return { ok: false, path: null, error: `导出失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 从主题包文本导入。不弹任何对话框，路径由调用方给（也可以直接粘贴 JSON） */
export function importTheme(text: string): ThemeSpec {
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('这个文件不是主题包')
  const o = raw as Record<string, unknown>
  if (o.format !== THEME_FILE_FORMAT) throw new Error('这个文件不是 DSH 插件台的主题包（format 字段不对）')
  const t = o.theme
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('主题包里缺少 theme 字段')

  const spec0 = t as Partial<ThemeSpec>
  const name = typeof spec0.name === 'string' && spec0.name.trim() ? spec0.name.trim() : '导入的主题'
  // 导入的主题永远当自定义处理：id 重了就换新的，绝不覆盖内置主题
  const incomingId = typeof spec0.id === 'string' ? spec0.id : ''
  const clash = !incomingId || BUILTIN.some((x) => x.id === incomingId) || (settings.get().customThemes ?? []).some((x) => x.id === incomingId)
  return save({ ...spec0, name, id: clash ? '' : incomingId })
}

/** 从文件导入（走系统对话框） */
export async function importThemeFile(win: BrowserWindow | null): Promise<ThemeSpec> {
  const opts: OpenDialogOptions = {
    title: '导入主题包',
    buttonLabel: '导入',
    properties: ['openFile'],
    filters: [{ name: 'DSH 主题包', extensions: ['json'] }]
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) throw new Error('已取消')
  const p = res.filePaths[0]
  if (!existsSync(p)) throw new Error('这个文件不存在')
  return importTheme(readFileSync(p, 'utf8'))
}

/** 主题包默认存到哪（给「打开导出目录」之类的入口用） */
export function suggestPath(name: string): string {
  return join(process.cwd(), `${sanitizeFileName(name)}.dsh-theme.json`)
}
