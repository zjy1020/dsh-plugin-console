/**
 * probe-stacking.js —— 把 .wp-layer 与 .titlebar 的祖先链、层叠上下文成因摊开。
 *
 * 为什么要单独查：`elementsFromPoint` 对 `.wp-layer` 是**无效判据** ——
 * 它写了 pointer-events: none，命中测试直接跳过它，所以「没被盖住」是假结论。
 * 只能看绘制顺序：谁创建了层叠上下文、谁在哪个祖先里、z-index 各是多少。
 */
(async () => {
  const desc = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      sel:
        el.tagName.toLowerCase() +
        (el.id ? `#${el.id}` : '') +
        (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).join('.')
          : ''),
      position: cs.position,
      zIndex: cs.zIndex,
      /* 这六个属性任一非默认都会创建层叠上下文 */
      stackingContext: {
        transform: cs.transform,
        filter: cs.filter,
        opacity: cs.opacity,
        isolation: cs.isolation,
        willChange: cs.willChange,
        contain: cs.contain,
        backdropFilter: cs.backdropFilter,
        perspective: cs.perspective,
        mixBlendMode: cs.mixBlendMode
      },
      pointerEvents: cs.pointerEvents,
      overflow: cs.overflow
    }
  }

  const chain = (el) => {
    const out = []
    let n = el
    while (n && n !== document.documentElement) {
      out.push(desc(n))
      n = n.parentElement
    }
    out.push(desc(document.documentElement))
    return out
  }

  const wp = document.querySelector('.wp-layer')
  const tb = document.querySelector('.titlebar')
  const card = document.querySelector('.envset[data-probe]')

  /* 兄弟姐妹顺序：同一个父容器里，谁先谁后决定同层级的绘制先后 */
  const order = (el) => {
    if (!el || !el.parentElement) return null
    return [...el.parentElement.children].map(
      (c, i) =>
        `${i}:${c.tagName.toLowerCase()}${
          c.className && typeof c.className === 'string'
            ? '.' + c.className.trim().split(/\s+/)[0]
            : ''
        }`
    )
  }

  return {
    wpChain: chain(wp),
    tbChain: chain(tb),
    cardChain: card ? chain(card) : null,
    appChildOrder: order(wp),
    bodyChildOrder: order(document.querySelector('.app')),
    htmlChildOrder: order(document.body)
  }
})()
