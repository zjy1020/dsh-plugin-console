/**
 * PluginGallery —— 插件详情里的「图片」区：把 README 里的截图摊成缩略图网格。
 *
 * 数据：主进程 gallery.ts 已经把图片字节取好并转成 data: URL（渲染层不再联网，
 * 也不受 CSP / 防盗链影响），这里只管拉一次、分四种状态渲染。
 *
 * 四种状态都必须齐：
 *   加载  → 同尺寸骨架块（和缩略图同一个网格、同一个宽高比，面板不会跳动）
 *   空    → 「README 里没有截图」—— 这是正常状态，用安静的中性文案，不上红色
 *   错误  → 中文原因 + 「重试」
 *   正常  → 缩略图网格
 *
 * 预览层：点缩略图后开一层**整窗灯箱**，Esc 关闭、← / → 切换、
 * aria-modal + 关闭后焦点回退到打开它的那张缩略图、Tab 焦点锁在层内。
 *
 * 为什么是整窗灯箱，而不是「盖在宿主面板上」：
 * 图集是看图的，1440x810 的截图塞进 400px 宽的详情栏（或市场那个 max-width:720px 的
 * sheet）里，放大等于没放大 —— 实测市场路径下预览层只剩 653x243，图被压成 173x97。
 * 所以这里不再去量宿主面板，直接铺满窗口；连带的「量面板 + resize / scroll 重算」整套
 * 逻辑（原来量的是 rootRef.closest('.detail')，而市场的外壳根本不是 .detail）一起删掉。
 *
 * 为什么要 portal 到 document.body：`position:fixed` 的包含块会被带 backdrop-filter /
 * transform 的祖先抢走。市场 tab 挂在 .app__main.shell-main 里面，它身上有
 * backdrop-filter 与 overflow:hidden（glass.css:1287 / 1290）—— 留在原地的话
 * fixed inset:0 只等于「主区」，还会被 overflow 裁掉一个角，而不是整窗。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { GalleryImage, GalleryResult } from '../../../shared/types'
import { api, toMessage } from '../api'
import { useConsole } from '../lib/store'
import '../styles/gallery.css'

export interface PluginGalleryProps {
  /** profile 名（如 desktop） */
  profile: string
  /** 包名（如 dsh-pet / @liustack/modsearch） */
  name: string
  /** 紧凑模式：去掉补充说明与外链，只留网格（详情面板很窄时更清爽） */
  compact?: boolean
}

/** 骨架块数量：和常见截图数差不多，铺满两行 */
const SKELETON_COUNT = 6

/** 预览层允许的最大放大倍数 */
const UPSCALE_MAX = 4
/** 放大上限的地板：再小的图也至少给这么大的盒子，否则在大窗口里就是个点 */
const UPSCALE_FLOOR = 320

/**
 * 按图片天然尺寸算 inline 的 max-width / max-height。
 * 读不到尺寸（非位图或头没解析出来）就不卡 —— 宁可让它铺满，也不要因为拿不到数据就变小。
 */
function upscaleCap(img: GalleryImage): CSSProperties | undefined {
  if (!img.width || !img.height) return undefined
  return {
    maxWidth: `${Math.max(img.width * UPSCALE_MAX, UPSCALE_FLOOR)}px`,
    maxHeight: `${Math.max(img.height * UPSCALE_MAX, UPSCALE_FLOOR)}px`,
  }
}

export function PluginGallery({ profile, name, compact = false }: PluginGalleryProps): ReactElement {
  const { actions } = useConsole()

  const [result, setResult] = useState<GalleryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  /** 预览层当前显示第几张；null = 没开 */
  const [open, setOpen] = useState<number | null>(null)

  const layerRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  /* ---------------- 拉数据 ---------------- */

  useEffect(() => {
    let alive = true
    setOpen(null)
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const data = await api().pluginGallery(profile, name)
        if (!alive) return
        setResult(data)
        setError(data.ok ? null : (data.error ?? '没读到这个插件的 README'))
      } catch (err) {
        if (!alive) return
        setResult(null)
        setError(toMessage(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [profile, name, nonce])

  const images: GalleryImage[] = useMemo(() => result?.images ?? [], [result])

  /** README 里没写 alt 就退化成「<插件名> 截图 N」 */
  const altOf = useCallback(
    (img: GalleryImage, index: number): string => {
      const text = img.alt?.trim()
      return text ? text : `「${name} 截图 ${index + 1}」`
    },
    [name]
  )

  /* ---------------- 预览层 ---------------- */

  const openAt = useCallback((index: number, opener: HTMLElement | null): void => {
    openerRef.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setOpen(index)
  }, [])

  const close = useCallback((): void => {
    setOpen(null)
  }, [])

  /* 打开时把焦点交给预览层本身（Tab 的第一站就在层里） */
  useEffect(() => {
    if (open === null) return
    const timer = window.setTimeout(() => layerRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  /* 关闭后焦点回退到打开它的那张缩略图（键盘用户不会掉到页首） */
  useEffect(() => {
    if (open !== null) return
    const opener = openerRef.current
    openerRef.current = null
    opener?.focus()
  }, [open])

  const step = useCallback(
    (delta: number): void => {
      setOpen((i) => {
        if (i === null) return i
        const total = images.length
        if (total === 0) return i
        return (i + delta + total) % total
      })
    },
    [images.length]
  )

  const onLayerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      // 这里按下的键全部拦在自己手里：Esc 只关预览层，别让 App 的全局 Esc 顺手把详情面板也关掉
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        step(1)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        step(-1)
        return
      }
      if (e.key !== 'Tab') return

      // 焦点锁在预览层里，别跑到后面的详情面板上
      const layer = layerRef.current
      if (!layer) return
      const nodes = Array.from(
        layer.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      ).filter((el) => el.offsetParent !== null)
      if (nodes.length === 0) return
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === layer)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [close, step]
  )

  /* ---------------- 状态判定 ---------------- */

  const failed = !loading && error !== null
  const empty = !loading && error === null && images.length === 0
  const current = open !== null ? (images[open] ?? null) : null
  const warnings = (result?.warnings ?? []).filter((w) => !/没有可用的截图/.test(w))

  /* ---------------- 渲染 ---------------- */

  return (
    <div className={`gal${compact ? ' gal--compact' : ''}`}>
      <div className="gal__bar">
        <span className="gal__meta">
          {loading
            ? '正在从 README 里找截图…'
            : failed
              ? '没读到这个插件的 README'
              : empty
                ? '这个插件的 README 里没有截图'
                : `${images.length} 张截图，来自 ${result?.origin ?? 'README'}`}
        </span>
        {loading ? null : (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              setNonce((n) => n + 1)
            }}
            title="重新去 README 里找一遍截图"
          >
            重试
          </button>
        )}
      </div>

      {loading ? (
        <>
          <span className="gal__sr" role="status">
            正在从 README 里找截图…
          </span>
          <div className="gal__grid" aria-hidden="true">
            {Array.from({ length: SKELETON_COUNT }, (_, i) => (
              <span className="gal__skeleton" key={i} />
            ))}
          </div>
        </>
      ) : failed ? (
        <div className="gal__error" role="alert">
          <span className="gal__error-text">{error}</span>
          <span className="gal__error-hint">
            可能是网络不通，或者这个包没发布 README。点「重试」重新找一遍。
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setNonce((n) => n + 1)
            }}
          >
            重试
          </button>
        </div>
      ) : empty ? (
        <p className="gal__note">
          这个插件的 README 里没有截图。这是正常情况，不是出错。点「重试」可以重新找一遍。
        </p>
      ) : (
        <>
          <div className="gal__grid" role="group" aria-label={`${name} 的截图`}>
            {images.map((img, i) => (
              <button
                type="button"
                className="gal__thumb"
                key={img.url}
                onClick={(e) => openAt(i, e.currentTarget)}
                aria-label={`放大查看：${altOf(img, i)}`}
                title={`放大查看：${altOf(img, i)}`}
              >
                <img className="gal__thumb-img" src={img.dataUrl} alt={altOf(img, i)} draggable={false} />
                {img.width && img.height ? <span className="gal__thumb-size">{`${img.width}×${img.height}`}</span> : null}
              </button>
            ))}
          </div>

          {!compact ? <span className="gal__hint">点缩略图整窗放大查看，放大后按 Esc 关闭。</span> : null}

          {!compact && warnings.length > 0 ? (
            <ul className="gal__warns">
              {warnings.slice(0, 4).map((w) => (
                <li className="gal__warn-line" key={w}>
                  {w}
                </li>
              ))}
            </ul>
          ) : null}

          {!compact && (result?.links.length ?? 0) > 0 ? (
            <div className="gal__links">
              <span className="gal__links-label">README 里的相关链接</span>
              <div className="gal__links-row">
                {result?.links.map((link) => (
                  <button
                    type="button"
                    className="link-btn truncate gal__link"
                    key={link.url}
                    onClick={() => void actions.openExternal(link.url)}
                    title={link.url}
                  >
                    {link.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      {current && open !== null
        ? createPortal(
            <div
              className="gal-preview"
              role="dialog"
              aria-modal="true"
              aria-label={`${name} 的截图预览`}
              tabIndex={-1}
              ref={layerRef}
              onKeyDown={onLayerKeyDown}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close()
              }}
            >
              <div className="gal-preview__box">
                <div className="gal-preview__head">
                  <span className="gal-preview__counter">{`第 ${open + 1} / ${images.length} 张`}</span>
                  <span className="gal-preview__spacer" aria-hidden="true" />
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => void actions.openExternal(current.url)}
                    title={current.url}
                  >
                    打开原图
                  </button>
                  <button
                    type="button"
                    className="icon-btn gal-preview__close"
                    onClick={close}
                    aria-label="关闭预览"
                    title="关闭预览 (Esc)"
                  >
                    ✕
                  </button>
                </div>

                <div className="gal-preview__stage">
                  <img
                    className="gal-preview__img"
                    src={current.dataUrl}
                    alt={altOf(current, open)}
                    draggable={false}
                    /*
                      旧写法是 max-width/height:100%（绝不放大），窗口里那张 180x180 的
                      README 首图就只剩邮票大小，用户的抱怨正是「很小而且很偏」。
                      现在改成铺满 + 上限 UPSCALE_MAX 倍：小图看得清，大图不糊成一团，
                      唯一代价是极小的图会被插值放大（尺寸读数就写在下面，不作假）。
                    */
                    style={upscaleCap(current)}
                  />
                </div>

                <div className="gal-preview__caption">
                  {current.width && current.height ? (
                    <span className="gal-preview__dims">{`${current.width} × ${current.height}`}</span>
                  ) : null}
                  {current.alt?.trim() ? <span>{current.alt.trim()}</span> : null}
                </div>

                <div className="gal-preview__foot">
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => step(-1)}
                    disabled={images.length < 2}
                  >
                    上一张
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => step(1)}
                    disabled={images.length < 2}
                  >
                    下一张
                  </button>
                  <span className="gal-preview__spacer" aria-hidden="true" />
                  <span className="gal-preview__hint">← → 切换，Esc 关闭</span>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export default PluginGallery
