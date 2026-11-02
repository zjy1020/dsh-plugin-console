/**
 * probe-market-focus.js —— 阶段式复验：打开详情 → 焦点进面板；Esc → 焦点回卡片。
 * 每个时间点都读一次 activeElement，能看到焦点有没有被后来的提交抢走。
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-focus.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const snap = () => {
    const a = document.activeElement
    return {
      tag: a?.tagName ?? null,
      cls: (a?.className || '').toString().slice(0, 60),
      name: (a?.querySelector?.('.mkt__card-name')?.textContent || '').trim() || null
    }
  }
  const out = { rafFires: null, steps: [] }

  // rAF 在这个窗口里到底会不会触发（后台/遮挡窗口常常不触发，正好解释焦点问题）
  out.rafFires = await new Promise((resolve) => {
    let done = false
    requestAnimationFrame(() => {
      done = true
      resolve(true)
    })
    setTimeout(() => !done && resolve(false), 800)
  })

  if (!document.querySelector('.mkt__input')) byText('button', '安装插件')?.click()
  await sleep(500)
  byText('.install__tab', '插件市场')?.click()
  for (let i = 0; i < 60; i++) {
    if (document.querySelectorAll('.mkt__card').length > 0) break
    await sleep(250)
  }
  await sleep(600)

  const cards = [...document.querySelectorAll('.mkt__card')]
  const target = cards[1]
  const face = target.querySelector('.mkt__card-face')
  const wantName = (target.querySelector('.mkt__card-name')?.textContent || '').trim()
  face.focus()
  out.steps.push({ at: '卡片 focus 后', ...snap() })

  face.click()
  await sleep(60)
  out.steps.push({ at: '点开后 60ms', sheet: !!document.querySelector('.mkt__sheet'), ...snap() })
  await sleep(400)
  out.steps.push({ at: '点开后 460ms', ...snap() })

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  out.steps.push({ at: 'Esc 后 0ms', sheet: !!document.querySelector('.mkt__sheet'), ...snap() })
  await sleep(60)
  out.steps.push({ at: 'Esc 后 60ms', sheet: !!document.querySelector('.mkt__sheet'), ...snap() })
  await sleep(400)
  const after = snap()
  out.steps.push({ at: 'Esc 后 460ms', sheet: !!document.querySelector('.mkt__sheet'), ...after })

  out.result = {
    wantCard: wantName,
    focusedIsSameFace: document.activeElement === face,
    focusBackOnCard: document.activeElement?.classList?.contains('mkt__card-face') ?? false,
    focusBackOnSameCard: after.name === wantName
  }
  return out
})()
