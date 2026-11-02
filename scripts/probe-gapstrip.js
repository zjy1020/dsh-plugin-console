/**
 * 缝隙刻度条 + 延迟读数的实测（Master 第 6 条「延迟进度这个有bug」）。
 *
 * 为什么单独一个探针：那一块同时有「刻度条（gap-strip）」和「延迟读数（sb__latency）」，
 * 视觉辅助模型把红框圈在刻度条上，但用户说的是「延迟进度」—— 两个都得量，
 * 才能判断到底是刻度条宽度不一致，还是延迟那块在未测/测试中/有值之间切换时抖。
 */
;(async () => {
  const out = {}
  const q = (s) => document.querySelector(s)
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }

  const strip = q('.gap-strip')
  if (strip) {
    const ticks = [...strip.querySelectorAll('.gap-strip__tick')]
    const rs = ticks.map(rect)
    out.strip = {
      cls: strip.className,
      rect: rect(strip),
      aria: strip.getAttribute('aria-label'),
      tickCount: ticks.length,
      tickWidths: [...new Set(rs.map((r) => r.w))],
      tickHeights: [...new Set(rs.map((r) => r.h))],
      gapCount: ticks.filter((t) => t.className.includes('--gap')).length,
      first5: rs.slice(0, 5),
      last5: rs.slice(-5),
      // 相邻间距是否一致
      gaps: rs.slice(1).map((r, i) => +(r.x - (rs[i].x + rs[i].w)).toFixed(2)),
      cs: (() => {
        const s = getComputedStyle(strip)
        return { display: s.display, gap: s.gap, flexWrap: s.flexWrap, width: s.width, height: s.height }
      })(),
      tickCs: (() => {
        const t = ticks[0]
        if (!t) return null
        const s = getComputedStyle(t)
        return { width: s.width, height: s.height, flex: s.flex, borderRadius: s.borderRadius, bg: s.backgroundColor, opacity: s.opacity }
      })(),
      gapTickCs: (() => {
        const t = ticks.find((x) => x.className.includes('--gap'))
        if (!t) return null
        const s = getComputedStyle(t)
        return { width: s.width, height: s.height, flex: s.flex, borderRadius: s.borderRadius, bg: s.backgroundColor, opacity: s.opacity }
      })()
    }
  } else {
    out.strip = null
  }

  const lat = q('.sb__latency')
  out.latency = {
    rect: rect(lat),
    text: lat?.textContent?.trim() ?? null,
    cls: lat?.className ?? null,
    title: lat?.getAttribute('title') ?? null,
    total: q('.sb__latency-total')?.textContent?.trim() ?? null,
    mini: q('.sb__mini-latency')?.textContent?.trim() ?? null,
    cs: lat ? (() => { const s = getComputedStyle(lat); return { fontSize: s.fontSize, width: s.width, display: s.display } })() : null
  }

  const readouts = [...document.querySelectorAll('.sb__readout')].map((r) => ({
    key: r.querySelector('.sb__readout-key')?.textContent?.trim(),
    val: r.querySelector('.sb__readout-val')?.textContent?.trim(),
    rect: rect(r)
  }))
  out.readouts = readouts

  const card = q('.sb__status')
  out.statusCard = { rect: rect(card), cs: card ? (() => { const s = getComputedStyle(card); return { padding: s.padding, gap: s.gap, display: s.display } })() : null }

  return out
})()
