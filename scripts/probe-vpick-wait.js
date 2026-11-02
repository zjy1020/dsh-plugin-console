/* 版本面板：等待加载完再 dump（git ls-remote 可能要 5s+） */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim() : '')
  return (async () => {
    const panel = document.querySelector('.install__picker')
    if (!panel) return { error: '面板不在（上一轮的 选版本 可能被关掉了）' }
    for (let i = 0; i < 20; i++) {
      const n = panel.querySelectorAll('[role="option"]').length
      const loading = /正在读取版本列表/.test(txt(panel))
      if (n > 0 || (!loading && i > 3)) break
      await sleep(700)
    }
    const rows = Array.from(panel.querySelectorAll('[role="option"]')).slice(0, 8).map(txt)
    const all = Array.from(panel.querySelectorAll('*'))
    const groupTitles = all
      .filter((e) => e.children.length === 0 && /^(标签|版本|分支)$/.test(txt(e)))
      .map(txt)
    const exec = all.filter((e) => /pnpm add/.test(txt(e)) && e.children.length === 0).map(txt)[0] || ''
    const trunc = all.filter((e) => /只显示前/.test(txt(e)) && e.children.length === 0).map(txt)[0] || ''
    return {
      total: panel.querySelectorAll('[role="option"]').length,
      listbox: !!panel.querySelector('[role="listbox"]'),
      groups: groupTitles,
      rows,
      exec,
      trunc,
      panelText: txt(panel).slice(0, 400)
    }
  })()
})()
