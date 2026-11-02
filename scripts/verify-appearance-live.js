/*
 * verify-appearance-live.js —— 验收「外观改一下就生效」+「还原外观」。
 *
 * 判定标准写死三条，缺一条不算通过：
 *   1. 点「浅色 / 深色」之后，**一次都没点保存**，主进程 settings 与根上算出来的
 *      CSS 变量（--bg-0 / data-theme）就已经变了 —— 这才是「实时预览」。
 *   2. 拖宽度滑杆之后，settings.sidebarWidth 与 --sb-w-expanded 一起变。
 *   3. 点「还原外观」并确认之后，外观字段回到出厂默认，且界面立刻跟着回。
 *
 * 跑之前会 snapshot 一份 settings，跑完用 settingsSet 原样写回 ——
 * 因为这些是用户真实在用的配置，验收脚本不许改变他的样子。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/verify-appearance-live.js
 */
;(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const root = document.documentElement
  const cs = (prop) => getComputedStyle(root).getPropertyValue(prop).trim()
  const txt = (el) => (el ? (el.textContent || '').trim() : null)
  const fail = []
  const note = (ok, name, extra) => {
    if (!ok) fail.push(name)
    return { ok, name, ...(extra || {}) }
  }

  /** 按可见文案找 dialog 里的按钮（强类型无关，改样式不会把这脚本弄死） */
  const btn = (want) =>
    [...document.querySelectorAll('.dialog button')].find((b) => (txt(b) || '') === want) ||
    [...document.querySelectorAll('.dialog button')].find((b) => (txt(b) || '').includes(want))

  /** 分段控件的某一档：优先认 .apseg__opt，认不到就退回按文案找按钮 */
  const seg = (want) =>
    [...document.querySelectorAll('.apseg__opt')].find((b) => (txt(b) || '') === want) || btn(want)

  /** 某个滑杆：按 .aprng__label 找行，取里面的 input[type=range] */
  const range = (labelWord) => {
    for (const row of document.querySelectorAll('.aprng')) {
      if ((row.querySelector('.aprng__label')?.textContent || '').includes(labelWord)) {
        return row.querySelector('input[type="range"]')
      }
    }
    for (const row of document.querySelectorAll('.aprow')) {
      if ((row.textContent || '').includes(labelWord)) {
        const found = row.querySelector('input[type="range"]')
        if (found) return found
      }
    }
    return null
  }

  /** React 在 input 上有值追踪器：直接 el.value = x 会被判成「没变」而不触发 onChange */
  const setRange = (el, value) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    desc.set.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  }

  const before = await window.dsh.settingsGet()
  const snapshot = {
    mode: before.appearanceMode,
    width: before.sidebarWidth,
    accent: before.accent,
    ambient: before.ambient,
    theme: before.activeThemeId,
    material: before.material
  }
  const out = { snapshot, steps: [] }

  /* ── 打开设置 ─────────────────────────────────── */
  const entry =
    [...document.querySelectorAll('.sb__item')].find((i) => (i.textContent || '').includes('环境与设置')) ||
    document.querySelector('.sb__icon-btn[aria-label="设置"]')
  if (!entry) return JSON.stringify({ fatal: '找不到设置入口' })
  entry.click()
  await wait(1200)
  if (!document.querySelector('.dialog')) return JSON.stringify({ fatal: '设置弹窗没打开' })

  /* ── 1. 深浅模式：不点保存就该变 ───────────────── */
  const targetMode = snapshot.mode === 'dark' ? '浅色' : '深色'
  const bg0Before = cs('--bg-0')
  const modeBtn = seg(targetMode)
  if (modeBtn) {
    modeBtn.click()
    await wait(900)
    const s = await window.dsh.settingsGet()
    out.steps.push(
      note(
        s.appearanceMode !== snapshot.mode && root.dataset.theme !== snapshot.mode && cs('--bg-0') !== bg0Before,
        '模式立即生效（不点保存）',
        { targetMode, now: s.appearanceMode, dataTheme: root.dataset.theme, bg0: cs('--bg-0'), bg0Before }
      )
    )
  } else {
    out.steps.push({ ok: false, name: '找不到深浅模式分段控件', probes: [...document.querySelectorAll('.dialog button')].map(txt) })
    fail.push('模式分段控件')
  }

  /* ── 2. 宽度滑杆：拖完立即生效 ─────────────────── */
  const widthInput = range('宽度')
  if (widthInput) {
    const from = widthInput.value
    setRange(widthInput, 300)
    await wait(800)
    const s = await window.dsh.settingsGet()
    out.steps.push(
      note(s.sidebarWidth === 300 && cs('--sb-w-expanded') === '300px', '宽度滑杆立即生效（不点保存）', {
        from,
        settingsW: s.sidebarWidth,
        cssW: cs('--sb-w-expanded')
      })
    )
  } else {
    out.steps.push({ ok: false, name: '找不到宽度滑杆' })
    fail.push('宽度滑杆')
  }

  /* ── 3. 还原外观（两步确认） ───────────────────── */
  const armBtn = btn('还原')
  if (armBtn) {
    armBtn.click()
    await wait(400)
    const confirmBtn = btn('确认还原') || btn('确认')
    const armed = !!confirmBtn && confirmBtn !== armBtn
    if (confirmBtn) confirmBtn.click()
    await wait(1400)
    const s = await window.dsh.settingsGet()
    out.steps.push(
      note(
        armed &&
          s.appearanceMode === 'dark' &&
          s.sidebarWidth === 248 &&
          s.sidebarRadius === 16 &&
          (s.accent || '') === '' &&
          cs('--sb-w-expanded') === '248px',
        '还原外观（含两步确认）',
        {
          armed,
          mode: s.appearanceMode,
          w: s.sidebarWidth,
          radius: s.sidebarRadius,
          accent: s.accent,
          theme: s.activeThemeId,
          cssW: cs('--sb-w-expanded')
        }
      )
    )
  } else {
    out.steps.push({
      ok: false,
      name: '找不到「还原」按钮',
      probes: [...document.querySelectorAll('.dialog button')].map(txt)
    })
    fail.push('还原按钮')
  }

  /* ── 收尾：关弹窗 + 把用户原始设置写回去 ───────── */
  const cancel = btn('取消')
  if (cancel) cancel.click()
  await wait(600)
  const restored = await window.dsh.settingsSet(before)
  await wait(400)

  out.restored = {
    mode: restored.appearanceMode,
    w: restored.sidebarWidth,
    accent: restored.accent,
    theme: restored.activeThemeId
  }
  out.failNames = fail
  out.passCount = out.steps.filter((s) => s.ok).length
  return JSON.stringify(out, null, 1)
})()