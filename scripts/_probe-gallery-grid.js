/* 关灯箱 → 关 sheet → 搜 archify → 点「真包名」那张卡（名字里不带 #）→ 停在缩略图网格上。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}

  /* 1. 关掉可能开着的整窗灯箱（Esc 只关它自己） */
  const layer = document.querySelector('.gal-preview')
  if (layer) {
    const closeBtn = layer.querySelector('.gal-preview__close')
    if (closeBtn) closeBtn.click()
    await sleep(500)
    out.layerClosed = !document.querySelector('.gal-preview')
  } else {
    out.layerClosed = true
  }

  /* 2. 关 sheet，退回列表 */
  const sheetClose = document.querySelector('.mkt__sheet-close')
  if (sheetClose) {
    sheetClose.click()
    await sleep(600)
  }

  const input = document.querySelector('.mkt input[placeholder*="搜"]')
  if (!input) return { ...out, err: 'no search input' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'archify')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(1600)

  const cards = Array.from(document.querySelectorAll('.mkt__card'))
  out.cardNames = cards.map((c) => c.querySelector('.mkt__card-name')?.textContent || '')
  const pick = cards.find((c) => {
    const n = c.querySelector('.mkt__card-name')?.textContent || ''
    return /archify/i.test(n)
  })
  if (!pick) return { ...out, err: 'no plain archify card' }
  const face = pick.querySelector('.mkt__card-face') || pick
  face.click()
  await sleep(1800)

  for (let i = 0; i < 25 && !document.querySelector('.gal__grid img') && !document.querySelector('.gal__note'); i++) {
    await sleep(400)
  }
  out.opened = pick.querySelector('.mkt__card-name')?.textContent || ''
  out.galMeta = document.querySelector('.gal__meta')?.textContent || null
  const thumbs = Array.from(document.querySelectorAll('.gal__thumb'))
  out.thumbCount = thumbs.length
  out.thumbs = thumbs.map((t, i) => {
    const img = t.querySelector('img')
    return {
      i,
      nat: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      alt: img ? String(img.alt).slice(0, 56) : null,
      size: t.querySelector('.gal__thumb-size')?.textContent || null
    }
  })
  const deco = /sponsor|badge|logo|shield|banner|二维码|赞助/i
  out.decoHits = out.thumbs.filter((t) => deco.test(t.alt || '')).map((t) => t.alt)
  out.gridRect = (() => {
    const g = document.querySelector('.gal__grid')
    const r = g ? g.getBoundingClientRect() : null
    return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null
  })()
  return out
})()
