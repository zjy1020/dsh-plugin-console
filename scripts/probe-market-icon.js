/**
 * probe-market-icon.js —— 验两件事：
 *   1) 目录 icon 字段的那条路（搜带 icon 的条目，看 .mkt__icon--img 是否出现、是否真的解码出来；解码失败就降级 monogram，不能留空洞）
 *   2) 宫格的「再看 48 个」分批渲染还正常
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-icon.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const txt = (el) => (el?.innerText || '').replace(/\n+/g, ' | ').trim()
  const out = {}

  if (!document.querySelector('.mkt__input')) byText('button', '安装插件')?.click()
  await sleep(500)
  byText('.install__tab', '插件市场')?.click()
  for (let i = 0; i < 60; i++) {
    if (document.querySelectorAll('.mkt__card').length > 0) break
    await sleep(250)
  }
  await sleep(500)

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const type = async (v) => {
    const input = document.querySelector('.mkt__input')
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1400)
  }

  // 1) 带 icon 字段的条目（目录里 DSH-AGINT / dsh-turbo 都有 icon）
  await type('DSH-AGINT')
  await sleep(2500) // 等图片加载：raw.githubusercontent 在国内可能很慢或直接失败
  const cards = [...document.querySelectorAll('.mkt__card')]
  const card = cards[0]
  const img = card?.querySelector('.mkt__icon--img')
  out.iconField = {
    cardName: card?.querySelector('.mkt__card-name')?.textContent?.trim() ?? null,
    imgTag: !!img,
    imgSrc: img?.getAttribute('src') ?? null,
    decoded: img ? { complete: img.complete, naturalWidth: img.naturalWidth } : null,
    fellBackToMono: !!card?.querySelector('.mkt__icon--mono'),
    fellBackToLocal: !!card?.querySelector('.picon-img, .picon-ph'),
    anyHole: cards.length > 0 && cards.every((c) => !c.querySelector('.mkt__icon, .picon-img, .picon-ph')),
    cardText: txt(card?.querySelector('.mkt__card-face'))
  }

  // 2) 分批渲染
  await type('')
  const before = document.querySelectorAll('.mkt__card').length
  const domBefore = document.querySelectorAll('*').length
  byText('.mkt__more button', '再看')?.click()
  await sleep(900)
  const after = document.querySelectorAll('.mkt__card').length
  out.paging = {
    before,
    after,
    domBefore,
    domAfter: document.querySelectorAll('*').length,
    more: txt(document.querySelector('.mkt__more'))
  }
  return out
})()
