/* 验证症状 B：README 顶部的赞助商徽章 / logo 有没有被当成截图。
 * 关键词从 window.__probeKw 取（cdp-eval 不支持给 --file 传参），默认 archify。 */
(async () => {
  const kw = window.__probeKw || 'archify'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { kw, steps: [] }
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

  /* 关掉可能开着的详情 sheet，好让搜索框重新可见 */
  const closeBtn = document.querySelector('.mkt__sheet-close')
  if (closeBtn) {
    closeBtn.click()
    log('closed detail')
    await sleep(600)
  }

  if (!document.querySelector('.mkt')) {
    if (clickText(/安装插件/)) {
      log('clicked 安装插件')
      await sleep(700)
    }
    if (!document.querySelector('.mkt') && clickText(/插件市场/)) {
      log('clicked 插件市场')
      await sleep(1300)
    }
  }
  out.hasMarket = Boolean(document.querySelector('.mkt'))
  if (!out.hasMarket) return out

  const input = document.querySelector('.mkt input[placeholder*="搜"]')
  if (!input) {
    out.err = 'no search input'
    return out
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, kw)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  log(`typed ${kw}`)
  await sleep(1600)

  out.cards = document.querySelectorAll('.mkt__card').length
  out.cardNames = Array.from(document.querySelectorAll('.mkt__card-name'))
    .slice(0, 6)
    .map((e) => e.textContent)

  const face = document.querySelector('.mkt__card .mkt__card-face')
  if (face) {
    face.click()
    log('clicked card')
    await sleep(1800)
  }

  for (
    let i = 0;
    i < 25 &&
    !document.querySelector('.gal__grid img') &&
    !document.querySelector('.gal__note') &&
    !document.querySelector('.gal__error');
    i++
  ) {
    await sleep(400)
  }

  out.galMeta = document.querySelector('.gal__meta')?.textContent || null
  out.emptyNote = document.querySelector('.gal__note')?.textContent || null
  out.errorText = document.querySelector('.gal__error-text')?.textContent || null
  out.warns = Array.from(document.querySelectorAll('.gal__warn-line')).map((e) => e.textContent)

  const deco = /sponsor|badge|logo|icon|avatar|banner|shield|sticker|qrcode|wechat|qq|group|alipay|paypal|ko-?fi|afdian/i
  const thumbs = Array.from(document.querySelectorAll('.gal__thumb'))
  out.thumbCount = thumbs.length
  out.thumbs = thumbs.slice(0, 10).map((t, i) => {
    const img = t.querySelector('img')
    const alt = img ? img.alt : null
    return {
      i,
      alt,
      nat: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      box: (() => {
        const r = t.getBoundingClientRect()
        return `${Math.round(r.width)}x${Math.round(r.height)}`
      })(),
      sizeLabel: t.querySelector('.gal__thumb-size')?.textContent || null,
      decoHit: deco.test(alt || ''),
      srcHead: img ? String(img.src).slice(0, 40) : null
    }
  })

  /* 点开第一张，量预览层；顺便从「打开原图」的 title 拿到原始 URL */
  if (thumbs[0]) {
    thumbs[0].click()
    log('clicked thumb 0')
    await sleep(900)
  }
  const layer = document.querySelector('.gal-preview')
  if (!layer) {
    out.preview = 'NOT OPEN'
    return out
  }
  const rectOf = (el) => {
    const r = el ? el.getBoundingClientRect() : null
    return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null
  }
  const img = layer.querySelector('.gal-preview__img')
  const cs = img ? getComputedStyle(img) : null
  const originBtn = Array.from(layer.querySelectorAll('button')).find((b) => /打开原图/.test(b.textContent || ''))
  out.preview = {
    layerRect: rectOf(layer),
    stageRect: rectOf(layer.querySelector('.gal-preview__stage')),
    boxRect: rectOf(layer.querySelector('.gal-preview__box')),
    imgRect: rectOf(img),
    imgNat: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
    imgAlt: img ? img.alt : null,
    imgStyle: cs ? [cs.maxWidth, cs.maxHeight, cs.objectFit, cs.width, cs.height].join(' | ') : null,
    originUrl: originBtn ? originBtn.getAttribute('title') : null,
    head: layer.querySelector('.gal-preview__head')?.textContent || null,
    win: `${window.innerWidth}x${window.innerHeight}`,
    nextCount: (() => {
      const b = Array.from(layer.querySelectorAll('button')).find((x) => /下一张/.test(x.textContent || ''))
      if (!b) return null
      b.click()
      return 'clicked'
    })()
  }
  await sleep(700)
  const img2 = document.querySelector('.gal-preview__img')
  out.afterNext = {
    alt: img2 ? img2.alt : null,
    nat: img2 ? `${img2.naturalWidth}x${img2.naturalHeight}` : null,
    rect: rectOf(img2)
  }
  return out
})()
