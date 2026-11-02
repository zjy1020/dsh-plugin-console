/**
 * probe-paint-order.js —— 找出所有「占了位置但被壁纸层盖住」的元素。
 *
 * 为什么需要这个：CSS 绘制顺序里，带 z-index 的定位元素（.wp-layer 是 fixed + z-index:0）
 * 排在**所有非定位的普通流内容之上**（CSS 2.1 附录 E 第 6 步 vs 第 3/5 步）。
 * 所以 .app 里任何一个 position: static 的子项都会被壁纸整块盖住 ——
 * 位置占了、高度也算了，就是一个像素都画不出来。
 *
 * 判据用 document.elementFromPoint（真实命中测试），不用肉眼猜。
 * 对每个候选元素取它矩形内的若干采样点，看最上层是不是它自己或它的后代。
 */
(async () => {
  const wp = document.querySelector('.wp-layer')
  if (!wp) return { ok: false, error: '没有 .wp-layer，这条路径不成立' }

  const inWp = (el) => {
    let n = el
    while (n) {
      if (n === wp) return true
      n = n.parentElement
    }
    return false
  }

  /* 对 .app 下所有「可见、有面积、position: static 且没有 z-index」的元素采样 */
  const app = document.querySelector('.app')
  const rows = []
  const all = [app, ...app.querySelectorAll('*')]
  for (const el of all) {
    if (el === wp || inWp(el)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (Number(cs.opacity) === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    /* 只关心「普通流、非定位、无 z-index」的 —— 这些才是绘制顺序的受害者 */
    const positioned = cs.position !== 'static'
    const hasZ = cs.zIndex !== 'auto'
    if (positioned || hasZ) continue

    /* 取矩形内 3 个采样点：左中、中心、右下偏内 */
    const pts = [
      [Math.round(r.x + 6), Math.round(r.y + r.height / 2)],
      [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
      [Math.round(r.x + r.width - 6), Math.round(r.y + r.height - 6)]
    ]
    let covered = 0
    let topNames = []
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
      const stack = document.elementsFromPoint(x, y)
      const top = stack[0]
      if (!top) continue
      if (top === el || el.contains(top)) continue
      if (inWp(top)) {
        covered++
        topNames.push(top.className || top.tagName)
      }
    }
    if (covered > 0) {
      rows.push({
        sel:
          el.tagName.toLowerCase() +
          (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
            : ''),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        coveredPoints: covered,
        ofPoints: pts.length,
        paintedOverBy: [...new Set(topNames)].slice(0, 3),
        text: (el.textContent || '').trim().slice(0, 40)
      })
    }
  }

  /* 按面积从大到小排，前几个就是最刺眼的 */
  rows.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)

  /* 再单独确认几条关键外壳：它们凭什么没事 */
  const shell = {}
  for (const [name, sel] of [
    ['titlebar', '.titlebar'],
    ['appBody', '.app__body'],
    ['sidebar', '.sb'],
    ['shellMain', '.app__main.shell-main'],
    ['envset', '.envset']
  ]) {
    const el = document.querySelector(sel)
    if (!el) {
      shell[name] = null
      continue
    }
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    shell[name] = {
      position: cs.position,
      zIndex: cs.zIndex,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
  }

  return { ok: true, coveredCount: rows.length, covered: rows.slice(0, 20), shell }
})()
