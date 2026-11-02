/**
 * probe-market-ui3.js —— 补测交互态（每一步都回读输入框的值 + 状态行，等够时间）：
 * 搜索 / 搜不到的空态 / 清空 / 已安装徽章 / 点「安装」的确认框（只读，然后取消）。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-ui3.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const out = { steps: [] }

  const setInput = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const snap = () => ({
    value: document.querySelector('.mkt__input')?.value ?? null,
    status: document.querySelector('.mkt__status')?.innerText.split('\n')[0] ?? null,
    rows: document.querySelectorAll('.mkt__row').length,
    empty: document.querySelector('.empty')?.innerText ?? null,
    more: document.querySelector('.mkt__more-count')?.textContent ?? null
  })

  // 0) 切到插件市场（页面可能刚被 reload 过）
  if (!document.querySelector('.mkt__input')) {
    byText('button', '安装插件')?.click()
    await sleep(600)
    byText('.install__tab', '插件市场')?.click()
    for (let i = 0; i < 90; i++) {
      if (document.querySelectorAll('.mkt__row').length > 0) break
      await sleep(500)
    }
    await sleep(800)
    out.steps.push('自己切到了插件市场')
  } else {
    out.steps.push('已经停在插件市场')
  }

  // 1) 搜 dshmarket（顺带看「已安装」徽章：默认 profile 里 dshmarket 是装着的）
  setInput(document.querySelector('.mkt__input'), 'dshmarket')
  await sleep(1500)
  out.search = snap()
  out.search.firstRow = document.querySelector('.mkt__row')?.innerText.replace(/\n+/g, ' | ') ?? null
  out.search.badges = document.querySelector('.mkt__row')
    ? [...document.querySelector('.mkt__row').querySelectorAll('.badge')].map((b) => b.textContent.trim())
    : null
  out.search.installLabel = document.querySelector('.mkt__row .mkt__install')?.textContent.trim() ?? null

  // 2) 搜一个肯定没有的词 → 空态文案
  setInput(document.querySelector('.mkt__input'), 'zzz-不存在的插件-zzz')
  await sleep(1500)
  out.noResult = snap()

  // 3) 清空 → 回到全量
  setInput(document.querySelector('.mkt__input'), '')
  await sleep(1500)
  out.cleared = snap()

  // 4) 点第一行「安装」→ 确认框（只看内容，然后点取消，不真装）
  document.querySelector('.mkt__row .mkt__install')?.click()
  await sleep(900)
  const dlg = document.querySelector('[role="alertdialog"]')
  out.dialog = dlg
    ? { text: dlg.innerText.replace(/\n+/g, ' | '), buttons: [...dlg.querySelectorAll('button')].map((b) => b.textContent.trim()) }
    : null
  const cancel = dlg ? [...dlg.querySelectorAll('button')].find((b) => /取消/.test(b.textContent)) : null
  cancel?.click()
  await sleep(700)
  out.dialogClosed = document.querySelector('[role="alertdialog"]') === null

  return out
})()
