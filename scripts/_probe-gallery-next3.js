/* 在已打开的市场图集预览层里翻到「1440x810」那张，量它在整窗灯箱里到底多大。
 * 顺带把图集区的元信息 / 警告文案一起带回来（前一个探针只截了尾部看不到）。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const layer = document.querySelector('.gal-preview')
  out.layerOpen = Boolean(layer)
  out.win = `${window.innerWidth}x${window.innerHeight}`
  out.galMeta = document.querySelector('.gal__meta')?.textContent || null
  out.warns = Array.from(document.querySelectorAll('.gal__warn-line')).map((e) => e.textContent)
  out.thumbSizes = Array.from(document.querySelectorAll('.gal__thumb-size')).map((e) => e.textContent)
  if (!layer) return out

  const nextBtn = () => Array.from(layer.querySelectorAll('button')).find((b) => /下一张/.test(b.textContent || ''))
  const measure = () => {
    const img = document.querySelector('.gal-preview__img')
    const r = img ? img.getBoundingClientRect() : null
    const stage = document.querySelector('.gal-preview__stage')
    const sr = stage ? stage.getBoundingClientRect() : null
    const lr = layer.getBoundingClientRect()
    return {
      imgNat: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      imgAlt: img ? img.alt : null,
      imgRect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
      stageRect: sr ? [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.height)] : null,
      layerRect: [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)],
      fillPct: r && sr ? `${Math.round((r.width / sr.width) * 100)}% 宽 / ${Math.round((r.height / sr.height) * 100)}% 高` : null
    }
  }

  out.steps = []
  for (let i = 0; i < 8; i++) {
    const m = measure()
    out.steps.push(m)
    if (m.imgNat === '1440x810') return { ...out, hit: m }
    const b = nextBtn()
    if (!b) break
    b.click()
    await sleep(500)
  }
  return { ...out, hit: null }
})()
