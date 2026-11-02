/*
 * 复验脚本：设置面板里点壁纸缩略图 = 立即生效（不再需要点保存）
 * 用法（重启后跑，一次跑完全部断言并还原）：
 *   $root = "D:\项目\DSH\deepseekharness插件台"
 *   $node = "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
 *   & $node "$root\scripts\cdp-eval.mjs" --file "$env:TEMP\dsh-verify-wallpaper-immediate.js"
 *
 * 做的事：读原壁纸 → 不够就自己打开设置 → 点一张「非当前」的 .apwall__cell → 等 1200ms
 *        → 断言 ①背景 src 换了 ②settingsGet().wallpaper.id 是新的 ③is-on 指向同一张
 *          ④亮度读数 = 新 wallpaperAdjust.brightness ⑤没有「保存/已刷新」类 toast
 *          ⑥还原后背景回到原壁纸
 *        → 最后点回原来那张、关掉自己开的弹窗。
 * verdict = PASS 才算过；每条失败项带 hint 说明该去查哪里。
 */
(async () => {
  const d = window.dsh
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const txt = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim()
  const checks = []
  const add = (name, ok, detail, hint) => checks.push({ name: name, ok: !!ok, detail: detail, hint: ok ? null : hint })
  const out = { verdict: null, checks: checks, info: {} }
  const srcOf = () => q('.wp-layer img').map((i) => i.getAttribute('src'))
  const cellByName = (name) => q('.apwall__cell').find((c) => txt(c.querySelector('.apwall__cellname')) === name)
  const brightRow = () => q('.aprng').find((r) => txt(r.querySelector('.aprng__label')) === '亮度')
  const toastTexts = () => q('.toast').map(txt)

  const s0 = await d.settingsGet()
  const origId = s0.wallpaper ? s0.wallpaper.id : null
  const list = await d.wallpaperList()
  out.info.origWallpaperId = origId
  out.info.origBrightness = s0.wallpaperAdjust.brightness
  out.info.origAccent = s0.accent
  out.info.origMode = s0.appearanceMode
  out.info.library = list.map((w) => ({ id: w.id, name: w.name, addedAt: w.addedAt, hasPath: !!w.path }))
  const target = list.find((w) => w.id !== origId && w.path)
  if (!target) { out.error = '壁纸库里没有「第二张可用的图」，测不了（至少要有两张且不是同一张）'; return out }
  const origEntry = list.find((w) => w.id === origId) || null

  let opened = false
  if (!document.querySelector('.dialog--settings')) {
    const gear = document.querySelector('button[aria-label="设置"]')
    if (!gear) { out.error = '找不到设置入口 button[aria-label="设置"]'; return out }
    gear.click(); opened = true; await sleep(700)
  }
  out.info.dialogOpenedByScript = opened

  try {
    const toastBefore = toastTexts()
    const srcBefore = srcOf()
    const brBefore = txt(brightRow() && brightRow().querySelector('.aprng__val'))
    const cell = cellByName(target.name)
    if (!cell) { out.error = '壁纸库里找不到「' + target.name + '」的缩略图'; return out }
    add('前置：目标缩略图可用且未被禁用', !cell.disabled, { name: target.name, disabled: cell.disabled }, '等上一步 busy 结束后再跑')
    cell.click()
    await sleep(1200)

    const s1 = await d.settingsGet()
    const srcAfter = srcOf()
    add('①背景图 .wp-layer img 的 src 真的换了（且指向新那张）',
      JSON.stringify(srcBefore) !== JSON.stringify(srcAfter) && srcAfter.some((s) => s && s.indexOf('v=' + target.addedAt) >= 0),
      { before: srcBefore, after: srcAfter, expectV: target.addedAt },
      'doSet 里是不是漏了 reloadAll({silent:true})：主进程换了但没 dispatch，WallpaperLayer 读不到新 settings')

    add('②settingsGet().wallpaper.id === 点的那张',
      !!(s1.wallpaper && s1.wallpaper.id === target.id),
      { got: s1.wallpaper ? s1.wallpaper.id : null, want: target.id },
      'doSet 有没有真的调 window.dsh.wallpaperSet(id)（而不是只 set 草稿）')

    const onNames = q('.apwall__cell.is-on').map((c) => txt(c.querySelector('.apwall__cellname')))
    add('③.apwall__cell.is-on 唯一且指向同一张', onNames.length === 1 && onNames[0] === target.name,
      { onNames: onNames, want: target.name },
      'is-on 读的是 draft.wallpaper?.id：syncDraft 没把新壁纸搬进草稿')

    const wantBright = Math.round(s1.wallpaperAdjust.brightness * 100) + '%'
    const shownBright = txt(brightRow() && brightRow().querySelector('.aprng__val'))
    add('④亮度滑杆显示值 = 新 wallpaperAdjust.brightness', shownBright === wantBright,
      { shown: shownBright, want: wantBright, before: brBefore,
        brightnessBefore: s0.wallpaperAdjust.brightness, brightnessAfter: s1.wallpaperAdjust.brightness },
      '滑杆读数长在 draft.wallpaperAdjust 上：自动适配改了参数却没回流草稿')

    const after = toastTexts()
    const leftover = toastBefore.slice()
    const newToasts = after.filter((t) => { const i = leftover.indexOf(t); if (i >= 0) { leftover.splice(i, 1); return false } return true })
    const badToast = newToasts.filter((t) => /保存|已刷新|设置已/.test(t))
    add('⑤没有冒出「保存 / 已刷新」这类 toast', badToast.length === 0, { newToasts: newToasts, bad: badToast },
      'reloadAll 的 silent 没传 true，或者保存路径被误触发')

    const note = txt(document.querySelector('.apnote'))
    add('附：note 说立即生效、不再提「点保存」',
      note.indexOf('立即生效') >= 0 && note.indexOf('才会换上') < 0 && note.indexOf(target.name) >= 0,
      { note: note }, 'note 文案还是旧的草稿态说法')

    out.info.after = {
      wallpaperId: s1.wallpaper ? s1.wallpaper.id : null,
      brightness: s1.wallpaperAdjust.brightness,
      maskDark: s1.wallpaperAdjust.maskDark,
      maskLight: s1.wallpaperAdjust.maskLight,
      accent: s1.accent,
      appearanceMode: s1.appearanceMode,
      sidebarOpacity: s1.sidebarOpacity,
      sidebarBlur: s1.sidebarBlur,
      accentChangedByFit: s1.accent !== s0.accent,
      maskChangedByFit: s1.wallpaperAdjust.maskDark !== s0.wallpaperAdjust.maskDark || s1.wallpaperAdjust.maskLight !== s0.wallpaperAdjust.maskLight
    }
  } finally {
    // 还原：点回原来那张；本来没壁纸就走「移除」（那不是「取消选择」，按钮文案是「移除」）
    try {
      if (origId && origEntry) {
        const back = cellByName(origEntry.name)
        if (back) { back.click(); await sleep(1200) }
      } else {
        const rm = q('.aprow__side button').find((b) => txt(b) === '移除')
        if (rm) { rm.click(); await sleep(1200) }
      }
      const s2 = await d.settingsGet()
      out.info.restoredWallpaperId = s2.wallpaper ? s2.wallpaper.id : null
      out.info.restoredSrc = srcOf()
      add('⑥还原：设置和背景都回到原壁纸', out.info.restoredWallpaperId === origId,
        { restoredId: out.info.restoredWallpaperId, want: origId, src: out.info.restoredSrc },
        '手动点回原来那张，或 window.dsh.wallpaperSet("' + origId + '")')
    } catch (e) { out.info.restoreError = String(e) }
    if (opened) {
      const cancel = q('button').find((b) => txt(b) === '取消')
      if (cancel) { cancel.click(); await sleep(400) }
      out.info.dialogClosedAgain = !document.querySelector('.dialog--settings')
    }
  }

  out.info.passCount = checks.filter((c) => c.ok).length
  out.info.failNames = checks.filter((c) => !c.ok).map((c) => c.name)
  out.verdict = out.info.failNames.length === 0 ? 'PASS' : 'FAIL'
  return out
})()