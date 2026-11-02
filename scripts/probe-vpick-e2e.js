/* 端到端：切到 selftest profile → 安装插件 → 输入 dsh-context → 选版本 → 点一个旧版本
   → 确认弹窗 → 点「安装」→ 看结果。全程走真实 UI 点击。 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim() : '')
  const byText = (needle, sel) =>
    Array.from(document.querySelectorAll(sel || 'button')).find((b) => txt(b) === needle || txt(b).startsWith(needle))

  return (async () => {
    const log = []

    // 1) 刷新 profile 列表，切到 selftest
    const refresh = byText('刷新', '.subbar button') || byText('刷新')
    if (refresh) refresh.click()
    await sleep(1500)

    const profBtn = Array.from(document.querySelectorAll('.pcard, .profile, .sidebar button, aside button'))
      .find((b) => /dsh-console-selftest/.test(txt(b)))
    if (!profBtn) return { stage: 'profile', error: '侧栏里没找到 selftest profile', log }
    profBtn.click()
    await sleep(2000)
    log.push('已切到 selftest')

    // 2) 安装插件 → 智能输入
    const t1 = byText('安装插件')
    if (t1) t1.click()
    await sleep(600)
    const t2 = byText('智能输入')
    if (t2) t2.click()
    await sleep(400)

    const input = document.querySelector('.install__pane input.input')
    if (!input) return { stage: 'input', error: '没找到输入框', log }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'dsh-context')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(2600)
    log.push('预检完成')

    // 3) 选版本
    const pickBtn = Array.from(document.querySelectorAll('.install__pane button')).find((b) => txt(b) === '选版本')
    if (pickBtn) pickBtn.click()
    await sleep(3000)

    const panel = document.querySelector('.install__picker')
    if (!panel) return { stage: 'picker', error: '版本面板没开', log }
    for (let i = 0; i < 15 && panel.querySelectorAll('[role="option"]').length === 0; i++) await sleep(600)

    const rows = Array.from(panel.querySelectorAll('[role="option"]'))
    // 优先挑明确标着「降级」的；空 profile 里没有已装版本、方向全是 null，这时退而取第 4 行
    const downRows = rows.filter((r) => /降级/.test(txt(r)))
    const versionRows = rows.filter((r) => !/^(latest|标签|分支)/.test(txt(r)))
    const target = downRows[2] || downRows[0] || versionRows[1] || rows[0]
    if (!target) return { stage: 'rows', error: '版本面板里没有任何行', log }
    const targetText = txt(target)
    target.click()
    await sleep(1200)
    log.push('点了版本行：' + targetText.replace(/\n/g, ' '))

    // 4) 确认弹窗
    const dlg = document.querySelector('.overlay--confirm .dialog, .overlay--confirm')
    const dlgText = txt(dlg)
    if (!dlgText) return { stage: 'confirm', error: '确认弹窗没出现', log, targetText }

    // 点弹窗里的主按钮
    const okBtn = Array.from((dlg || document).querySelectorAll('button')).find(
      (b) => txt(b) === '安装' || txt(b) === '确认' || /^确认/.test(txt(b))
    )
    if (!okBtn) return { stage: 'confirmbtn', error: '弹窗里没有确认按钮', log, dlgText: dlgText.slice(0, 300) }
    okBtn.click()
    log.push('已确认安装')

    // 5) 等操作结束（最多 90s）
    let done = false
    for (let i = 0; i < 60; i++) {
      await sleep(1500)
      const busyNow = !!document.querySelector('.spinner')
      const running = Array.from(document.querySelectorAll('*')).some((e) => /正在执行|安装中/.test(txt(e)) && e.children.length === 0)
      if (!busyNow && !running) { done = true; break }
    }

    // 6) 结果
    const logDrawer = document.querySelector('.logdrawer')
    const tail = txt(logDrawer).split('\n').slice(-14).join('\n')

    return {
      stage: 'done',
      done,
      targetText: targetText.replace(/\n/g, ' '),
      confirmDialog: dlgText.slice(0, 420),
      logTail: tail,
      log
    }
  })()
})()
