/* 复现 Master 报的「市场 README 截图打开后很小很偏」。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { steps: [] }
  const log = (s) => out.steps.push(s)

  const btns = () => Array.from(document.querySelectorAll('button'))
  const clickText = (re) => {
    const b = btns().find((x) => re.test(x.textContent || ''))
    if (b) {
      b.click()
      return true
    }
    return false
  }

  /* 1. 找到市场 */
  if (!document.querySelector('.mkt')) {
    if (clickText(/安装插件/)) {
      log('clicked 安装插件')
      await sleep(600)
    }
    if (!document.querySelector('.mkt') && clickText(/插件市场/)) {
      log('clicked 插件市场')
      await sleep(1200)
    }
  }
  out.hasMarket = Boolean(document.querySelector('.mkt'))
  if (!out.hasMarket) return out

  /* 2. 搜索 */
  const input = document.querySelector('.mkt input[placeholder*="搜"]')
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'hindsight')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    log('typed hindsight')
    await sleep(900)
  }
  out.cards = document.querySelectorAll('.mkt__card').length

  /* 3. 打开第一张卡的详情 */
  const first = document.querySelector('.mkt__card .mkt__card-face') || document.querySelector('.mkt__card')
  if (first) {
    first.click()
    log('clicked first card')
    await sleep(1500)
  }
  const detail = document.querySelector('.detail')
  out.hasDetail = Boolean(detail)
  out.detailTitle = detail ? (detail.querySelector('h2,h3,.detail__title')?.textContent || '').slice(0, 60) : null

  /* 4. 等图集 */
  for (let i = 0; i < 20 && !document.querySelector('.gal__grid img'); i++) await sleep(400)
  out.galMeta = document.querySelector('.gal__meta')?.textContent || null

  const thumbs = Array.from(document.querySelectorAll('.gal__thumb'))
  out.thumbCount = thumbs.length
  out.thumbs = thumbs.slice(0, 8).map((t) => {
    const img = t.querySelector('img')
    const r = t.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      srcHead: img ? String(img.src).slice(0, 46) : null,
      srcLen: img ? String(img.src).length : 0,
      complete: img ? img.complete : null,
      nat: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      alt: img ? img.alt : null
    }
  })

  /* 5. 点第一张，看预览层 */
  if (thumbs[0]) {
    thumbs[0].click()
    log('clicked thumb 0')
    await sleep(800)
  }
  const layer = document.querySelector('.gal-preview')
  if (!layer) {
    out.preview = 'NOT OPEN'
    return out
  }
  const lr = layer.getBoundingClientRect()
  const stage = layer.querySelector('.gal-preview__stage')
  const sr = stage ? stage.getBoundingClientRect() : null
  const img = layer.querySelector('.gal-preview__img')
  const ir = img ? img.getBoundingClientRect() : null
  const cs = img ? getComputedStyle(img) : null
  out.preview = {
    layerRect: lr ? [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)] : null,
    stageRect: sr ? [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.height)] : null,
    imgRect: ir ? [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)] : null,
    imgComplete: img ? img.complete : null,
    imgNat: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
    imgSrcHead: img ? String(img.src).slice(0, 60) : null,
    imgSrcLen: img ? String(img.src).length : 0,
    imgAlt: img ? img.alt : null,
    imgStyle: cs ? [cs.display, cs.maxWidth, cs.maxHeight, cs.objectFit, cs.width, cs.height].join(' | ') : null,
    boxRect: (() => {
      const b = layer.querySelector('.gal-preview__box')
      const r = b ? b.getBoundingClientRect() : null
      return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null
    })(),
    head: layer.querySelector('.gal-preview__head')?.textContent || null
  }
  return out
})()
