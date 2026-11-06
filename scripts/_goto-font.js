(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const nav = [...document.querySelectorAll('button')].find((b) => /DSH 字体/.test(b.textContent || ''))
  if (!nav) return { ok: false, why: '没找到侧栏的「DSH 字体」入口' }
  nav.click()
  await sleep(1500)
  const trigger = document.querySelector('.fpick__trigger')
  if (trigger) {
    trigger.click()
    await sleep(600)
  }
  return {
    ok: true,
    view: document.querySelector('.app__view')?.firstElementChild?.className,
    items: document.querySelectorAll('.fpick__item').length,
    count: document.querySelector('.fpick__count')?.textContent,
  }
})()
