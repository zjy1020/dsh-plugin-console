/*
 * 走真实用户路径测「导入清单」：
 *   侧栏「安装插件」→ 页签「导入清单」→ 粘贴清单 → 等预览 → 点「安装 N 个」→ 确认框点「安装」→ 读 Toast
 * 清单文本由 _mf-set.js 注入成 globalThis.__MF_TEXT（渲染层 CSP 挡 fetch('file://')，只能这么喂）。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { steps: [] }
  const text = globalThis.__MF_TEXT
  if (!text) return { ok: false, why: '没有 __MF_TEXT（先跑 _mf-set.js）' }

  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const byText = (sel, re, root = document) => [...root.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''))

  /* 1. 进安装页：主区顶部页签「安装插件」（侧栏那个同名按钮点了不切视图，别用它） */
  const tabBtn = [...document.querySelectorAll('[role="tab"]')].find((t) => /安装插件/.test(t.textContent || ''))
  if (!tabBtn) return { ok: false, why: '主区顶部没有「安装插件」页签', out }
  tabBtn.click()
  await sleep(1500)
  out.steps.push(`安装页 tab 数：${document.querySelectorAll('[role="tab"]').length}`)

  /* 2. 切到「导入清单」页签 */
  const tab = byText('[role="tab"], button', /导入清单/)
  if (!tab) return { ok: false, why: '找不到「导入清单」页签', out }
  tab.click()
  await sleep(600)

  /* 3. 粘贴清单 */
  const ta = document.querySelector('textarea.mfst__text') || document.querySelector('textarea[aria-label="清单 JSON 文本"]')
  if (!ta) return { ok: false, why: '找不到清单输入框', out }
  setNative(ta, text)
  out.steps.push('已粘贴清单文本')

  /* 4. 等预览出现「安装 N 个」按钮 */
  let installBtn = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    installBtn = byText('button', /^安装 \d+ 个$/)
    if (installBtn) break
  }
  if (!installBtn) {
    out.previewText = (document.querySelector('.install__preview') || {}).innerText || '(没有预览块)'
    return { ok: false, why: '等不到「安装 N 个」按钮', out }
  }
  out.previewText = (document.querySelector('.install__preview') || {}).innerText || ''
  out.steps.push(`预览按钮文案：${installBtn.textContent.trim()}`)

  /* 5. 点安装 → 确认框 */
  installBtn.click()
  let dlg = null
  for (let i = 0; i < 60; i++) {
    await sleep(200)
    dlg = document.querySelector('.overlay--confirm .dialog--confirm')
    if (dlg) break
  }
  if (!dlg) return { ok: false, why: '确认框没弹出来', out }
  out.confirmTitle = (dlg.querySelector('.dialog__title') || {}).textContent || ''
  out.confirmBody = (dlg.querySelector('.dialog__body') || {}).innerText || ''
  const confirmBtn = byText('.dialog__foot-actions button', /^(安装|确认)/, dlg)
  if (!confirmBtn) return { ok: false, why: '确认框里没有确认按钮', out }
  out.steps.push(`确认按钮：${confirmBtn.textContent.trim()}（标题「${out.confirmTitle}」）`)

  /* 6. 确认，等 Toast */
  const t0 = Date.now()
  const seenBefore = (globalThis.__TOASTS || []).length
  confirmBtn.click()
  let snap = null
  for (let i = 0; i < 300; i++) {
    await sleep(1000)
    const list = globalThis.__TOASTS || []
    const fresh = list.filter((x) => /操作完成|操作失败|部分完成|清单导入/.test(`${x.title}${x.detail}`))
    if (fresh.length > seenBefore - (list.length - fresh.length) && fresh.length > 0 && !/正在|安装中/.test(fresh[fresh.length - 1].title)) { snap = fresh[fresh.length - 1]; break }
    if (Date.now() - t0 > 240000) break
  }
  out.ms = Date.now() - t0
  out.toasts = globalThis.__TOASTS || []
  if (!snap) return { ok: false, why: '记录器里也没有匹配的 Toast', out }
  out.toast = snap
  return out
})()
