/* 缺运行时的时候，引导卡上那块「一键补全」到底长什么样。
 * 只量不改，量完把 DOM 留在那儿供截图（截图另开一条命令）。
 */
;(async () => {
  const out = { pass: false, fail: [], detail: {} }
  const q = (sel) => document.querySelector(sel)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  const card = q('.app > .envset')
  out.detail.card = box(card)
  if (!card) {
    out.fail.push('缺运行时的时候引导卡没出现')
    out.pass = false
    return out
  }

  const prov = q('.envset .rtprov')
  const go = q('.envset .rtprov__go')
  const opt = q('.envset .rtprov__opt')
  const from = q('.envset .rtprov__from')
  const why = q('.envset .rtprov__why')

  out.detail.provision = {
    block: box(prov),
    goText: go ? go.textContent.trim() : null,
    goDisabled: go ? go.disabled : null,
    optText: opt ? opt.textContent.trim() : null,
    fromText: from ? from.textContent.trim() : null,
    whyText: why ? why.textContent.trim() : null
  }
  if (!prov) out.fail.push('引导卡里没有 RuntimeProvision 块')
  if (go && !go.textContent.includes('MB')) out.fail.push('按钮上没写体积')
  if (from && !from.textContent.includes('resources')) out.fail.push('来源路径没显示')

  // 侧栏让位：卡片必须整体在侧栏右边
  const sb = q('.sb')
  const sbRight = sb ? Math.round(sb.getBoundingClientRect().right) : 0
  out.detail.sidebarRight = sbRight
  out.detail.clearsSidebar = Boolean(card && card.getBoundingClientRect().x >= sbRight - 1)
  if (!out.detail.clearsSidebar) out.fail.push(`卡片 x=${out.detail.card.x} 没让开侧栏 right=${sbRight}`)

  // 卡片不能被壁纸层盖住：它得有自己的定位/z-index
  if (card) {
    const cs = getComputedStyle(card)
    out.detail.cardPaint = { position: cs.position, zIndex: cs.zIndex, bg: cs.backgroundColor }
    if (cs.position === 'static') out.fail.push('卡片是 static，会被 .wp-layer 盖住')
  }

  // 安装页那块：切到「安装插件」看它在不在
  const installTab = Array.from(document.querySelectorAll('.sb__item, .sb__icon-btn')).find((el) =>
    (el.textContent ?? '').includes('安装')
  )
  if (installTab) {
    installTab.click()
    await new Promise((r) => setTimeout(r, 400))
    const ip = q('.install .rtprov')
    const empty = q('.install .empty, .install [class*="empty"]')
    out.detail.install = {
      provision: box(ip),
      goText: ip ? ip.querySelector('.rtprov__go')?.textContent?.trim() : null,
      emptyTitle: empty ? (empty.textContent ?? '').slice(0, 60) : null
    }
    if (!ip) out.fail.push('安装页空态里没有 RuntimeProvision 块')
  } else {
    out.detail.install = '没找到安装页入口'
  }

  out.pass = out.fail.length === 0
  return out
})()
