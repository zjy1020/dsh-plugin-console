(() => {
  const d = document.querySelector('.detail')
  if (!d) return { err: 'no detail panel' }
  const zh = d.querySelector('.detail__desc')
  const src = d.querySelector('.detail__desc-src')
  const tag = d.querySelector('.detail__desc-src-tag')
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      fs: cs.fontSize,
      color: cs.color,
      lh: cs.lineHeight,
      mb: cs.marginBottom,
      mt: cs.marginTop
    }
  }
  const body = d.querySelector('.detail__body')
  return {
    name: d.querySelector('.detail__title')?.textContent?.trim(),
    bodyRect: box(body),
    zh: box(zh),
    zhText: zh ? zh.textContent.trim().slice(0, 70) : null,
    src: box(src),
    tag: box(tag),
    srcLines: src ? Math.round(src.getBoundingClientRect().height / parseFloat(getComputedStyle(src).lineHeight || '1')) : 0,
    overflowsX: [...d.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 2).length
  }
})()
