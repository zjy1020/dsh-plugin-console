(async () => {
  /* ============================================================
   * DSH 插件台 bug A / bug B 复验探针（一次跑完，自带还原）
   *
   * 跑法（应用需带 --remote-debugging-port=9333 跑着）：
   *   $node = "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
   *   & $node "<root>\scripts\cdp-eval.mjs" --file "$env:TEMP\dsh-verify-ab.js"
   *
   * 设计要点（为什么这么写）：
   *  - 判定一律读 DOM：fiber 里取到的 context value 是某次提交的渲染快照，
   *    React 提交与消息顺序不保证同步，实测出现过「DOM 已经变了、fiber 还显示旧值」，
   *    拿它当判据会报假故障。fiber 只用来取 actions（dispatch 是稳定引用）。
   *  - 等待用 MessageChannel 让出事件循环，不用 setTimeout / requestAnimationFrame：
   *    窗口最小化时 Chromium 会把定时器节流（实测 setTimeout(500) 实际 1144ms，
   *    最小化时 300ms 能拖到 6s），靠定时器等待的探针会假死。
   *  - 每一步都留快照，最后 try/finally 把界面还原到 baseline。
   * ============================================================ */

  /* --- 无定时器的等待原语 --- */
  const yieldOnce = () =>
    new Promise((r) => {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => {
        ch.port1.close()
        r(null)
      }
      ch.port2.postMessage(0)
    })
  const settle = async (n = 8) => {
    for (let i = 0; i < n; i += 1) await yieldOnce()
  }
  const waitUntil = async (pred, timeoutMs = 90000, stepMs = 120) => {
    const t0 = performance.now()
    let lastCheck = -1e9
    for (;;) {
      const now = performance.now()
      if (now - lastCheck >= stepMs) {
        lastCheck = now
        try {
          if (pred()) return { ok: true, ms: Math.round(now - t0) }
        } catch (_) {}
      }
      if (now - t0 > timeoutMs) return { ok: false, ms: Math.round(now - t0) }
      await yieldOnce()
    }
  }

  /* --- 错误采集（跨调用持久，只挂一次） --- */
  if (!globalThis.__dsErrHook) {
    const errs = []
    globalThis.__dsErrs = errs
    globalThis.__dsErrHook = true
    window.addEventListener('error', (e) => errs.push('error: ' + (e.message || e.type)))
    window.addEventListener('unhandledrejection', (e) =>
      errs.push('rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)))
    )
    const ce = console.error.bind(console)
    console.error = (...a) => {
      errs.push('console.error: ' + a.map((x) => (x && x.message) || String(x)).join(' '))
      ce(...a)
    }
  }
  const errs = globalThis.__dsErrs
  const errMark = errs.length
  const since = () => errs.slice(errMark)

  /* --- DOM 读法 --- */
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.from(document.querySelectorAll(s))
  const hasLogs = () => {
    const b = $('.app__body')
    return b ? b.classList.contains('has-logs') : null
  }
  const drawerOpen = () => !!$('.logdrawer')
  const bodyH = () => {
    const b = $('.app__body')
    return b ? Math.round(b.getBoundingClientRect().height) : -1
  }
  const activeNav = () =>
    $$('.sb__item[aria-current="page"]').map((e) => e.textContent.replace(/\s+/g, ' ').trim())
  const sliderId = () => {
    const s = $('.gl-slider')
    if (!s) return null
    const top = s.getBoundingClientRect().top
    let best = null
    let bestD = Infinity
    for (const el of $$('.sb__item')) {
      const d = Math.abs(el.getBoundingClientRect().top - top)
      if (d < bestD) {
        bestD = d
        best = el
      }
    }
    return best ? best.textContent.replace(/\s+/g, ' ').trim() : null
  }
  const navItem = (t) => $$('.sb__item').find((e) => e.textContent.includes(t)) || null
  const tabBtn = (t) => $$('.subbar__tab').find((e) => e.textContent.includes(t)) || null

  /* 结论是否还活着，全部用 DOM 看：
   * .prow__latest 渲染 → 可更新 / = 版本 / 检查失败 / —（没有结论）
   * 所以「非 — 的行数」= 还带着结论的行数，「.is-updatable」= 可更新行数。 */
  const rowFresh = () =>
    $$('.prow__latest').filter((e) => {
      const t = e.textContent.trim()
      return t !== '' && t !== '—'
    }).length
  const rowTotal = () => $$('.prow__latest').length
  const rowUpdatable = () => $$('.prow__latest.is-updatable').length
  const updBadge = () => {
    const b = $('.subbar__meta .badge--accent')
    return b ? b.textContent.trim() : null
  }
  const checkbar = () => ($('.checkbar') ? $('.checkbar').textContent.replace(/\s+/g, ' ').trim() : null)
  const detailHead = () => {
    const d = $('.detail')
    return d ? d.textContent.replace(/\s+/g, ' ').trim().slice(0, 48) : null
  }

  /* --- fiber 只为拿 actions --- */
  const getCtx = () => {
    const el = document.getElementById('root')
    if (!el) return null
    const key = Object.keys(el).find((k) => k.startsWith('__reactContainer$'))
    if (!key) return null
    const host = el[key]
    const root = host && host.current ? host.current : host
    const queue = [root]
    const seen = new Set()
    while (queue.length) {
      const f = queue.shift()
      if (!f || seen.has(f)) continue
      seen.add(f)
      const v = f.memoizedProps && f.memoizedProps.value
      if (v && v.actions && v.state && v.counts) return v
      if (f.child) queue.push(f.child)
      if (f.sibling) queue.push(f.sibling)
    }
    return null
  }
  const stateLite = () => {
    const c = getCtx()
    if (!c) return null
    return {
      updates: Object.keys(c.state.updates || {}).length,
      plugins: c.state.plugins.length,
      withCheckedAt: c.state.plugins.filter((p) => p.checkedAt !== null).length,
      checkRunning: c.state.check ? c.state.check.running : null,
      logsOpen: c.state.logsOpen,
      filter: c.state.filter,
      view: c.state.view,
      selectedId: c.state.selectedId
    }
  }

  const out = { role: 'ds-verify-ab', at: new Date().toISOString(), hidden: document.hidden, A: {}, B: {}, errors: [], notes: [] }
  const ctx = getCtx()
  if (!ctx) {
    out.notes.push('拿不到 ConsoleContext（fiber 里找不到 actions+state+counts）—— 无法动作')
    return out
  }
  const bSnap = () => ({
    rowsTotal: rowTotal(),
    rowsWithConclusion: rowFresh(),
    rowsUpdatable: rowUpdatable(),
    subbarBadge: updBadge(),
    checkbar: checkbar(),
    state: stateLite()
  })
  const restore = async () => {
    try { ctx.actions.closeSettings() } catch (e) { out.notes.push('restore closeSettings: ' + e.message) }
    try { ctx.actions.closeLogs() } catch (e) { out.notes.push('restore closeLogs: ' + e.message) }
    try { ctx.actions.setView('plugins') } catch (e) { out.notes.push('restore setView: ' + e.message) }
    try { ctx.actions.setFilter('all') } catch (e) { out.notes.push('restore setFilter: ' + e.message) }
    try { ctx.actions.select(null) } catch (e) { out.notes.push('restore select: ' + e.message) }
    await settle(10)
  }

  try {
    /* ================= bug A：日志抽屉 ================= */
    await restore()
    out.A.baseline = { hasLogs: hasLogs(), drawer: drawerOpen(), bodyH: bodyH(), active: activeNav(), slider: sliderId() }

    /* A1 打开 */
    const logItem = navItem('运行日志')
    if (!logItem) out.notes.push('侧栏没有「运行日志」项')
    else {
      logItem.click()
      await settle(10)
      out.A.opened = { hasLogs: hasLogs(), drawer: drawerOpen(), bodyH: bodyH(), active: activeNav(), slider: sliderId() }

      /* A2 侧栏再点一次：期望关掉（修好前这里是哑炮） */
      navItem('运行日志').click()
      await settle(10)
      out.A.toggledAgain = { hasLogs: hasLogs(), drawer: drawerOpen(), active: activeNav(), slider: sliderId() }

      /* A3 抽屉开着 → ✕ 关闭：期望关上，且不动插件选中态 */
      await restore()
      const pid0 = (ctx.visible && ctx.visible[0] && ctx.visible[0].id) || (ctx.state.plugins[0] && ctx.state.plugins[0].id) || null
      if (pid0) { ctx.actions.select(pid0); await settle(12) }
      navItem('运行日志').click()
      await settle(10)
      const beforeX = { hasLogs: hasLogs(), detail: detailHead() }
      const x = $('[aria-label="关闭日志"]')
      if (x) { x.click(); await settle(10) } else out.notes.push('找不到 ✕ 按钮 [aria-label="关闭日志"]')
      out.A.closeButton = {
        beforeX,
        afterX: { hasLogs: hasLogs(), drawer: drawerOpen(), detail: detailHead(), active: activeNav() }
      }
    }

    /* A4 抽屉开着时点别的导航项：期望切过去 + 抽屉自动关 + 高亮与滑块都跟着走 */
    await restore()
    navItem('运行日志') && navItem('运行日志').click()
    await settle(10)
    const filterItem = navItem('已停用')
    if (filterItem) {
      const beforeSwitch = { hasLogs: hasLogs(), active: activeNav(), slider: sliderId() }
      filterItem.click()
      await settle(10)
      out.A.navSwitch = {
        beforeSwitch,
        after: { hasLogs: hasLogs(), drawer: drawerOpen(), active: activeNav(), slider: sliderId() }
      }
    } else out.notes.push('侧栏没有「已停用」筛选项')

    /* A5 抽屉开着时切 subbar 视图 */
    await restore()
    navItem('运行日志') && navItem('运行日志').click()
    await settle(10)
    const installTab = tabBtn('安装插件')
    if (installTab) {
      installTab.click()
      await settle(10)
      out.A.viewSwitch = {
        hasLogs: hasLogs(),
        drawer: drawerOpen(),
        tabSelected: installTab.getAttribute('aria-selected'),
        active: activeNav()
      }
      const backTab = tabBtn('已安装')
      if (backTab) { backTab.click(); await settle(10) }
    } else out.notes.push('subbar 没有「安装插件」tab')

    await restore()
    out.A.verdict = {
      opens: out.A.opened ? out.A.opened.hasLogs === true && out.A.opened.drawer === true : null,
      secondClickCloses: out.A.toggledAgain
        ? out.A.toggledAgain.hasLogs === false && out.A.toggledAgain.drawer === false
        : null,
      closeButtonKeepsSelection: out.A.closeButton
        ? out.A.closeButton.afterX.hasLogs === false &&
          out.A.closeButton.afterX.drawer === false &&
          out.A.closeButton.afterX.detail === out.A.closeButton.beforeX.detail
        : null,
      navSwitchClosesAndMoves: out.A.navSwitch
        ? out.A.navSwitch.after.hasLogs === false &&
          out.A.navSwitch.after.drawer === false &&
          out.A.navSwitch.after.active.length === 1 &&
          out.A.navSwitch.after.active[0].includes('已停用') &&
          (out.A.navSwitch.after.slider || '').includes('已停用')
        : null,
      viewSwitchCloses: out.A.viewSwitch ? out.A.viewSwitch.hasLogs === false && out.A.viewSwitch.drawer === false : null
    }

    /* ================= bug B：刷新不丢检查结论 ================= */
    await restore()
    out.B.before = bSnap()

    if (!out.B.before.state || out.B.before.state.withCheckedAt === 0) {
      out.notes.push('此刻没有检查结论 → 先跑一次 checkUpdates 并等它落地')
      const t0 = Date.now()
      await Promise.resolve(ctx.actions.checkUpdates())
      const w = await waitUntil(() => {
        const s = stateLite()
        return !!s && s.withCheckedAt > 0 && s.checkRunning === false && rowFresh() > 0
      }, 120000)
      out.B.checkWait = { ok: w.ok, ms: w.ms, wallMs: Date.now() - t0 }
      if (!w.ok) out.notes.push('等检查结果超时（结论可能还没生成或注册表太慢）')
    }
    await settle(10)
    out.B.checked = bSnap()

    await Promise.resolve(ctx.actions.reloadAll())
    await settle(12)
    await waitUntil(() => rowTotal() > 0 && (() => { const s = stateLite(); return !!s && s.plugins > 0 })(), 30000, 200)
    await settle(12)
    out.B.afterReload = bSnap()

    const c = out.B.checked
    const r = out.B.afterReload
    out.B.verdict = {
      withConclusionBefore: c.rowsWithConclusion,
      withConclusionAfter: r.rowsWithConclusion,
      updatableBefore: c.rowsUpdatable,
      updatableAfter: r.rowsUpdatable,
      /* 主判据（纯 DOM） */
      domKept: c.rowsWithConclusion > 0 && r.rowsWithConclusion === c.rowsWithConclusion && r.rowsUpdatable === c.rowsUpdatable && c.subbarBadge === r.subbarBadge,
      /* 副判据（fiber 快照，仅作诊断） */
      stateKept: !!c.state && !!r.state && c.state.updates > 0 && r.state.updates === c.state.updates,
      checkedAtKept: !!c.state && !!r.state && c.state.withCheckedAt > 0 && r.state.withCheckedAt === c.state.withCheckedAt,
      listStillLoaded: r.rowsTotal > 0
    }

    await restore()
    out.finalState = stateLite()
  } catch (e) {
    out.notes.push('探针中途抛错: ' + (e && e.stack ? e.stack : String(e)))
    try { await restore() } catch (_) {}
    out.finalState = stateLite()
  }

  out.errors = since()
  return out
})()
