/* _probe-font-apply-reset.js —— 再点一次应用（这次 mtime 对得上），然后走「恢复默认」的两段确认 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const view = document.querySelector('.app__view')
  const btnOf = (re) => [...view.querySelectorAll('.fp__actions button')].find((b) => re.test(b.textContent))
  const out = {}

  let apply = btnOf(/应用/)
  if (apply && !apply.disabled) apply.click()
  await sleep(2500)
  out.afterApply = {
    states: [...view.querySelectorAll('.fp__state')].map((s) => s.textContent.trim()),
    preview: [...view.querySelectorAll('.fp__preview li')].map((li) => li.textContent.trim()),
    tail: view.innerText.slice(-260),
  }

  // 恢复默认：先点一次「arm」，再点一次真删
  const reset = btnOf(/恢复默认/)
  out.resetLabel1 = reset ? reset.textContent.trim() : 'no-button'
  if (reset) reset.click()
  await sleep(400)
  const reset2 = btnOf(/恢复默认/)
  out.resetLabel2 = reset2 ? reset2.textContent.trim() : 'no-button'
  if (reset2) reset2.click()
  await sleep(2500)
  out.afterReset = {
    states: [...view.querySelectorAll('.fp__state')].map((s) => s.textContent.trim()),
    preview: [...view.querySelectorAll('.fp__preview li')].map((li) => li.textContent.trim()),
    tail: view.innerText.slice(-320),
  }
  return out
})()
