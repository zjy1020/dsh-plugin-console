/**
 * probe-installsroot-adopt.js —— 验证「用户手填的安装根不再被结构校验否决」。
 *
 * 背景（Master 在新电脑上实测报错，m07798/m07801）：
 *   他在设置里填了 D:\deepseek-harness，那个目录结构不标准（没有
 *   resources/app/package.json）→ 旧逻辑把它当无效候选丢掉 → installRoot=null
 *   → 启动 DSH 报「<安装目录未知>」。用户指了路，程序不认。
 *
 * 修复后的语义：
 *   「设置」候选免结构校验 —— 目录存在即采纳（启动/退出 DSH 只需要在里面找到 exe）；
 *   目录不存在才拒绝（那是打错了字）；其余路由（注册表/快捷方式/磁盘扫描）照旧过结构校验。
 *
 * 本探针在真实运行实例里跑三个场景：
 *   1) 填一个存在但结构不标准的目录（D:\dsh-fakeroot，绿色版形态，顶层有 exe）
 *      → 必须被采纳；warnings 说「结构不标准」而不是「无效」；exePath 必须扫到假 exe
 *   2) 填一个不存在的目录（D:\__nope__）→ 必须被拒绝；探测路由兜底找真的；warning 说「目录不存在」
 *   3) 清空 → 恢复健康态
 *   4) pickDshExe 通道存在 + 设置对话框里「选程序文件…」按钮渲染且可点
 */
;(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const d = window.dsh
  const out = { fail: [] }
  const check = (name, cond, detail) => {
    out[name] = detail
    if (!cond) out.fail.push(name)
  }

  const snapshot = async () => {
    const info = await d.runtimeInfo()
    const st = await d.dshStatus()
    return {
      installRoot: info.installRoot,
      installRootFrom: info.installRootFrom,
      warnings: info.warnings,
      exePath: st.exePath ?? null,
      runtimeSource: info.runtimeSource
    }
  }

  // 场景 0：记下初始值，探针结束时还原
  const before = await snapshot()
  out.before = before

  // ── 场景 1：存在但结构不标准（Master 的情形）──
  await d.settingsSet({ installRoot: 'D:\\dsh-fakeroot' })
  await wait(1600)
  const s1 = await snapshot()
  out.s1_greenRoot = s1
  check('s1_adopted', s1.installRoot === 'D:\\dsh-fakeroot', s1.installRoot)
  check(
    's1_from_settings',
    s1.installRootFrom === '设置',
    s1.installRootFrom
  )
  check(
    's1_warn_is_note_not_invalid',
    (s1.warnings ?? []).some((w) => w.includes('已按设置里的目录用上')) &&
      !(s1.warnings ?? []).some((w) => w.includes('设置里的安装根无效')),
    s1.warnings
  )
  check(
    's1_exe_found',
    (s1.exePath ?? '').toLowerCase() === 'd:\\dsh-fakeroot\\deepseek harness.exe',
    s1.exePath
  )

  // ── 场景 2：目录不存在（打错字）→ 拒绝 + 探测兜底 ──
  await d.settingsSet({ installRoot: 'D:\\__nope__' })
  await wait(1600)
  const s2 = await snapshot()
  out.s2_missingDir = { ...s2 }
  check(
    's2_not_adopted',
    s2.installRoot !== 'D:\\__nope__',
    s2.installRoot
  )
  check(
    's2_warn_says_not_exist',
    (s2.warnings ?? []).some((w) => w.includes('设置里的安装根目录不存在')),
    s2.warnings
  )

  // ── 场景 3：清空 → 健康态（自动探测回到真根）──
  await d.settingsSet({ installRoot: '' })
  await wait(1600)
  const s3 = await snapshot()
  out.s3_restored = { installRoot: s3.installRoot, from: s3.installRootFrom, runtimeSource: s3.runtimeSource }
  check('s3_healthy', !!s3.installRoot && s3.installRoot !== 'D:\\__nope__', s3.installRoot)

  // ── 场景 4：pickDshExe 通道 + 设置里的按钮 ──
  check('s4_channel', typeof d.pickDshExe === 'function', typeof d.pickDshExe)
  // 打开设置：侧栏收起时按钮只剩图标（aria-label="设置"），展开时是「环境与设置」那一项
  // （不真点「选程序文件…」—— 系统对话框会阻塞等人工输入）
  const settingsBtn =
    [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '环境与设置') ??
    [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === '设置' || b.getAttribute('title') === '设置'
    )
  if (settingsBtn) settingsBtn.click()
  await wait(900)
  const dialog = document.querySelector('.dialog')
  const btns = dialog ? [...dialog.querySelectorAll('button')] : []
  const pickBtn = btns.find((b) => (b.textContent ?? '').includes('选程序文件'))
  out.s4_button = pickBtn
    ? { text: pickBtn.textContent, disabled: pickBtn.disabled, title: pickBtn.title }
    : null
  check('s4_button_present', !!pickBtn, pickBtn ? pickBtn.textContent : '未找到')
  check('s4_button_enabled', !!pickBtn && !pickBtn.disabled, pickBtn ? !pickBtn.disabled : false)
  // 关掉设置
  const closeBtn = btns.find((b) => (b.getAttribute('aria-label') ?? '').includes('关闭'))
  if (closeBtn) closeBtn.click()
  await wait(300)

  // 还原设置（场景 3 已清空 installRoot；若初始有值则写回）
  if (before.installRoot) await d.settingsSet({ installRoot: before.installRoot })

  out.pass = out.fail.length === 0
  return out
})()
