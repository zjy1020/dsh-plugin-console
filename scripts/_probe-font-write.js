/* _probe-font-write.js —— 在字体面板里真选字体并点「应用」。
   跑法：node scripts/cdp-eval.mjs --file scripts/_probe-font-write.js */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, timeout = 3000) => {
    const t0 = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() - t0 > timeout) return null
      await sleep(120)
    }
  }
  const setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const view = document.querySelector('.app__view')
  const out = {}

  /* 给第 idx 个角色选一个字体：打开 → 筛 → 点第一条 */
  const pickRole = async (idx, keyword) => {
    const t = view.querySelectorAll('.fpick__trigger')[idx]
    if (!t) return { err: `没有第 ${idx} 个选择器` }
    t.click()
    const search = await waitFor(() => view.querySelector('.fpick__search'))
    if (!search) return { err: '弹出层没出现' }
    setInput(search, keyword)
    const item = await waitFor(() => [...view.querySelectorAll('.fpick__item')][0])
    if (!item) return { err: `没筛出「${keyword}」` }
    const name = item.textContent.trim()
    item.click()
    await sleep(350)
    return { picked: name }
  }

  out.text = await pickRole(0, 'YaHei')
  out.code = await pickRole(1, 'Cascadia')
  out.terminal = await pickRole(2, 'Consolas')

  out.preview = [...view.querySelectorAll('.fp__preview li')].map((li) => li.textContent.trim())

  const btn = [...view.querySelectorAll('.fp__actions button')].find((b) => /应用/.test(b.textContent))
  out.applyDisabled = btn ? btn.disabled : 'no-button'
  if (btn && !btn.disabled) btn.click()
  await sleep(2500)

  out.banners = [...view.querySelectorAll('.fp__banner')].map((b) => b.textContent.trim())
  out.states = [...view.querySelectorAll('.fp__state')].map((s) => s.textContent.trim())
  out.previewAfter = [...view.querySelectorAll('.fp__preview li')].map((li) => li.textContent.trim())
  out.afterText = view.innerText.slice(-400)
  return out
})()
