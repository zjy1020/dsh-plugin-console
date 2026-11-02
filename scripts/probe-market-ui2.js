/**
 * probe-market-ui2.js —— 插件市场的交互态验收：搜索过滤 / 搜不到 / 清空 /
 * 已安装徽章 / 点「安装」弹出的确认框（只读确认框内容，然后取消，不真装）。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-ui2.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const out = { steps: [] }

  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // 0) 页面可能刚被 reload 过，先自己切到「安装插件 → 插件市场」
  let input = document.querySelector('.mkt__input')
  if (!input) {
    byText('button', '安装插件')?.click()
    await sleep(500)
    byText('.install__tab', '插件市场')?.click()
    for (let i = 0; i < 90; i++) {
      if (document.querySelectorAll('.mkt__row').length > 0) break
      await sleep(500)
    }
    await sleep(600)
    input = document.querySelector('.mkt__input')
    out.steps.push('自己切到了插件市场')
  } else {
    out.steps.push('已经停在插件市场')
  }
  if (!input) return { ...out, error: '没有 .mkt__input，说明没停在插件市场 tab' }

  // 1) 搜索：只搜名字/描述/作者/npm 名
  const t0 = performance.now()
  setInput(input, 'dshmarket')
  await sleep(700)
  out.search = {
    ms: Math.round(performance.now() - t0),
    status: document.querySelector('.mkt__status')?.innerText.split('\n')[0] ?? null,
    rows: document.querySelectorAll('.mkt__row').length,
    names: [...document.querySelectorAll('.mkt__name')].slice(0, 6).map((e) => e.textContent),
    more: document.querySelector('.mkt__more-count')?.textContent ?? null
  }

  // 2) 搜不到时说什么（空态文案要带上搜的词）
  setInput(input, 'zzz-这个插件肯定不存在-zzz')
  await sleep(700)
  out.noResult = {
    rows: document.querySelectorAll('.mkt__row').length,
    empty: document.querySelector('.empty')?.innerText ?? null
  }

  // 3) 清空 → 回到全量
  setInput(input, '')
  await sleep(700)
  out.clearedRows = document.querySelectorAll('.mkt__row').length

  // 4) 「已安装」徽章（目录按默认 profile 判定，装了 16 个）
  const installedRow = [...document.querySelectorAll('.mkt__row')].find((r) =>
    [...r.querySelectorAll('.badge')].some((b) => b.textContent.trim() === '已安装')
  )
  out.installedBadge = installedRow
    ? {
        name: installedRow.querySelector('.mkt__name')?.textContent,
        badges: [...installedRow.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
        installLabel: installedRow.querySelector('.mkt__install')?.textContent.trim() ?? null
      }
    : null

  // 5) 点「安装」→ 确认框（只看内容，然后取消）
  const btn = document.querySelector('.mkt__row .mkt__install')
  btn?.click()
  await sleep(600)
  const dlg = document.querySelector('[role="dialog"], .dialog, .confirm')
  out.dialog = dlg
    ? { text: dlg.innerText, buttons: [...dlg.querySelectorAll('button')].map((b) => b.textContent.trim()) }
    : null

  const cancel = dlg ? [...dlg.querySelectorAll('button')].find((b) => /取消/.test(b.textContent)) : null
  cancel?.click()
  await sleep(500)
  out.cancelled = !document.querySelector('[role="dialog"], .dialog, .confirm')

  return out
})()
