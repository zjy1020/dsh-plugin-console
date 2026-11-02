/**
 * probe-market-grid.js —— 验「插件市场」新版宫格 + 详情 + 已安装态 + 换版本。
 * 纯读：只点按钮/卡片，不改任何数据（不会真的触发安装）。
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-grid.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const txt = (el) => (el?.innerText || '').replace(/\n+/g, ' | ').trim()
  const out = {}

  // 进市场 tab
  if (!document.querySelector('.mkt__input')) byText('button', '安装插件')?.click()
  await sleep(600)
  byText('.install__tab', '插件市场')?.click()
  for (let i = 0; i < 80; i++) {
    if (document.querySelectorAll('.mkt__card').length > 0) break
    await sleep(250)
  }
  await sleep(600)

  // 1) 宫格本身
  const grid = document.querySelector('.mkt__grid')
  const cards = [...document.querySelectorAll('.mkt__card')]
  const cs = grid ? getComputedStyle(grid) : null
  const topOf = (el) => Math.round(el.getBoundingClientRect().top)
  const heights = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height)))]
  const firstRow = cards.filter((c) => topOf(c) === topOf(cards[0]))
  const iconStats = { img: 0, mono: 0, local: 0, hole: 0 }
  for (const c of cards) {
    const img = c.querySelector('.mkt__icon--img')
    const mono = c.querySelector('.mkt__icon--mono')
    const local = c.querySelector('.picon-img, .picon-ph')
    if (img) iconStats.img++
    else if (mono) iconStats.mono++
    else if (local) iconStats.local++
    else iconStats.hole++
  }
  out.grid = {
    columns: cs?.gridTemplateColumns?.split(' ').length ?? 0,
    templateCols: cs?.gridTemplateColumns ?? null,
    cards: cards.length,
    perRow: firstRow.length,
    heights,
    iconStats,
    domNodes: document.querySelectorAll('*').length,
    status: txt(document.querySelector('.mkt__status')),
    firstCard: txt(cards[0]?.querySelector('.mkt__card-face')),
    firstCardAct: txt(cards[0]?.querySelector('.mkt__card-act')),
    more: txt(document.querySelector('.mkt__more'))
  }

  // 2) 点第一张卡 -> 详情
  const card0 = cards[0].querySelector('.mkt__card-face')
  card0.focus()
  card0.click()
  await sleep(400)
  const sheet = document.querySelector('.mkt__sheet')
  const sheetBtns = [...(sheet?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim())
  out.detail = {
    opened: !!sheet,
    role: sheet?.getAttribute('role'),
    ariaModal: sheet?.getAttribute('aria-modal'),
    ariaLabelledby: sheet?.getAttribute('aria-labelledby'),
    buttons: sheetBtns,
    sections: {
      slot: txt(sheet?.querySelector('.mkt__slot')),
      kvKeys: [...(sheet?.querySelectorAll('.kv__k') ?? [])].map((k) => k.textContent.trim()),
      caps: txt(sheet?.querySelector('.mkt__caps--detail')),
      desc: (sheet?.querySelector('.mkt__sheet-desc')?.textContent || '').slice(0, 90),
      title: txt(sheet?.querySelector('.mkt__sheet-title'))
    },
    focusInsideSheet: !!sheet && !!document.activeElement && sheet.contains(document.activeElement),
    overlayZ: getComputedStyle(document.querySelector('.mkt__overlay')).zIndex
  }

  // 3) Esc 关闭 + 焦点回到卡片
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(400)
  const active = document.activeElement
  out.escClose = {
    sheetGone: !document.querySelector('.mkt__sheet'),
    focusBackOnCard: !!active && active.classList.contains('mkt__card-face'),
    focusName: active?.querySelector?.('.mkt__card-name')?.textContent ?? active?.className ?? null
  }

  // 4) 搜 dshmarket（目录里自己那一条，本机已装）-> 已安装态 + 换版本
  const input = document.querySelector('.mkt__input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'dshmarket')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(1500)
  const hits = [...document.querySelectorAll('.mkt__card')]
  const hit = hits.find((c) => (c.querySelector('.mkt__card-name')?.textContent || '').trim() === 'dsh-market') || hits[0]
  out.installedCard = {
    hits: hits.length,
    name: hit?.querySelector('.mkt__card-name')?.textContent?.trim() ?? null,
    act: txt(hit?.querySelector('.mkt__card-act')),
    hasInstallButton: !!(hit?.querySelector('.mkt__card-act button')),
    badges: [...(hit?.querySelectorAll('.badge') ?? [])].map((b) => b.textContent.trim())
  }
  hit?.querySelector('.mkt__card-face')?.click()
  await sleep(500)
  const sheet2 = document.querySelector('.mkt__sheet')
  out.installedDetail = {
    title: txt(sheet2?.querySelector('.mkt__sheet-title')),
    badges: [...(sheet2?.querySelectorAll('.mkt__badges .badge') ?? [])].map((b) => b.textContent.trim()),
    buttons: [...(sheet2?.querySelectorAll('.mkt__sheet-actions button') ?? [])].map((b) => b.textContent.trim()),
    note: txt(sheet2?.querySelector('.mkt__sheet-note')),
    hasInstallBtn: [...(sheet2?.querySelectorAll('.mkt__sheet-actions button') ?? [])].some((b) => /安装/.test(b.textContent))
  }

  // 5) 换版本 -> VersionPicker（input 必须是 npm 包名）
  byText('.mkt__sheet-actions button', '换版本')?.click()
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('.mkt__picker [role="listbox"], .mkt__picker [role="option"]')) break
    await sleep(300)
  }
  const picker = document.querySelector('.mkt__picker')
  out.picker = {
    mounted: !!picker,
    note: txt(picker?.querySelector('.mkt__picker-note')),
    listbox: !!picker?.querySelector('[role="listbox"]'),
    options: (picker?.querySelectorAll('[role="option"]')?.length ?? 0),
    firstOptions: [...(picker?.querySelectorAll('[role="option"]') ?? [])].slice(0, 4).map((o) => txt(o)),
    mentionsPkg: /dshmarket/.test(picker?.innerText || '')
  }

  // 收尾：关掉 picker 与详情，回到列表
  byText('.mkt__picker button', '取消')?.click()
  await sleep(300)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(300)
  // 清空搜索，恢复默认列表
  const input2 = document.querySelector('.mkt__input')
  setter.call(input2, '')
  input2.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(500)
  out.cleanup = { sheetOpen: !!document.querySelector('.mkt__sheet'), cards: document.querySelectorAll('.mkt__card').length }
  return out
})()
