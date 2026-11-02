/**
 * probe-market-ready.js —— 确认探针实例处于可用状态：选了 profile、五个 tab 在位、市场 tab 能进。
 * 用法：CDP_PORT=9334 node scripts/cdp-eval.mjs --file scripts/probe-market-ready.js
 */
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const out = { url: location.href }

  out.sidebarProfiles = [...document.querySelectorAll('[class*="sidebar"] [class*="profile"], .side__item, .profile-row')]
    .map((e) => (e.textContent || '').trim())
    .slice(0, 8)
  out.bodyHead = (document.body.innerText || '').slice(0, 200).replace(/\n+/g, ' | ')

  if (!document.querySelector('.install__tab')) {
    byText('button', '安装插件')?.click()
    await nap(600)
  }
  out.tabs = [...document.querySelectorAll('.install__tab')].map((t) => ({
    label: (t.textContent || '').trim(),
    selected: t.getAttribute('aria-selected')
  }))
  const tab = byText('.install__tab', '插件市场')
  out.hasMarketTab = !!tab
  tab?.click()
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.mkt__input')) break
    await nap(200)
  }
  out.marketRendered = !!document.querySelector('.mkt__input')
  out.emptyState = (document.querySelector('.empty__title')?.textContent || '').trim() || null
  out.profileShown = [...document.querySelectorAll('.mkt__sheet-actions button')].length ? 'detail-open' : null
  return out
})()
