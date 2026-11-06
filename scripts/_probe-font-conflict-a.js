/* _probe-font-conflict-a.js —— 只改草稿（不动磁盘），好让外面趁机改文件 */
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
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    s.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const view = document.querySelector('.app__view')
  view.querySelectorAll('.fpick__trigger')[0].click()
  const search = await waitFor(() => view.querySelector('.fpick__search'))
  setInput(search, 'SimSun')
  const item = await waitFor(() => [...view.querySelectorAll('.fpick__item')][0])
  const name = item ? item.textContent.trim() : null
  if (item) item.click()
  await sleep(400)
  return {
    picked: name,
    preview: [...view.querySelectorAll('.fp__preview li')].map((li) => li.textContent.trim()),
    applyDisabled: [...view.querySelectorAll('.fp__actions button')].find((b) => /应用/.test(b.textContent))?.disabled,
  }
})()
