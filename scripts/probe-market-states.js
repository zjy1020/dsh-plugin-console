/**
 * probe-market-states.js —— 用「替换 window.dsh.marketList 的返回值」的方式，测四种状态下界面说什么：
 * 错误（ok:false + error）、空目录（ok:true 但 total 0）、带 warnings、恢复正常。
 * 每次靠「切到别的 tab 再切回来」重新挂载 MarketTab，触发它重新拉取。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-states.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const out = { cases: {} }

  const remount = async () => {
    byText('.install__tab', '智能输入')?.click()
    await sleep(300)
    byText('.install__tab', '插件市场')?.click()
    await sleep(1200)
  }
  const snap = () => ({
    empty: document.querySelector('.empty')?.innerText.replace(/\n+/g, ' | ') ?? null,
    buttons: [...document.querySelectorAll('.install__pane button')].map((b) => b.textContent.trim()).slice(0, 6),
    banner: document.querySelector('.banner')?.innerText.replace(/\n+/g, ' | ') ?? null,
    rows: document.querySelectorAll('.mkt__row').length,
    status: document.querySelector('.mkt__status')?.innerText.split('\n')[0] ?? null
  })
  const blank = (patch) => ({
    ok: true,
    updated: null,
    total: 0,
    categories: [],
    plugins: [],
    source: null,
    cached: false,
    fetchedAt: 0,
    warnings: [],
    error: null,
    ...patch
  })

  if (!document.querySelector('.mkt__input')) {
    byText('button', '安装插件')?.click()
    await sleep(600)
    byText('.install__tab', '插件市场')?.click()
    for (let i = 0; i < 60; i++) {
      if (document.querySelectorAll('.mkt__row').length > 0) break
      await sleep(500)
    }
  }

  const orig = window.dsh.marketList

  // 1) 错误态
  window.dsh.marketList = async () => blank({ ok: false, error: 'HTTP 403：registry 拒绝了这次请求' })
  await remount()
  out.cases.error = snap()

  // 2) 空目录
  window.dsh.marketList = async () => blank({ updated: '2026-11-01' })
  await remount()
  out.cases.empty = snap()

  // 3) 有 warnings（部分源失败但拿到了目录）
  window.dsh.marketList = async () => blank({ total: 1, updated: '2026-11-01', cached: true, fetchedAt: Date.now() - 60000, warnings: ['npm 镜像源失败，改用官网原件'], plugins: [] })
  await remount()
  out.cases.warnings = snap()

  // 4) 恢复
  window.dsh.marketList = orig
  await remount()
  out.cases.normal = snap()

  return out
})()
