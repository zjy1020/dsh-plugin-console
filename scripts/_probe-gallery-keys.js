/* 键盘 / 焦点 / 点背景：整窗灯箱的交互都还在不在（Esc 只关灯箱，不顺手关掉市场 sheet）。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { steps: [] }
  const layer = () => document.querySelector('.gal-preview')
  const thumb0 = () => document.querySelector('.gal__thumb')
  const press = (key, el) => {
    const node = el || layer() || document.body
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  const click = (el) => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    el.click()
  }

  /* 打开 */
  const t0 = thumb0()
  if (!t0) return { err: 'no thumb', ...out }
  t0.focus()
  click(t0)
  await sleep(600)
  out.opened = Boolean(layer())
  out.focusInLayer = document.activeElement === layer() || layer()?.contains(document.activeElement)
  out.sheetAliveBefore = Boolean(document.querySelector('.mkt__sheet'))

  /* → 切下一张 */
  const before = layer()?.querySelector('.gal-preview__counter')?.textContent
  press('ArrowRight')
  await sleep(400)
  const after = layer()?.querySelector('.gal-preview__counter')?.textContent
  out.arrow = `${before} -> ${after}`

  /* ← 切回来 */
  press('ArrowLeft')
  await sleep(400)
  out.arrowBack = layer()?.querySelector('.gal-preview__counter')?.textContent

  /* Tab 焦点锁：连按 6 次 Tab，焦点应该始终在灯箱内 */
  let escaped = 0
  for (let i = 0; i < 6; i++) {
    const nodes = Array.from(
      layer()?.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') || []
    ).filter((el) => el.offsetParent !== null)
    const last = nodes[nodes.length - 1]
    last?.focus()
    press('Tab', last)
    await sleep(120)
    if (!layer()?.contains(document.activeElement)) escaped += 1
  }
  out.tabEscapes = escaped

  /* Esc：只关灯箱 */
  press('Escape', document.activeElement)
  await sleep(500)
  out.closedByEsc = !layer()
  out.sheetAliveAfter = Boolean(document.querySelector('.mkt__sheet'))
  out.focusBackToThumb = document.activeElement === thumb0()
  out.focusTag = document.activeElement ? document.activeElement.className : null

  /* 再开一次，用「点背景」关 */
  click(thumb0())
  await sleep(500)
  out.reopened = Boolean(layer())
  const l = layer()
  l?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await sleep(400)
  out.closedByBackdrop = !layer()

  return out
})()
