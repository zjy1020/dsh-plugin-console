/**
 * WallpaperLayer —— 壁纸层（L0，永远在最底下）。
 *
 * 三层结构，职责分开：
 *   图片层  —— 两张图交叉淡化，换壁纸时旧图淡出、新图淡入（侧栏位置不变）
 *   遮罩层  —— 深/浅两套遮罩，保证任何壁纸下文字对比度都够
 *   颗粒层  —— 一层极淡噪点。只有模糊没有颗粒会显得像塑料板，这是材质的「哑光」来源
 *
 * 图片走 `dshwp://current`（主进程注册的自定义协议）。渲染层不需要知道文件名，
 * 只带一个 `?v=<addedAt>` 做缓存失效 —— 换壁纸后浏览器必须重新解码，否则会一直用旧图。
 *
 * 系统材质（acrylic / mica）时不画这一层：那时候模糊的是桌面本身，
 * 再叠一张自绘壁纸会变成两层底。此时只留一层薄遮罩，保证面板上的文字可读。
 */

import { useEffect, useRef, useState } from 'react'
import { useConsole } from '../lib/store'

interface Layer {
  url: string
  key: number
  out: boolean
}

/** 渐出时长要和 glass.css 里 .wp-layer__img 的 transition 对上 */
const FADE_MS = 900

/**
 * `object-fit` 只有 cover / contain / fill / none 四档，而我们要支持五档。
 * 映射规则：
 *   cover / contain / fill 语义一致，原样用；
 *   center → none（按原始尺寸居中，`object-position: center` 是默认值）；
 *   tile   → 退化成 cover。真正的平铺要用 `background-repeat` 而不是 <img>，
 *            等壁纸库那一版再补；现在静默降级成 cover 比留一个点不动的选项好。
 */
function toObjectFit(fit: string): 'cover' | 'contain' | 'fill' | 'none' {
  switch (fit) {
    case 'contain':
      return 'contain'
    case 'fill':
      return 'fill'
    case 'center':
      return 'none'
    case 'tile':
    case 'cover':
    default:
      return 'cover'
  }
}

export function WallpaperLayer() {
  const { settings } = useConsole()
  const ref = settings.wallpaper
  const adjust = settings.wallpaperAdjust
  const useOsMaterial = settings.material === 'acrylic' || settings.material === 'mica'

  const url = ref ? `dshwp://current/?v=${encodeURIComponent(String(ref.addedAt))}` : null
  const key = ref?.addedAt ?? 0

  const [layers, setLayers] = useState<Layer[]>(() => (url ? [{ url, key, out: false }] : []))
  const timer = useRef<number | null>(null)

  useEffect(() => {
    setLayers((prev) => {
      const last = prev[prev.length - 1]
      // 同一张图（或都没有）不动：避免 loadPlugins 之类的重渲染把图层重建一遍
      if (!url) return prev.length === 0 ? prev : prev.map((l) => ({ ...l, out: true }))
      if (last && !last.out && last.key === key) return prev
      return [...prev.map((l) => ({ ...l, out: true })), { url, key, out: false }].slice(-3)
    })

    if (timer.current !== null) window.clearTimeout(timer.current)
    // 等淡出跑完再把旧图层摘掉，中途摘会让淡出变成硬切
    timer.current = window.setTimeout(() => {
      setLayers((prev) => prev.filter((l) => !l.out))
    }, FADE_MS + 60)

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [url, key])

  // 系统材质：窗帘交给操作系统，我们只负责那层保证可读性的薄遮罩
  if (useOsMaterial) {
    return (
      <div className={`wp-layer wp-layer--os${ref ? '' : ' wp-layer--none'}`} aria-hidden="true">
        <div className="wp-layer__veil" style={{ opacity: ref ? 'var(--gl-veil-alpha)' : '0' }} />
      </div>
    )
  }

  const imgStyle: React.CSSProperties = {
    objectFit: toObjectFit(settings.wallpaperFit),
    filter: [
      adjust.brightness !== 1 ? `brightness(${adjust.brightness})` : '',
      adjust.saturation !== 1 ? `saturate(${adjust.saturation})` : '',
      adjust.contrast !== 1 ? `contrast(${adjust.contrast})` : '',
      adjust.blur > 0 ? `blur(${adjust.blur}px)` : ''
    ]
      .filter(Boolean)
      .join(' ') || undefined,
    transform:
      adjust.scale !== 1 || adjust.offsetX !== 0 || adjust.offsetY !== 0
        ? `scale(${adjust.scale}) translate(${adjust.offsetX * 100}%, ${adjust.offsetY * 100}%)`
        : undefined
  }

  return (
    <div className={`wp-layer${ref ? '' : ' wp-layer--none'}`} aria-hidden="true">
      {layers.map((l) => (
        <img
          key={l.key === 0 ? l.url : `${l.key}-${l.out ? 'out' : 'in'}`}
          className={`wp-layer__img${l.out ? ' wp-layer__img--out' : ''}`}
          src={l.url}
          alt=""
          draggable={false}
          decoding="async"
          style={imgStyle}
        />
      ))}

      {/* 遮罩：深色模式压暗，浅色模式提亮。两张同时存在，靠 data-theme 决定谁生效 */}
      <div
        className="wp-layer__veil wp-layer__veil--dark"
        style={{ opacity: String(adjust.maskDark) }}
      />
      <div
        className="wp-layer__veil wp-layer__veil--light"
        style={{ opacity: String(adjust.maskLight) }}
      />

      {/* 颗粒层：内联 SVG，不需要任何图片文件，也不会被 CSP 的 img-src 拦 */}
      <div className="wp-layer__noise" />
    </div>
  )
}
