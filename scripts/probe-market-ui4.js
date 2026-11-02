/**
 * probe-market-ui4.js —— 插件市场的工具条功能验收：分类下拉 / 排序切换 / 加载更多 / 重新拉取。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-ui4.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const out = {}

  if (!document.querySelector('.mkt__input')) {
    byText('button', '安装插件')?.click()
    await sleep(600)
    byText('.install__tab', '插件市场')?.click()
    for (let i = 0; i < 90; i++) {
      if (document.querySelectorAll('.mkt__row').length > 0) break
      await sleep(500)
    }
    await sleep(800)
  }

  const status = () => document.querySelector('.mkt__status')?.innerText.split('\n')[0] ?? null
  const rows = () => document.querySelectorAll('.mkt__row').length

  // 1) 分类下拉：选第一个非「全部」的分类，条数应该正好等于括号里的数
  const sel = document.querySelector('.mkt__select select')
  const opt = sel?.options?.[1]
  if (sel && opt) {
    const label = opt.textContent
    const count = Number((label.match(/（(\d+)）/) || [])[1] || 0)
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(sel, opt.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(1200)
    out.category = { picked: label, expectedCount: count, status: status(), rows: rows(), sample: document.querySelector('.mkt__name')?.textContent ?? null }
    setter.call(sel, 'all')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(1000)
  }

  // 2) 排序切换：下载量（第一行应该是下载量最高的那条）
  const dl = byText('.mkt__sorts button', '下载量')
  dl?.click()
  await sleep(1200)
  out.sortDownloads = { pressed: dl?.getAttribute('aria-pressed'), firstRow: document.querySelector('.mkt__row')?.innerText.split('\n')[0] ?? null }
  const star = byText('.mkt__sorts button', '星标')
  star?.click()
  await sleep(1200)
  out.sortStars = { pressed: star?.getAttribute('aria-pressed'), firstRow: document.querySelector('.mkt__row')?.innerText.split('\n')[0] ?? null }
  const added = byText('.mkt__sorts button', '最近加入')
  added?.click()
  await sleep(1200)
  out.sortAdded = { pressed: added?.getAttribute('aria-pressed'), firstRow: document.querySelector('.mkt__row')?.innerText.split('\n')[0] ?? null }
  const back = byText('.mkt__sorts button', '星标')
  back?.click()
  await sleep(1000)

  // 3) 加载更多：60 → 120
  const before = rows()
  byText('.mkt__more button', '再显示')?.click()
  await sleep(900)
  out.loadMore = { before, after: rows(), more: document.querySelector('.mkt__more-count')?.textContent }
  out.domNodes = document.querySelectorAll('*').length

  // 4) 重新拉取（force:true）：状态行不再说「用的是本地缓存」
  const refresh = byText('.mkt__bar button', '重新拉取')
  const t0 = performance.now()
  refresh?.click()
  await sleep(2500)
  out.refresh = {
    ms: Math.round(performance.now() - t0),
    status: document.querySelector('.mkt__status')?.innerText.replace(/\n+/g, ' | ') ?? null,
    usesCache: /本地缓存/.test(document.querySelector('.mkt__status')?.innerText || ''),
    rows: rows()
  }

  return out
})()
