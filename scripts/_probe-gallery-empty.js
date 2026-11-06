/* 空态：没有截图的插件应该显示「README 里没有截图」的安静文案，而不是报错。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const close = document.querySelector('.gal-preview__close')
  if (close) close.click()
  const sheetClose = document.querySelector('.mkt__sheet-close')
  if (sheetClose) {
    sheetClose.click()
    await sleep(500)
  }
  const input = document.querySelector('.mkt input[placeholder*="搜"]')
  if (!input) return { err: 'no input' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const kw = window.__probeKw || 'dsh-our-free-model'
  setter.call(input, kw)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(1600)
  const card = document.querySelector('.mkt__card')
  if (!card) return { err: 'no card', kw }
  ;(card.querySelector('.mkt__card-face') || card).click()
  await sleep(1800)
  for (let i = 0; i < 20 && !document.querySelector('.gal__note') && !document.querySelector('.gal__error') && !document.querySelector('.gal__grid img'); i++) {
    await sleep(400)
  }
  out.kw = kw
  out.meta = document.querySelector('.gal__meta')?.textContent || null
  out.note = document.querySelector('.gal__note')?.textContent || null
  out.errorBox = document.querySelector('.gal__error') ? document.querySelector('.gal__error-text')?.textContent : null
  out.gridImgs = document.querySelectorAll('.gal__grid img').length
  out.roleAlert = Boolean(document.querySelector('.gal__error[role="alert"]'))
  return out
})()
