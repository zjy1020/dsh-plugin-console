/**
 * engine/wallpaper.ts —— 壁纸的导入、存储、取色与「自动适配」。
 *
 * 落盘布局（全部在 <userData>/wallpapers/ 下）：
 *   index.json          壁纸索引（{ version, entries: WallpaperRef[] }）
 *   <id>.<ext>          原图副本
 *   thumbs/<id>.png     缩略图（给「最近使用」列表用）
 *
 * 三条设计决定，都是踩过的坑：
 *
 * 1) **永远复制用户的原图**。`WallpaperRef.path` 指向我们目录里的副本，绝不引用
 *    用户的原位置。用户从「下载」目录选张图，回头一清理，壁纸就变成一片空白；
 *    原图还可能在移动硬盘 / U 盘上。副本是我们唯一能保证存在的东西。
 *
 * 2) **零新依赖**。缩略图用 `nativeImage.createThumbnailFromPath`，取色用
 *    `nativeImage.toBitmap()` 直接拿原始像素自己算。不引 sharp / jimp /
 *    node-vibrant —— 为了几张壁纸多背几十兆原生二进制不值得，而且 Electron
 *    自带的解码器对 webp / gif 的支持跟我们渲染层完全一致。
 *
 * 3) **自动适配必须能解释自己**。`WallpaperAutoFit.reasons` 里每一条都是给用户看的
 *    中文句子。自动适配是个黑箱，调完不给理由，用户只会觉得「它把我的界面搞乱了」。
 */

import { app, dialog, nativeImage } from 'electron'
import type { BrowserWindow, NativeImage, OpenDialogOptions } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

import type {
  WallpaperAdjust,
  WallpaperAutoFit,
  WallpaperEntry,
  WallpaperImportResult,
  WallpaperPalette,
  WallpaperRef
} from '../../shared/types'
import * as settings from './settings'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const INDEX_VERSION = 1

/** 认识的图片扩展名。跟渲染层 <img> 能显示的集合对齐 */
const OK_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 单文件上限。壁纸基本都在 5MB 以内，40MB 是给 4K 原图留的余量 */
const MAX_BYTES = 40 * 1024 * 1024

/** 取色时把图缩到这个宽度 —— 160px 足够算分位数和主色，又快到可以忽略 */
const SAMPLE_WIDTH = 160

/** 缩略图尺寸。列表卡片按 480×300 出图够用了 */
const THUMB_W = 480
const THUMB_H = 300

/* ------------------------------------------------------------------ *
 * 目录
 * ------------------------------------------------------------------ */

function baseDir(): string {
  let root = ''
  try {
    root = app.getPath('userData')
  } catch {
    root = ''
  }
  if (!root) root = join(process.cwd(), '.dsh-plugin-console')
  return join(root, 'wallpapers')
}

function thumbDir(): string {
  return join(baseDir(), 'thumbs')
}

function indexPath(): string {
  return join(baseDir(), 'index.json')
}

/** 壁纸目录的绝对路径（给「打开壁纸目录」按钮用） */
export function getWallpaperDir(): string {
  return baseDir()
}

function ensureDirs(): void {
  try {
    mkdirSync(thumbDir(), { recursive: true })
  } catch {
    /* 建不出来后面写盘也会失败，安静兜底 */
  }
}

/* ------------------------------------------------------------------ *
 * 索引
 * ------------------------------------------------------------------ */

interface IndexFile {
  version: number
  entries: WallpaperRef[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readIndex(): IndexFile {
  const p = indexPath()
  const empty: IndexFile = { version: INDEX_VERSION, entries: [] }
  if (!existsSync(p)) return empty
  try {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (!isPlainObject(raw)) throw new Error('索引不是对象')
    const list = Array.isArray(raw.entries) ? raw.entries : []
    // 手改索引 / 半截写入都可能塞进脏条目，逐条过滤比整体放弃强
    const entries = list.filter((e): e is WallpaperRef => isPlainObject(e) && typeof e.id === 'string' && typeof e.path === 'string')
    return { version: INDEX_VERSION, entries }
  } catch {
    // 索引坏了不能每次启动都炸 —— 重建空索引，原图还留在目录里，用户能重新导入
    console.warn('[壁纸] index.json 读不动，已重建空索引（原图文件没有被删）')
    return empty
  }
}

function writeIndex(idx: IndexFile): void {
  const p = indexPath()
  const body = JSON.stringify(idx, null, 2)
  const tmp = `${p}.${process.pid}.tmp`
  try {
    ensureDirs()
    writeFileSync(tmp, body, 'utf8')
    try {
      renameSync(tmp, p)
    } catch {
      writeFileSync(p, body, 'utf8')
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 清不掉 tmp 不影响结果 */
      }
    }
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 同上 */
    }
    console.warn('[壁纸] 写索引失败，本次改动只在内存里生效')
  }
}

/** 同毫秒连续导入也不能撞 id */
function newId(): string {
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')
  return `wp-${Date.now().toString(36)}${rand}`
}

/* ------------------------------------------------------------------ *
 * 颜色工具
 * ------------------------------------------------------------------ */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function hex2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)))
  return v.toString(16).padStart(2, '0')
}

function toHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

/** Rec.709 感知亮度，返回 0–1 */
function luma709(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
  else if (max === gg) h = ((bb - rr) / d + 2) / 6
  else h = ((rr - gg) / d + 4) / 6
  return [h, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t
  if (tt < 0) tt += 1
  if (tt > 1) tt -= 1
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

function hslToHex(h: number, s: number, l: number): string {
  const ss = clamp01(s)
  const ll = clamp01(l)
  if (ss === 0) {
    const v = ll * 255
    return toHex(v, v, v)
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const p = 2 * ll - q
  return toHex(
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255
  )
}

function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.58, 0.3, 0.55]
  const n = Number.parseInt(m[1], 16)
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

/* ------------------------------------------------------------------ *
 * 取色 / 特征提取
 * ------------------------------------------------------------------ */

/** 分位数：输入已排序的升序数组 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = clamp01(q) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * 从原始像素算客观特征。
 *
 * 实现取舍：
 * - 亮度用 **分位数** 而不是均值。一张 90% 纯黑 + 10% 纯白的图均值是 0.5，可人眼
 *   看到的是「很暗」，均值会把它判成亮色壁纸，进而给出深色文字 —— 直接读不清。
 * - 主色用 **5bit 量化的直方图**，并跳过接近纯黑 / 纯白两端以及几乎无饱和度的像素。
 *   它们数量常常最大，但作为「品牌主色」毫无意义（把一张灰照片的主色定成黑，
 *   后面推出的强调色就没法看了）。
 * - `detail` 用 **相邻像素平均绝对差**，不做边缘检测或连通域分析 —— 我们要的只是
 *   一个便宜且稳定的标量，用来回答「背景是不是复杂到会干扰文字」。
 */
function analyzeImage(img: NativeImage): WallpaperPalette | null {
  try {
    const small = img.resize({ width: SAMPLE_WIDTH, quality: 'good' })
    const size = small.getSize()
    if (!size.width || !size.height) return null

    // toBitmap() 给的是 BGRA，每像素 4 字节 —— 通道顺序搞错颜色会全反
    const buf = small.toBitmap()
    const px = Math.floor(buf.length / 4)
    if (px <= 0) return null

    const lumas: number[] = new Array(px)
    const gray: number[] = new Array(px)

    // 量化直方图：RGB 各 5 bit → 32768 个桶，用 Map 装稀疏的
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
    // 用于取「最亮 / 最暗」处颜色的极小顶堆做不到，就直接记下 5% / 95% 分位附近两侧的最小值
    let satSum = 0
    let best95 = { l: -1, r: 0, g: 0, b: 0 }
    let best5 = { l: 2, r: 0, g: 0, b: 0 }

    for (let i = 0; i < px; i += 1) {
      const o = i * 4
      const b = buf[o]
      const g = buf[o + 1]
      const r = buf[o + 2]
      const l = luma709(r, g, b)
      lumas[i] = l
      gray[i] = l

      const [, s] = rgbToHsl(r, g, b)
      satSum += s

      if (l > best95.l) best95 = { l, r, g, b }
      if (l < best5.l) best5 = { l, r, g, b }

      // 跳过「像黑」「像白」和「几乎没有颜色」的像素，它们不该参与主色投票
      if (l < 0.06 || l > 0.94 || s < 0.08) continue
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      const cur = buckets.get(key)
      if (cur) {
        cur.n += 1
        cur.r += r
        cur.g += g
        cur.b += b
      } else {
        buckets.set(key, { n: 1, r, g, b })
      }
    }

    const sorted = lumas.slice().sort((a, b) => a - b)
    const luma = sorted.reduce((a, b) => a + b, 0) / sorted.length
    const p10 = quantile(sorted, 0.1)
    const p50 = quantile(sorted, 0.5)
    const p90 = quantile(sorted, 0.9)

    // 邻居差：横向 + 纵向一起算，最后归一化。棋盘格 / 噪点会很高，纯色渐变接近 0
    let diffSum = 0
    let diffCnt = 0
    const w = size.width
    const h = size.height
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (x + 1 < w) {
          diffSum += Math.abs(gray[i + 1] - gray[i])
          diffCnt += 1
        }
        if (y + 1 < h) {
          diffSum += Math.abs(gray[i + w] - gray[i])
          diffCnt += 1
        }
      }
    }
    const detail = diffCnt > 0 ? clamp01(diffSum / diffCnt) : 0

    // 主色 / 次色：取像素最多的两个桶（次色要排除与主色相邻的桶，否则颜色几乎一样）
    const ranked = Array.from(buckets.entries()).sort((a, b) => b[1].n - a[1].n)
    const pick = (e: { n: number; r: number; g: number; b: number }): string =>
      toHex(e.r / e.n, e.g / e.n, e.b / e.n)

    let dominant = '#4a5a7a'
    let secondary = '#2a3446'
    if (ranked.length > 0) {
      dominant = pick(ranked[0][1])
      const mainKey = ranked[0][0]
      const mr = (mainKey >> 10) & 31
      const mg = (mainKey >> 5) & 31
      const mb = mainKey & 31
      const far = ranked.find(([k]) => Math.abs(((k >> 10) & 31) - mr) + Math.abs(((k >> 5) & 31) - mg) + Math.abs((k & 31) - mb) > 6)
      if (far) secondary = pick(far[1])
      else if (ranked.length > 1) secondary = pick(ranked[1][1])
    } else {
      // 整张图都接近灰/黑/白 —— 让主色退回到「最亮处的颜色」，至少不是死灰
      dominant = toHex(best95.r, best95.g, best95.b)
      secondary = toHex(best5.r, best5.g, best5.b)
    }

    return {
      dominant,
      secondary,
      lightest: toHex(best95.r, best95.g, best95.b),
      darkest: toHex(best5.r, best5.g, best5.b),
      luma: clamp01(luma),
      p10: clamp01(p10),
      p50: clamp01(p50),
      p90: clamp01(p90),
      saturation: clamp01(satSum / px),
      detail: clamp01(detail),
      suggestedMode: p50 < 0.42 || luma < 0.45 ? 'dark' : 'light'
    }
  } catch (err) {
    console.warn('[壁纸] 取色失败（壁纸仍然可用，只是没有自动适配依据）：', err)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 自动适配
 * ------------------------------------------------------------------ */

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * 从客观特征推出一整套界面参数。
 *
 * 两条不能违反的规矩：
 * - **强调色不能直接用主色。** 一张灰壁纸的主色是灰的，直接拿来当强调色，整个界面的
 *   重点色就废了。所以转到 HSL 里往上推饱和度和亮度。
 * - **边框要朝背景的反方向走。** 边框的作用是把面板从壁纸里「拉」出来：暗壁纸配亮边框，
 *   亮壁纸配暗边框。跟着背景走就等于把边框藏起来。
 */
function deriveAutoFit(p: WallpaperPalette | null, current: string): WallpaperAutoFit {
  const reasons: string[] = []
  const fallbackMode: 'dark' | 'light' = current === 'light' ? 'light' : 'dark'
  if (!p) {
    return {
      mode: fallbackMode,
      sidebarOpacity: 0.62,
      sidebarBlur: 28,
      maskDark: 0.35,
      maskLight: 0.22,
      borderBrightness: 0.16,
      accent: '',
      ambient: '',
      textTone: fallbackMode === 'dark' ? 'light' : 'dark',
      enhanceReadability: false,
      reasons: ['这张壁纸读不出颜色（可能是格式特殊），沿用当前的默认参数。']
    }
  }

  // mode：用户明确选了深/浅就以用户为准，只有「跟随系统」时才听壁纸的
  const mode: 'dark' | 'light' = current === 'light' || current === 'dark' ? current : p.suggestedMode
  if (current === 'light' || current === 'dark') {
    reasons.push(`你手动选的是${mode === 'dark' ? '深色' : '浅色'}模式，优先按你的选择走。`)
  } else {
    reasons.push(
      `壁纸中位亮度 ${round2(p.p50)}、平均亮度 ${round2(p.luma)}，判定为偏${mode === 'dark' ? '暗' : '亮'}的图，建议${mode === 'dark' ? '深色' : '浅色'}模式。`
    )
  }

  const busy = p.detail > 0.5
  const veryBusy = p.detail > 0.65
  const extremeTone = Math.abs(p.luma - 0.5)

  // 透明度：背景越复杂、越极端，面板就要越不透明，否则文字读不清
  let sidebarOpacity = 0.62
  if (busy) sidebarOpacity += 0.12
  if (veryBusy) sidebarOpacity += 0.08
  sidebarOpacity += Math.min(0.1, extremeTone * 0.2)
  sidebarOpacity = round2(Math.min(0.95, sidebarOpacity))
  if (busy || extremeTone > 0.3) {
    reasons.push(`背景细节较多（复杂度 ${round2(p.detail)}），侧边栏不透明度提到 ${sidebarOpacity}，保证文字压得住。`)
  }

  // 模糊：细节密集就多模糊一点，把图案的锐利边缘揉开
  const sidebarBlur = busy ? Math.round(28 + Math.min(16, (p.detail - 0.5) * 80)) : 28
  if (sidebarBlur > 28) reasons.push(`模糊半径加到 ${sidebarBlur}px，把背景的琐碎纹理揉开。`)

  // 遮罩：模式决定压哪一头
  const maskDark = round2(Math.min(0.8, 0.35 + (veryBusy ? 0.2 : busy ? 0.1 : 0) + (mode === 'dark' ? 0.05 : 0)))
  const maskLight = round2(Math.min(0.7, 0.22 + (veryBusy ? 0.22 : busy ? 0.12 : 0)))
  if (veryBusy) {
    reasons.push(`画面比较花（复杂度 ${round2(p.detail)}），遮罩加深到深色 ${maskDark} / 浅色 ${maskLight}，避免图案和人脸干扰阅读。`)
  }

  // 边框：朝背景反方向
  const borderBrightness = round2(clamp01(0.16 + (0.5 - p.p50) * 0.4))
  reasons.push(
    p.p50 < 0.5
      ? `壁纸偏暗，边框亮度提到 ${borderBrightness}，让面板从背景里浮出来。`
      : `壁纸偏亮，边框亮度压到 ${borderBrightness}，用暗边把面板和背景分开。`
  )

  // 强调色：从主色推到「能当强调色」的区域；灰壁纸强行给一点饱和
  const [ah, as0, al0] = hexToHsl(p.dominant)
  const accent = hslToHex(ah, Math.max(as0, 0.45), Math.min(0.82, Math.max(0.48, al0 + 0.18)))
  const ambient = hslToHex(ah, Math.max(0.08, as0 * 0.6), clamp01(Math.max(0.1, al0 * 0.35)))
  if (as0 < 0.2) {
    reasons.push(`壁纸本身没什么颜色（饱和度 ${round2(as0)}），强调色从主色往高饱和方向推了一档，否则整个界面会发灰。`)
  } else {
    reasons.push(`强调色取自壁纸主色 ${p.dominant}，提亮提饱和后得到 ${accent}。`)
  }

  return {
    mode,
    sidebarOpacity,
    sidebarBlur,
    maskDark,
    maskLight,
    borderBrightness,
    accent,
    ambient,
    textTone: mode === 'dark' ? 'light' : 'dark',
    enhanceReadability: veryBusy || p.p90 - p.p10 > 0.6,
    reasons
  }
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

function extOk(filePath: string): boolean {
  return OK_EXT.has(extname(filePath).toLowerCase())
}

function copyName(filePath: string): string {
  const n = basename(filePath)
  return n.replace(/\.[^.]+$/, '') || '未命名壁纸'
}

/**
 * 真正的导入实现。`importViaDialog` 和 `importFromPath` 都走这里，
 * 区别只在于路径从哪来。
 */
function importOne(filePath: string): WallpaperImportResult {
  const fail = (error: string): WallpaperImportResult => ({ ok: false, ref: null, autoFit: null, error })

  if (!filePath || !filePath.trim()) return fail('没有拿到文件路径')
  const p = filePath.trim()
  if (!existsSync(p)) return fail('这个文件不存在或者已经被移走了')

  let size = 0
  try {
    const st = statSync(p)
    if (!st.isFile()) return fail('拖进来的不是文件（文件夹不能当壁纸）')
    size = st.size
  } catch {
    return fail('读不到这个文件的信息（可能是权限问题）')
  }
  if (size <= 0) return fail('这个文件是空的')
  if (size > MAX_BYTES) {
    return fail(`这张图有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 40 MB 上限，先压一下再导入`)
  }
  if (!extOk(p)) {
    const ext = extname(p).toLowerCase() || '（没有扩展名）'
    return fail(`不认识 ${ext} 这个格式，支持 png / jpg / webp / gif / bmp`)
  }

  // 能不能解码交给 Electron 自己判断 —— 扩展名骗人（比如 .txt 改名成 .png）在这里被挡住
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return fail('这个文件打不开，可能不是图片格式')

  const id = newId()
  const ext = extname(p).toLowerCase()
  const dest = join(baseDir(), `${id}${ext}`)
  ensureDirs()
  try {
    copyFileSync(p, dest)
  } catch (err) {
    return fail(`复制图片到壁纸目录失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 缩略图失败不算导入失败 —— 列表没有缩略图也能用，UI 要能接受 thumbPath = null
  const thumbPath = join(thumbDir(), `${id}.png`)
  void nativeImage
    .createThumbnailFromPath(dest, { width: THUMB_W, height: THUMB_H })
    .then((t) => {
      try {
        if (!t.isEmpty()) writeFileSync(thumbPath, t.toPNG())
      } catch (err) {
        console.warn('[壁纸] 缩略图写盘失败（不影响使用）：', err)
      }
    })
    .catch((err: unknown) => console.warn('[壁纸] 缩略图生成失败（不影响使用）：', err))

  const size2 = img.getSize()
  const ref: WallpaperRef = {
    id,
    name: copyName(p),
    path: dest,
    // 缩略图是异步生成的，这里几乎必然是 null；UI 拿到 null 就走原图当缩略图。
    // 真正的 thumbPath 在下一次 list() 时才读得到。
    thumbPath: null,
    palette: null,
    width: size2.width || null,
    height: size2.height || null,
    // 当前只导入静态图；animated 是给动态壁纸预留的
    kind: 'image',
    addedAt: Date.now()
  }

  const palette = analyzeImage(img)
  ref.palette = palette

  const idx = readIndex()
  idx.entries.unshift(ref)
  writeIndex(idx)

  return { ok: true, ref, autoFit: deriveAutoFit(palette, settings.get().appearanceMode), error: null }
}

/** 从系统文件对话框选图导入（用户取消返回 ok:false + error:'已取消'） */
export async function importViaDialog(win: BrowserWindow | null): Promise<WallpaperImportResult> {
  try {
    const opts: OpenDialogOptions = {
      title: '选一张壁纸',
      buttonLabel: '导入',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, ref: null, autoFit: null, error: '已取消' }
    }
    return importOne(res.filePaths[0])
  } catch (err) {
    return {
      ok: false,
      ref: null,
      autoFit: null,
      error: `打开文件对话框失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 从一条已知本地路径导入（拖拽进来就走这条） */
export async function importFromPath(filePath: string): Promise<WallpaperImportResult> {
  try {
    return importOne(filePath)
  } catch (err) {
    return {
      ok: false,
      ref: null,
      autoFit: null,
      error: `导入失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/* ------------------------------------------------------------------ *
 * 列表 / 删除 / 置顶
 * ------------------------------------------------------------------ */

/**
 * 置顶状态单独存一份，不写进 index.json。
 * 理由：置顶是「界面偏好」，壁纸条目是「资产」—— 两者生命周期不同，混在一起以后
 * 想换索引结构就得迁移用户数据。
 */
const pinned = new Set<string>(readPinned())

function pinnedPath(): string {
  return join(baseDir(), 'pinned.json')
}

function readPinned(): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(pinnedPath(), 'utf8'))
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writePinned(): void {
  try {
    ensureDirs()
    writeFileSync(pinnedPath(), JSON.stringify(Array.from(pinned), null, 2), 'utf8')
  } catch {
    console.warn('[壁纸] 置顶状态写盘失败，只在本次运行内生效')
  }
}

/** 列出所有壁纸。`path` / `thumbPath` 为 null 表示文件被用户从目录里手动删了 —— 这是有意的，不兜底重建 */
export function list(): WallpaperEntry[] {
  try {
    const idx = readIndex()
    const out: WallpaperEntry[] = idx.entries.map((e) => ({
      id: e.id,
      name: e.name,
      path: existsSync(e.path) ? e.path : null,
      thumbPath: e.thumbPath && existsSync(e.thumbPath) ? e.thumbPath : null,
      palette: e.palette ?? null,
      width: e.width ?? null,
      height: e.height ?? null,
      kind: e.kind,
      preset: false,
      pinned: pinned.has(e.id),
      addedAt: e.addedAt
    }))
    // 置顶的排前面（Array.sort 稳定，同组内保持 addedAt 倒序）
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned))
  } catch {
    return []
  }
}

/** 置顶 / 取消置顶 */
export function pin(id: string, isPinned: boolean): boolean {
  try {
    if (isPinned) pinned.add(id)
    else pinned.delete(id)
    writePinned()
    return true
  } catch {
    return false
  }
}

/** 删除壁纸：原图副本、缩略图、索引条目一起清掉 */
export function remove(id: string): boolean {
  try {
    const idx = readIndex()
    const hit = idx.entries.find((e) => e.id === id)
    if (!hit) return false
    for (const f of [hit.path, hit.thumbPath, join(thumbDir(), `${id}.png`)]) {
      if (!f) continue
      try {
        rmSync(f, { force: true })
      } catch {
        console.warn('[壁纸] 删不掉文件（可能被占用）：', f)
      }
    }
    // 顺手清掉同扩展名的遗留副本（改过扩展名的情况下会残留）
    for (const ext of OK_EXT) {
      const stray = join(dirname(hit.path), `${id}${ext}`)
      if (stray !== hit.path && existsSync(stray)) {
        try {
          rmSync(stray, { force: true })
        } catch {
          /* 清不掉就算了 */
        }
      }
    }
    idx.entries = idx.entries.filter((e) => e.id !== id)
    writeIndex(idx)
    if (pinned.delete(id)) writePinned()
    return true
  } catch {
    return false
  }
}

/** 取完整引用。找不到给 null（不是抛） */
export function getRef(id: string): WallpaperRef | null {
  try {
    return readIndex().entries.find((e) => e.id === id) ?? null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 自动适配
 * ------------------------------------------------------------------ */

/** 按 id 算自动适配；id 为空时用当前设置里的壁纸 */
export function autoFit(id?: string | null): WallpaperAutoFit {
  try {
    const cur = settings.get()
    const target = id ?? cur.wallpaper?.id ?? null
    const ref = target ? getRef(target) : null
    const palette = ref?.palette ?? (target ? null : (cur.wallpaper?.palette ?? null))
    return deriveAutoFit(palette, cur.appearanceMode)
  } catch {
    return deriveAutoFit(null, 'dark')
  }
}

/** 用户点「自动适配」时把结果写回 settings，并返回它 */
export function applyAutoFit(id?: string | null): WallpaperAutoFit {
  const fit = autoFit(id)
  try {
    settings.set({
      appearanceMode: fit.mode,
      accent: fit.accent,
      ambient: fit.ambient,
      sidebarOpacity: fit.sidebarOpacity,
      sidebarBlur: fit.sidebarBlur,
      wallpaperAdjust: {
        ...settings.get().wallpaperAdjust,
        maskDark: fit.maskDark,
        maskLight: fit.maskLight
      } as WallpaperAdjust
    })
  } catch (err) {
    console.warn('[壁纸] 自动适配写回设置失败：', err)
  }
  return fit
}
