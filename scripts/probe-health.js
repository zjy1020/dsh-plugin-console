/**
 * 现状体检：环境、布局、错误出口是否都在正常状态。
 * 只读，不改任何数据。
 */
;(async () => {
  const dsh = window.dsh
  const out = {}
  const q = (s) => document.querySelector(s)
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const cs = (el, props) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = s[p]
    return o
  }

  const rt = await dsh.runtimeInfo()
  out.runtime = {
    installRoot: rt.installRoot ?? null,
    installRootFrom: rt.installRootFrom ?? null,
    dshHome: rt.dshHome ?? null,
    nodeOk: Boolean(rt.nodePath),
    pnpmOk: Boolean(rt.pnpmPath),
    desktopVersion: rt.desktopVersion ?? null
  }

  out.envsetPresent = Boolean(q('.envset'))
  out.appWarnPresent = Boolean(q('.app__warn'))
  out.appChildren = [...(q('.app')?.children ?? [])].map((e) => `${e.tagName.toLowerCase()}.${e.className}`)

  const sb = q('.sb')
  out.sidebar = { rect: rect(sb), cls: sb?.className ?? null }
  out.main = { rect: rect(q('.app__main')), ml: cs(q('.app__main'), ['marginLeft'])?.marginLeft }
  out.titlebar = { rect: rect(q('.titlebar')) }
  out.scrollTop = document.scrollingElement?.scrollTop ?? null
  out.docScrollable = (document.scrollingElement?.scrollHeight ?? 0) > (document.scrollingElement?.clientHeight ?? 0)

  // 主列表能不能看见内容（壁纸压层的反向检查：主区必须有不透明衬底）
  const mainEl = q('.app__main')
  out.mainPaint = cs(mainEl, ['position', 'zIndex', 'backgroundColor', 'backdropFilter'])

  // 侧栏底部两个图标的位置（Master 第 3 条：太靠下）
  const sbFoot = q('.sb__foot')
  out.sidebarFoot = { rect: rect(sbFoot), lastChild: rect(sbFoot?.lastElementChild ?? null) }

  // 标题栏三个按钮（Master 第 5 条：不显示）
  const ctrls = q('.titlebar__controls')
  out.titlebarControls = { rect: rect(ctrls), btns: [...(ctrls?.children ?? [])].map((b) => rect(b)) }

  // 缝隙刻度条（Master 第 6 条）
  const strip = q('.gaps') ?? q('.gapstrip')
  if (strip) {
    const cells = [...strip.children].map((c) => rect(c))
    out.gapStrip = {
      cls: strip.className,
      count: cells.length,
      firstThree: cells.slice(0, 3),
      widths: [...new Set(cells.map((c) => c?.w))],
      heights: [...new Set(cells.map((c) => c?.h))]
    }
  } else {
    out.gapStrip = null
  }

  return out
})()
