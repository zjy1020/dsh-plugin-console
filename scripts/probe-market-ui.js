/**
 * probe-market-ui.js —— 切到「安装插件 → 插件市场」，dump 前 5 行文本 + 列表统计。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-ui.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const out = { steps: [] }

  // 1) 进「安装插件」视图
  const navBtn = byText('button', '安装插件')
  if (navBtn) {
    navBtn.click()
    out.steps.push('clicked 安装插件')
  } else {
    out.steps.push('没找到「安装插件」按钮')
  }
  await sleep(400)

  // 2) 点第 5 个 tab「插件市场」
  const tab = byText('.install__tab', '插件市场')
  if (!tab) {
    return { ...out, error: '没找到「插件市场」tab', tabs: [...document.querySelectorAll('.install__tab')].map((e) => e.textContent.trim()) }
  }
  tab.click()
  out.steps.push('clicked 插件市场')
  out.tabs = [...document.querySelectorAll('.install__tab')].map((e) => e.textContent.trim())
  out.tabSelected = tab.getAttribute('aria-selected')

  // 3) 等列表出来（目录大，最多等 40 秒）
  const t0 = performance.now()
  for (let i = 0; i < 80; i++) {
    if (document.querySelectorAll('.mkt__row').length > 0) break
    await sleep(500)
  }
  await sleep(600)
  out.waitMs = Math.round(performance.now() - t0)

  const rows = [...document.querySelectorAll('.mkt__row')]
  out.rowCount = rows.length
  out.status = document.querySelector('.mkt__status')?.innerText ?? null
  out.more = document.querySelector('.mkt__more')?.innerText ?? null
  out.first5 = rows.slice(0, 5).map((r) => r.innerText)
  out.first5Classes = rows.slice(0, 5).map((r) => ({
    name: r.querySelector('.mkt__name')?.textContent,
    badges: [...r.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
    caps: [...r.querySelectorAll('.mkt__cap')].map((c) => c.textContent.trim()),
    capNote: r.querySelector('.mkt__cap-note')?.textContent ?? null,
    acts: [...r.querySelectorAll('.mkt__row-act button')].map((b) => b.textContent.trim())
  }))
  out.banner = document.querySelector('.banner')?.innerText ?? null
  out.domNodes = document.querySelectorAll('*').length

  // 4) 分类下拉的选项（截前 8 个）
  const sel = document.querySelector('.mkt__select select')
  out.categoryOptions = sel ? [...sel.options].slice(0, 8).map((o) => o.textContent) : null
  out.categoryOptionCount = sel ? sel.options.length : null

  // 5) 排序按钮
  out.sortButtons = [...document.querySelectorAll('.mkt__sorts button')].map((b) => `${b.textContent.trim()}${b.getAttribute('aria-pressed') === 'true' ? '(选中)' : ''}`)

  return out
})()
