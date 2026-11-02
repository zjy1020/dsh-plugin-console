(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byPrefix = (tag, prefix) =>
    Array.from(document.querySelectorAll(tag)).find((n) => (n.textContent || '').trim().startsWith(prefix))

  const installed = byPrefix('button', '已安装')
  installed?.click()
  await sleep(500)

  const check = byPrefix('button', '检查更新')
  check?.click()

  for (let i = 0; i < 40; i += 1) {
    await sleep(1000)
    const busy = Array.from(document.querySelectorAll('button')).some(
      (n) => /检查中|正在检查|更新中/.test(n.textContent || '') || n.getAttribute('aria-busy') === 'true'
    )
    if (!busy) {
      await sleep(600)
      break
    }
  }

  const rows = Array.from(document.querySelectorAll('.prow')).map((r) => r.innerText.replace(/\n+/g, ' | '))
  const foot = document.querySelector('.plist__foot')?.innerText.replace(/\n+/g, ' | ')
  return JSON.stringify({ count: rows.length, foot, rows }, null, 2)
})()