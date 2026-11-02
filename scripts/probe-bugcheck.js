/* eslint-disable */
/**
 * probe-bugcheck.js —— 六条 bug 的实机复验（在运行中的应用里执行）
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-bugcheck.js
 *
 * 只读，不改任何设置、不点任何会写盘的东西。负责：
 *   bug 2  标题栏 logo 与侧栏 logo 的墨迹左沿是否同一条竖线
 *   bug 3  侧栏底部光学留白是否与顶部相等
 *   bug 5  文档是否还被滚、三个窗口按钮是否完整可见
 *   bug 6  缝隙刻度条 16 格是否同一高度
 *   另验  aria-current 选中态是否终于有文字/图标反馈
 */
(async () => {
  const R = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const n = (v) => Math.round(v * 100) / 100
    return { x: n(r.x), y: n(r.y), w: n(r.width), h: n(r.height) }
  }
  const q = (s) => document.querySelector(s)
  const css = (el, ...props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = cs.getPropertyValue(p)
    return out
  }

  const se = document.scrollingElement

  /* ---- bug 5：文档滚动 + 标题栏 ---- */
  const bar = q('.titlebar')
  const btns = [...document.querySelectorAll('.titlebar__controls button, .titlebar__controls .icon-btn')]

  /* ---- bug 2：两处 logo 的墨迹左沿 ---- */
  const tbImg = q('.titlebar__logo-img') || q('.titlebar__brand img')
  const sbImg = q('.sb__logo img') || q('.sb__brand img')
  const sbLogoBox = q('.sb__logo')

  /* ---- bug 3：侧栏上下留白 ---- */
  const sb = q('.sb')
  const sbBrand = q('.sb__brand')
  const sbUser = q('.sb__user')
  const sbNav = q('.sb__nav')
  const sbStatus = q('.sb__status')

  // 光学留白 =「看得见的元素边」到「面板边」，不是盒子 padding
  const visibleTopEl = sbLogoBox || sbBrand
  const sbRect = sb ? sb.getBoundingClientRect() : null
  const vtRect = visibleTopEl ? visibleTopEl.getBoundingClientRect() : null
  const vuRect = sbUser ? sbUser.getBoundingClientRect() : null

  /* ---- bug 6：缝隙刻度 ---- */
  const ticks = [...document.querySelectorAll('.gap-strip__tick')]
  const tickH = ticks.map((t) => Math.round(t.getBoundingClientRect().height * 100) / 100)
  const tickW = ticks.map((t) => Math.round(t.getBoundingClientRect().width * 100) / 100)
  const gapTicks = ticks.filter((t) => t.classList.contains('gap-strip__tick--gap'))

  /* ---- 延迟读数结构 ---- */
  const lat = q('.sb__latency-test')
  const latText = q('.sb__mini-latency')
  const latTotal = q('.sb__latency-total')

  /* ---- aria-current 选中态 ---- */
  const activeItem = q('.sb__item[aria-current="page"]')
  const otherItem = [...document.querySelectorAll('.sb__item')].find((e) => e !== activeItem)

  return {
    bug5: {
      scrollTop: se.scrollTop,
      scrollH: se.scrollHeight,
      clientH: se.clientHeight,
      canScroll: se.scrollHeight > se.clientHeight,
      titlebar: R(bar),
      titlebarBg: css(bar, 'background-color')?.['background-color'],
      buttons: btns.map((b) => R(b)),
      buttonsVisible: btns.every((b) => {
        const r = b.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= window.innerHeight + 0.5 && r.width > 0
      })
    },
    bug2: {
      titlebarLogoInk: R(tbImg),
      sidebarLogoInk: R(sbImg),
      sidebarLogoBox: R(sbLogoBox),
      /** 两个 20×20 图形的墨迹左沿之差；目标是 ~0 */
      inkDeltaX:
        tbImg && sbImg
          ? Math.round(
              (sbImg.getBoundingClientRect().left - tbImg.getBoundingClientRect().left) * 100
            ) / 100
          : null,
      brandXPadding: css(q('.titlebar'), 'padding-left')?.['padding-left'],
      titlebarBrandGap: css(q('.titlebar__brand'), 'gap')?.['gap']
    },
    bug3: {
      sb: R(sb),
      brand: R(sbBrand),
      status: R(sbStatus),
      user: R(sbUser),
      nav: R(sbNav),
      sbPaddingBottom: css(sb, 'padding-bottom')?.['padding-bottom'],
      /** 顶部光学留白：看得见的圆底顶 → 面板顶 */
      opticalTop: sbRect && vtRect ? Math.round((vtRect.top - sbRect.top) * 100) / 100 : null,
      /** 底部光学留白：用户卡下沿 → 面板底 */
      opticalBottom: sbRect && vuRect ? Math.round((sbRect.bottom - vuRect.bottom) * 100) / 100 : null,
      /** 两个光学留白之差；目标是 ~0 */
      opticalDelta:
        sbRect && vtRect && vuRect
          ? Math.round((vtRect.top - sbRect.top - (sbRect.bottom - vuRect.bottom)) * 100) / 100
          : null,
      /** 状态卡 ↔ 用户卡之间的呼吸，必须保持原来的 17.33 */
      statusUserGap:
        sbStatus && sbUser
          ? Math.round((sbUser.getBoundingClientRect().top - sbStatus.getBoundingClientRect().bottom) * 100) / 100
          : null,
      navOverflow: sbNav ? sbNav.scrollHeight - sbNav.clientHeight : null,
      navItems: document.querySelectorAll('.sb__item').length,
      userHtml: sbUser ? sbUser.className : null,
      userChildren: sbUser
        ? [...sbUser.children].map((c) => `${c.className.split(' ')[0]}:${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`)
        : null
    },
    bug6: {
      tickCount: ticks.length,
      tickHeights: [...new Set(tickH)],
      tickWidths: [...new Set(tickW)],
      gapTickCount: gapTicks.length,
      gapTickStyle: gapTicks[0] ? css(gapTicks[0], 'height', 'margin-top', 'border') : null,
      latencyLabel: latText ? latText.textContent : null,
      latencyTotal: latTotal ? latTotal.textContent : null,
      latencyButton: lat ? lat.textContent : null
    },
    ariaCurrent: {
      activeItemText: activeItem ? activeItem.textContent.trim().slice(0, 20) : null,
      activeColor: activeItem ? getComputedStyle(activeItem).color : null,
      activeWeight: activeItem ? getComputedStyle(activeItem).fontWeight : null,
      normalColor: otherItem ? getComputedStyle(otherItem).color : null,
      normalWeight: otherItem ? getComputedStyle(otherItem).fontWeight : null,
      /** 关键判据：选中项与普通项必须在颜色或字重上真的不同 */
      distinguishable: activeItem && otherItem
        ? getComputedStyle(activeItem).color !== getComputedStyle(otherItem).color ||
          getComputedStyle(activeItem).fontWeight !== getComputedStyle(otherItem).fontWeight
        : null
    }
  }
})()