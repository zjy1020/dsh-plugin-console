import { useCallback, useEffect, useRef, useState } from 'react'
import type { WallpaperAutoFit, WallpaperRef } from '../../../shared/types'
import { api, toMessage } from '../api'
import { useConsole } from '../lib/store'
import '../styles/wallpaper-drop.css'

/**
 * 拖进来换壁纸。
 *
 * 纲领 §11 要的是六段流程，这里一段都没省：
 *   默认态 → 开始拖拽（边缘光晕 + 边框变亮 + 中央提示 + 当前壁纸压暗）
 *   → 进入有效区域（提示换成「释放以预览壁纸」）
 *   → 松开（进入预览：新壁纸 / 当前壁纸 / 自动适配结果都在同一屏）
 *   → 确认应用（壁纸淡入、材质参数跟着变）
 *   → 放弃（把刚导入的那份从库里删掉，不留垃圾）
 *
 * 「导入后不要直接替换，先进入预览状态」是这条流程里唯一不能省的约束 ——
 * 用户拖进来一张图，最不希望的就是背景当场被换掉又找不回来。
 */

const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i

interface DropState {
  depth: number
  valid: boolean
}

export function WallpaperDrop() {
  const { state, actions } = useConsole()
  const [drop, setDrop] = useState<DropState>({ depth: 0, valid: false })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState<{
    ref: WallpaperRef
    fit: WallpaperAutoFit | null
    prevId: string | null
    prevName: string | null
  } | null>(null)
  // 用 ref 记账：dragenter/dragleave 会为每个子元素各触发一次，
  // 不数深度的话鼠标一进子元素提示就闪。
  const depth = useRef(0)

  const hasFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDrop({ depth: depth.current, valid: false })
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      const item = e.dataTransfer?.items?.[0]
      const name = item?.kind === 'file' ? (item.getAsFile()?.name ?? '') : ''
      // 只认图片扩展名：拖一个 .exe 进来时提示不能装作能用
      setDrop((d) => (d.valid === IMG_EXT.test(name) ? d : { ...d, valid: IMG_EXT.test(name) }))
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDrop({ depth: 0, valid: false })
      else setDrop((d) => ({ ...d, depth: depth.current }))
    }
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDrop({ depth: 0, valid: false })
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      if (!IMG_EXT.test(file.name)) {
        setErr(`「${file.name}」不是图片，支持 png / jpg / webp / gif / bmp。`)
        return
      }
      setErr(null)
      setBusy(true)
      try {
        // Electron 早就没有 File.path 了，官方替代是 preload 里同步调的 webUtils.getPathForFile
        const p = window.dsh.pathForFile(file)
        if (!p) {
          setErr('没拿到这个文件的路径，可能是从别的地方拖过来的虚拟文件。')
          return
        }
        const res = await api().wallpaperFromPath(p)
        if (!res.ok || !res.ref) {
          setErr(res.error ?? '导入失败。')
          return
        }
        setPending({
          ref: res.ref,
          fit: res.autoFit ?? null,
          prevId: state.settings?.wallpaper?.id ?? null,
          prevName: state.settings?.wallpaper?.name ?? null
        })
      } catch (e: unknown) {
        setErr(toMessage(e))
      } finally {
        setBusy(false)
      }
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [state.settings?.wallpaper?.id, state.settings?.wallpaper?.name])

  const apply = useCallback(async () => {
    if (!pending) return
    setBusy(true)
    try {
      await api().wallpaperSet(pending.ref.id)
      await actions.reloadAll()
      actions.toast('success', '壁纸已应用', '材质参数按这张图重新算过了。')
      setPending(null)
    } catch (e: unknown) {
      setErr(toMessage(e))
    } finally {
      setBusy(false)
    }
  }, [pending, actions])

  const discard = useCallback(async () => {
    if (!pending) return
    setBusy(true)
    try {
      // 放弃就把刚导入的这份删掉 —— 预览完留在库里会越攒越多，
      // 用户下一次打开壁纸库分不清哪些是自己真要的。
      await api().wallpaperRemove(pending.ref.id)
    } catch {
      /* 删不掉也不该弹错：它只是一份没被采用的副本 */
    } finally {
      setBusy(false)
      setPending(null)
    }
  }, [pending])

  const dragging = drop.depth > 0

  return (
    <>
      {dragging ? (
        <div className={`wpdrop${drop.valid ? ' is-valid' : ''}`} aria-hidden="true">
          <div className="wpdrop__frame" />
          <div className="wpdrop__hint">
            <div className="wpdrop__title">
              {drop.valid ? '释放以预览壁纸' : '松手前先确认这是张图片'}
            </div>
            <div className="wpdrop__sub">
              {drop.valid
                ? '不会当场替换 —— 先给你看一眼新壁纸和新材质，再决定要不要用。'
                : '支持 png / jpg / webp / gif / bmp，单张不超过 40 MB。'}
            </div>
          </div>
        </div>
      ) : null}

      {pending ? (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && void discard()}>
          <div className="wpprev" role="dialog" aria-modal="true" aria-label="壁纸预览">
            <div className="wpprev__head">
              <span className="wpprev__title">换上这张？</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => void discard()}
                aria-label="放弃这张壁纸"
                title="放弃 (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="wpprev__pair">
              <figure className="wpprev__side">
                <img src={`dshwp://thumb/${pending.ref.id}`} alt="" />
                <figcaption>
                  新壁纸 · {pending.ref.name}
                  <span className="wpprev__dim">
                    {pending.ref.width ?? '?'} × {pending.ref.height ?? '?'}
                    {pending.ref.palette ? ` · 主色 ${pending.ref.palette.dominant}` : ''}
                  </span>
                </figcaption>
              </figure>
              <figure className="wpprev__side wpprev__side--old">
                {pending.prevId ? (
                  <img src={`dshwp://thumb/${pending.prevId}`} alt="" />
                ) : (
                  <div className="wpprev__none">现在没有壁纸</div>
                )}
                <figcaption>
                  现在用着 · {pending.prevName ?? '（无）'}
                  <span className="wpprev__dim">放弃的话还是它</span>
                </figcaption>
              </figure>
            </div>

            {pending.fit ? (
              <div className="apfit wpprev__fit">
                <div className="apfit__head">
                  自动适配算出来的结果
                  <span className="apfit__mode">
                    {pending.fit.mode === 'dark' ? '深色' : '浅色'}
                  </span>
                  <span className="apfit__mode">
                    不透明度 {Math.round(pending.fit.sidebarOpacity * 100)}%
                  </span>
                  <span className="apfit__mode">模糊 {pending.fit.sidebarBlur}px</span>
                </div>
                <ul className="apfit__reasons">
                  {pending.fit.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {err ? <div className="wpprev__err">{err}</div> : null}

            <div className="wpprev__foot">
              <span className="wpprev__note">
                原图已复制到应用自己的目录，之后删掉你下载的那份也不影响。
              </span>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy}
                onClick={() => void discard()}
              >
                放弃
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                {busy ? '正在换…' : '应用这张'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {err && !pending ? (
        <div className="wpdroperr" role="alert">
          <span>{err}</span>
          <button type="button" className="icon-btn" onClick={() => setErr(null)} aria-label="知道了">
            ✕
          </button>
        </div>
      ) : null}
    </>
  )
}
