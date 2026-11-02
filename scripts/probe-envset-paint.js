/**
 * probe-envset-paint.js —— 查「卡片占了位置但看不见」到底是没渲染还是被盖住。
 *
 * 背景：Master 新电脑上「标题栏下面一大片空白，主区被顶到下半屏」。
 * 注入同构卡片后，`.app__body` 确实被顶到 y=172（说明卡片占了 124px 布局高度），
 * 但截图里那块区域**一个像素都没有** —— 说明它画了，只是画在别人下面。
 *
 * 判据不是猜，是 document.elementFromPoint：在那个坐标上真正接收到命中测试的是谁。
 */
(async () => {
  const out = { layers: [], hits: [] }
  const info = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      sel: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
      position: cs.position,
      zIndex: cs.zIndex,
      display: cs.display,
      opacity: cs.opacity,
      visibility: cs.visibility,
      bg: cs.backgroundColor,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
  }

  /* .app 的所有直接子节点，按 DOM 顺序（= 静态元素的绘制顺序） */
  const app = document.querySelector('.app')
  out.appChildren = [...app.children].map(info)
  out.appCss = (() => {
    const cs = getComputedStyle(app)
    return { position: cs.position, zIndex: cs.zIndex, isolation: cs.isolation, transform: cs.transform }
  })()

  /* 壁纸层内部 */
  const wp = document.querySelector('.wp-layer')
  out.wpLayer = info(wp)
  if (wp) out.wpChildren = [...wp.children].map(info)

  /* 关键：在卡片正文那个点上，谁在最上面 */
  const card = document.querySelector('.envset[data-probe]')
  if (card) {
    const lead = card.querySelector('.envset__lead') || card
    const r = lead.getBoundingClientRect()
    const cx = Math.round(r.x + Math.min(40, r.width / 2))
    const cy = Math.round(r.y + r.height / 2)
    out.probePoint = { x: cx, y: cy }
    out.hits = document.elementsFromPoint(cx, cy).slice(0, 6).map(info)
    out.cardInfo = info(card)
    out.leadInfo = info(lead)
  } else {
    out.note = '没有注入的卡片，先跑 probe-envset-shot.js'
  }

  return out
})()
