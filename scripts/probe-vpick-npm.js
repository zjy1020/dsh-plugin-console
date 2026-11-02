/* 换成 npm 包名，看方向徽章（升级/降级/当前） */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim() : '')
  return (async () => {
    const input = document.querySelector('.install__pane input.input')
    if (!input) return { error: '找不到输入框' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'dsh-context')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(2500)

    // 面板已经在开着的状态？没开就点一次
    if (!document.querySelector('.install__picker')) {
      const btn = Array.from(document.querySelectorAll('.install__pane button')).find((b) => txt(b) === '选版本')
      if (btn) btn.click()
    }
    await sleep(3500)

    const panel = document.querySelector('.install__picker')
    if (!panel) return { error: '面板没打开' }
    for (let i = 0; i < 15 && panel.querySelectorAll('[role="option"]').length === 0; i++) await sleep(600)

    const rows = Array.from(panel.querySelectorAll('[role="option"]'))
    const head = txt(panel).split('\n')[0]
    const sample = rows.slice(0, 5).map((r) => txt(r))
    const badges = {}
    rows.slice(0, 40).forEach((r) => {
      const b = Array.from(r.querySelectorAll('*')).filter((e) => e.children.length === 0 && /^(升级|降级|当前)$/.test(txt(e)))
      b.forEach((e) => { badges[txt(e)] = (badges[txt(e)] || 0) + 1 })
    })
    const last = rows.length ? txt(rows[rows.length - 1]) : ''
    const exec = Array.from(panel.querySelectorAll('*')).filter((e) => /^pnpm add /.test(txt(e)) && e.children.length === 0).map(txt)[0] || ''
    return { head, total: rows.length, sample, badges, last, exec }
  })()
})()
