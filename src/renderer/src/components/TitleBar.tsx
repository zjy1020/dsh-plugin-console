/**
 * TitleBar —— 自绘无边框标题栏。
 *
 * 结构：左（logo + 应用名 + profile）/ 中（拖动区域）/ 右（最小化 / 最大化还原 / 关闭）
 * 拖动：整条 .titlebar 是 drag 区，按钮自己 no-drag。
 * 状态：订阅 onWindowState 切换「最大化 ↔ 还原」图标。
 *
 * 三个窗口按钮的图标为什么这么写（2026-11 排查结论，别再改回 10×10 细线）：
 *   - 旧版是 `width/height=10 viewBox="0 0 10 10"` + `stroke-width="1.1"`，描边走 JSX 属性
 *     （`stroke="currentColor"`）。属性是生效的（计算值 stroke 就是 rgb(51,59,72)、
 *     stroke-opacity 1），**不是「属性没生效」**；问题在「细 + 小」：dpr 1.5 的真实截图里
 *     用 scripts/inkcheck.py 的口径（比背景深 80 才算墨）数三个按钮区，只有 96 / 154 / 135 个墨点，
 *     10×10 的画布只占按钮 44×37.33 里的一小块，远看就是一片空白。
 *   - 现在换成 16×16 画布 + 1.5 线宽（= 2.25 设备像素），同口径是 102 / 222 / 166 个墨点，
 *     而且出现描边色本身的像素 (54,57,63)（= --fg-0 #14171d 按 0.82 失焦透明度合成后的值）。
 *   - 最深像素只能到「token × 0.82」，因为 components.css 里 `.titlebar[data-focused='false']`
 *     会把整条标题栏压到 opacity 0.82 —— 所以黑度靠 token 选 --fg-0，不靠加粗。
 *   - 描边一律交给 titlebar.css（JSX 里不写 stroke），这样线宽 / 线帽 / 外光 / 层提升 /
 *     颜色只有一处可改；`fill="none"` 仍留在属性上，兜底防「CSS 没加载时 rect 被默认黑填充」。
 */

import { useEffect, useState } from 'react'
import type { WindowState } from '../../../shared/types'
import { api } from '../api'
import { useConsole } from '../lib/store'
// 走 vite 资源导入：构建后拿到带 hash 的资源 URL（renderer 的 base 是 './'，
// 用绝对路径 /logo.png 在打包后 loadFile 的 file:// 下会 404）
import logoUrl from '../assets/logo.png'
import '../styles/titlebar.css'

/** 图标形状名。跟按钮语义一一对应，换状态只换形状，不换画布。 */
type GlyphShape = 'minimize' | 'maximize' | 'restore' | 'close'

/**
 * 三个窗口按钮共用的图标。
 *
 * 为什么是 16×16 而不是各自的 10×10：四个字形共用一个画布 → 线宽、线帽、外光、层提升
 * 一份 CSS 管到底；16 也给线条留出足够内边距，hover/active 缩放字形时不会被自身视口裁掉。
 */
function WindowGlyph({ shape }: { shape: GlyphShape }) {
  return (
    <svg
      className="titlebar__glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {shape === 'minimize' ? <path d="M3 8h10" fill="none" /> : null}
      {shape === 'maximize' ? <rect x="3.5" y="3.5" width="9" height="9" fill="none" /> : null}
      {shape === 'restore' ? (
        <>
          <rect x="2.5" y="5.5" width="8" height="8" fill="none" />
          <path d="M5 5.5V2.5h8.5V11h-3" fill="none" />
        </>
      ) : null}
      {shape === 'close' ? <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" /> : null}
    </svg>
  )
}

export function TitleBar() {
  const { state } = useConsole()
  const [win, setWin] = useState<WindowState>({ maximized: false, fullscreen: false, focused: true })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.dsh) return undefined
    let alive = true
    api()
      .windowState()
      .then((s) => {
        if (alive) setWin(s)
      })
      .catch(() => {
        /* 窗口状态拿不到不影响使用，保持默认图标 */
      })
    const off = window.dsh.onWindowState((s) => setWin(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const profile = state.activeProfile
  const meta = state.profiles.find((p) => p.name === profile) ?? null
  const maximized = win.maximized || win.fullscreen

  return (
    <header className="titlebar" data-focused={win.focused ? 'true' : 'false'}>
      <div className="titlebar__brand">
        <img
          className="titlebar__logo-img"
          src={logoUrl}
          alt=""
          width={20}
          height={20}
          draggable={false}
        />
        <span className="titlebar__app">DSH 插件台</span>
      </div>

      <div className="titlebar__profile" title={meta?.dir ?? '未选择 profile'}>
        {profile ? (
          <>
            <span className="titlebar__profile-name mono">{profile}</span>
            {meta ? (
              <span className="titlebar__profile-meta">
                {meta.depCount} 插件 · {meta.bundleCount} 加载层
                {meta.hasNodeModules ? '' : ' · 未初始化'}
              </span>
            ) : null}
          </>
        ) : (
          <span className="titlebar__profile-meta">没有 profile</span>
        )}
      </div>

      <div className="titlebar__drag" aria-hidden="true" />

      {/* 几何（44×37.33、贴右上角）是实测过的，改这里等于改窗口按钮位置 —— 别动。
          能动的只有按钮里面的 .titlebar__glyph。 */}
      <div className="titlebar__controls">
        <button
          type="button"
          className="icon-btn titlebar__btn"
          title="最小化"
          aria-label="最小化"
          onClick={() => {
            api().windowMinimize().catch(() => undefined)
          }}
        >
          <WindowGlyph shape="minimize" />
        </button>
        <button
          type="button"
          className="icon-btn titlebar__btn"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
          onClick={() => {
            api()
              .windowToggleMaximize()
              .then((m) => setWin((prev) => ({ ...prev, maximized: m })))
              .catch(() => undefined)
          }}
        >
          <WindowGlyph shape={maximized ? 'restore' : 'maximize'} />
        </button>
        <button
          type="button"
          className="icon-btn titlebar__btn titlebar__btn--close"
          title="关闭"
          aria-label="关闭窗口"
          onClick={() => {
            api().windowClose().catch(() => undefined)
          }}
        >
          <WindowGlyph shape="close" />
        </button>
      </div>
    </header>
  )
}
