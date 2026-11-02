/* 详情面板的「换版本」：点第一行插件 → 点「换版本」→ 截图 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim() : '')
  return (async () => {
    // 回 desktop profile
    const prof = Array.from(document.querySelectorAll('aside button, .sidebar button')).find((b) => txt(b).startsWith('desktop'))
    if (prof) prof.click()
    await sleep(1800)

    const tab = Array.from(document.querySelectorAll('.subbar button, button')).find((b) => txt(b).startsWith('已安装'))
    if (tab) tab.click()
    await sleep(1200)

    const rows = Array.from(document.querySelectorAll('.prow'))
    const target = rows.find((r) => /dsh-context/.test(txt(r))) || rows[0]
    if (!target) return { error: '没有插件行' }
    target.click()
    await sleep(1200)

    const btn = Array.from(document.querySelectorAll('.detail__actions button')).find((b) => txt(b) === '换版本')
    if (!btn) return { error: '详情里没有换版本按钮', actions: Array.from(document.querySelectorAll('.detail__actions button')).map(txt) }
    btn.click()
    await sleep(3500)

    const panel = document.querySelector('.detail__picker')
    if (!panel) return { error: '详情版本面板没开' }
    for (let i = 0; i < 15 && panel.querySelectorAll('[role="option"]').length === 0; i++) await sleep(600)
    return {
      opened: true,
      head: txt(panel).split('\n')[0],
      options: panel.querySelectorAll('[role="option"]').length,
      firstRows: Array.from(panel.querySelectorAll('[role="option"]')).slice(0, 4).map((r) => txt(r).replace(/\n/g, ' ')),
      exec: (Array.from(panel.querySelectorAll('*')).filter((e) => /^pnpm add /.test(txt(e)) && e.children.length === 0).map(txt)[0]) || ''
    }
  })()
})()
