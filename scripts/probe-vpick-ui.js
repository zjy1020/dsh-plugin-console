/* 版本面板 UI 冒烟：切到「安装插件」→ 智能输入 → 填包名 → 点「选版本」→ dump 面板内容 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim() : '')

  const clickText = (root, needle, sel) => {
    const nodes = Array.from((root || document).querySelectorAll(sel || 'button'))
    const hit = nodes.find((b) => txt(b).startsWith(needle) || txt(b) === needle)
    if (hit) hit.click()
    return !!hit
  }

  return (async () => {
    // 1) 切到「安装插件」tab
    const tab = Array.from(document.querySelectorAll('.subbar button, .subbar [role="tab"], button')).find((b) =>
      txt(b).startsWith('安装插件')
    )
    if (tab) tab.click()
    await sleep(500)

    // 2) 找到「智能输入」子 tab（默认就是它）
    const sub = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) => txt(b).startsWith('智能输入'))
    if (sub) sub.click()
    await sleep(300)

    // 3) 填输入框
    const input = document.querySelector('.install__pane input.input')
    if (!input) return { stage: 'input', error: '找不到安装输入框' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'https://github.com/dsh-market/dsh-market')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(3000)

    const preview = txt(document.querySelector('.install__preview'))

    // 4) 点「选版本」
    const opened = clickText(document.querySelector('.install__pane'), '选版本')
    await sleep(4000)

    const panel = document.querySelector('.install__picker .vpick, .install__picker')
    const groups = Array.from(document.querySelectorAll('.install__picker [class*="group"], .install__picker .vpick__group')).map(txt)
    const rows = Array.from(document.querySelectorAll('.install__picker [role="option"]'))
      .slice(0, 6)
      .map(txt)
    const foot = txt(document.querySelector('.install__picker [class*="exec"], .install__picker [class*="foot"]'))

    return {
      tabOk: !!tab,
      opened,
      preview: preview.slice(0, 260),
      panelHtmlLen: panel ? panel.innerHTML.length : 0,
      groups,
      rows,
      foot,
      optionCount: document.querySelectorAll('.install__picker [role="option"]').length,
      listbox: !!document.querySelector('.install__picker [role="listbox"]')
    }
  })()
})()
