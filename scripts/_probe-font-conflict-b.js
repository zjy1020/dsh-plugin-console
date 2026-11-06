/* _probe-font-conflict-b.js —— 点「应用」，看会不会因为文件已被别人改过而拦下 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const view = document.querySelector('.app__view')
  const btn = [...view.querySelectorAll('.fp__actions button')].find((b) => /应用/.test(b.textContent))
  const disabledBefore = btn ? btn.disabled : 'no-button'
  if (btn && !btn.disabled) btn.click()
  await sleep(2500)
  return {
    disabledBefore,
    banners: [...view.querySelectorAll('.fp__banner')].map((b) => b.textContent.trim()),
    states: [...view.querySelectorAll('.fp__state')].map((s) => s.textContent.trim()),
    tail: view.innerText.slice(-360),
  }
})()
