/*
 * verify-env-discovery.js —— 环境探测与「找不到 DSH」出路的实机验收探针。
 *
 * 用法（必须先有一个带 --remote-debugging-port 的实例在跑）：
 *   node scripts\cdp-eval.mjs --file scripts\verify-env-discovery.js
 *   （换端口：$env:CDP_PORT = 9334）
 *
 * 这个脚本**只读不写**：唯一的写动作是把设置面板打开/关掉、把诊断区展开。
 * 探测类调用（envDiagnose / envRedetect）按契约是幂等的，不会改任何配置。
 *
 * 背景（被验的 bug）：新电脑上安装根探测六条候选全不中 → 「找不到 DSH 可执行文件」
 * 与「找不到 DSH 自带的 node/pnpm」；而且用户没有任何按钮可以选择目录，只能手打路径。
 */

;(async () => {
  const out = { pass: false, checks: {}, fail: [] }
  const fail = (name, detail) => {
    out.checks[name] = { ok: false, detail }
    out.fail.push(`${name}: ${detail}`)
  }
  const pass = (name, value) => {
    out.checks[name] = { ok: true, value }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const dsh = window.dsh

  /* ---------------------------------------------------------------- *
   * 1. 契约：三个新通道必须在 window.dsh 上
   * ---------------------------------------------------------------- */
  const channel = {
    pickDirectory: typeof dsh?.pickDirectory === 'function',
    envRedetect: typeof dsh?.envRedetect === 'function',
    envDiagnose: typeof dsh?.envDiagnose === 'function'
  }
  out.checks.channel = channel
  for (const [k, ok] of Object.entries(channel)) {
    if (!ok) out.fail.push(`通道缺失: ${k}`)
  }

  /* ---------------------------------------------------------------- *
   * 2. envDiagnose：必须给出一条条试过的路由
   * ---------------------------------------------------------------- */
  let steps = []
  if (channel.envDiagnose) {
    try {
      steps = await dsh.envDiagnose()
    } catch (e) {
      fail('envDiagnose', `调用抛异常：${String(e)}`)
    }
    if (Array.isArray(steps)) {
      const byGroup = {}
      for (const s of steps) byGroup[s.group] = (byGroup[s.group] ?? 0) + 1
      const hits = steps.filter((s) => s.ok).map((s) => `${s.group} → ${s.path}`)
      out.checks.diagnose = {
        total: steps.length,
        byGroup,
        hits,
        // 每条都必须有 group / path / detail，否则界面分不出组
        shapeOk: steps.every(
          (s) => typeof s.group === 'string' && typeof s.path === 'string' && typeof s.detail === 'string'
        )
      }
      if (steps.length === 0) fail('envDiagnose', '返回了空数组（探测轨迹一条都没有）')
      if (!out.checks.diagnose.shapeOk) fail('envDiagnose', '有条目缺 group/path/detail 字段')
      if (hits.length === 0) fail('envDiagnose', '没有任何一条命中（这台机器上是异常，应该至少命中安装根）')
    } else {
      fail('envDiagnose', `返回不是数组：${typeof steps}`)
    }
  }

  /* ---------------------------------------------------------------- *
   * 3. envRedetect：来源字段必须有值
   * ---------------------------------------------------------------- */
  if (channel.envRedetect) {
    try {
      const rt = await dsh.envRedetect()
      out.checks.redetect = {
        installRoot: rt?.installRoot ?? null,
        installRootFrom: rt?.installRootFrom ?? null,
        dshHome: rt?.dshHome ?? null,
        dshHomeFrom: rt?.dshHomeFrom ?? null,
        nodePath: rt?.nodePath ?? null,
        pnpmPath: rt?.pnpmPath ?? null,
        discoveryLen: Array.isArray(rt?.discovery) ? rt.discovery.length : null,
        warnings: rt?.warnings ?? []
      }
      if (!rt?.installRoot) fail('envRedetect', 'installRoot 仍然是 null（这台机器上不该为空）')
      if (!rt?.installRootFrom) fail('envRedetect', 'installRootFrom 为空（界面没法显示「来自：…」）')
      if (!rt?.dshHomeFrom) fail('envRedetect', 'dshHomeFrom 为空')
      if (!Array.isArray(rt?.discovery)) fail('envRedetect', 'discovery 不是数组')
      else pass('envRedetect', out.checks.redetect)
    } catch (e) {
      fail('envRedetect', `调用抛异常：${String(e)}`)
    }
  }

  /* ---------------------------------------------------------------- *
   * 4. 设置面板：出路必须是可点的
   *    打开方式认两种形态（侧栏项文案 / 收起态的图标按钮），这是踩过的坑
   * ---------------------------------------------------------------- */
  const openSettings = () => {
    const item = [...document.querySelectorAll('.sb__item')].find((el) =>
      (el.textContent ?? '').includes('环境与设置')
    )
    if (item) {
      item.click()
      return 'sb__item'
    }
    const iconBtn = document.querySelector('.sb__icon-btn[aria-label="设置"]')
    if (iconBtn) {
      iconBtn.click()
      return 'icon-btn'
    }
    return null
  }

  const closeSettings = () => {
    // 认准底部操作区的 ghost 按钮 —— 按文案找 dialog 里第一个按钮会点错（踩过）
    const btn = document.querySelector('.dialog__foot-actions .btn--ghost')
    if (btn) btn.click()
  }

  const opened = openSettings()
  if (!opened) {
    fail('settings', '打不开设置面板（既没有「环境与设置」项也没有设置图标按钮）')
  } else {
    await sleep(400)
    const dialog = document.querySelector('.dialog--settings')
    if (!dialog) fail('settings', '设置面板没出现')
    const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
    const textOf = (b) => (b.textContent ?? '').trim()

    const browse = buttons.filter((b) => textOf(b).includes('浏览'))
    const redetect = buttons.filter((b) => textOf(b).includes('重新检测'))
    const diagnoseBtn = buttons.filter((b) => textOf(b).includes('环境诊断'))

    out.checks.settingsButtons = {
      browse: browse.map((b) => ({ text: textOf(b), title: b.title, disabled: b.disabled })),
      redetect: redetect.map((b) => ({ text: textOf(b), disabled: b.disabled })),
      diagnose: diagnoseBtn.map((b) => ({ text: textOf(b), disabled: b.disabled }))
    }
    // 两个路径字段各一个「浏览…」
    if (browse.length < 2) fail('settings', `「浏览…」按钮只有 ${browse.length} 个，应该 2 个（DSH_HOME + 安装根）`)
    if (redetect.length === 0) fail('settings', '没有「重新检测」按钮')
    if (diagnoseBtn.length === 0) fail('settings', '没有「环境诊断」入口')

    /* 代理提示不许再出现 65535 */
    const hint = [...dialog.querySelectorAll('.field__hint')]
      .map((el) => el.textContent ?? '')
      .find((t) => t.includes('直连'))
    out.checks.proxyHint = hint ?? null
    if (!hint) fail('proxyHint', '找不到代理那行说明文案')
    else if (hint.includes('65535')) fail('proxyHint', `代理提示里还有 65535：${hint}`)

    /* 诊断区懒加载：点开才该有内容 */
    if (diagnoseBtn.length > 0) {
      const before = document.querySelectorAll('.envdiag, .envdiag__group').length
      /*
       * 只在「收起」时才点。
       * 那个按钮是开关（点一下开、再点一下关，见 SettingsDialog 的 toggleDiagnose），
       * 而这一个脚本可能被连着跑好几次 —— 上一次跑完面板还开着，这一次再点就是把它关掉，
       * 于是读不到任何条目，看起来像渲染坏了。按钮文字尾部就是状态：▸ 收起 / ▾ 展开。
       */
      if (!textOf(diagnoseBtn[0]).includes('▾')) diagnoseBtn[0].click()
      /*
       * 必须轮询等，不能固定睡一觉就读。
       * 点开这一下会真的跑一遍完整探测回溯（注册表 reg.exe + 运行中的进程 WMI +
       * 必要时磁盘扫描），这台机器上实测 2.4 秒才出结果；固定睡 900ms 读到的是
       * 「正在把试过的路由读出来…」那一帧，会把一个正常的加载态误判成渲染失败。
       * （踩过：第一次跑就是这么误报的。）
       */
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        await sleep(500)
        if (document.querySelectorAll('.envdiag__group, .envdiag__item').length > 0) break
        // 明确的失败态就别等了（错误文案有专属 class）
        if (document.querySelectorAll('.envdiag__state--bad').length > 0) break
      }
      const groups = document.querySelectorAll('.envdiag__group, .envdiag__row, .envdiag__item')
      const groupNames = [...document.querySelectorAll('.envdiag__group-name')].map((el) => (el.textContent ?? '').trim())
      const bad = document.querySelector('.envdiag__state--bad')
      const panelState = [...document.querySelectorAll('.envdiag__state')].map((el) => (el.textContent ?? '').trim())
      if (groups.length === 0) {
        const why = bad ? `（面板报错：${(bad.textContent ?? '').trim()}）` : panelState.length ? `（面板还停在：${panelState.join(' / ')}）` : '（面板里连 .envdiag 都没有）'
        fail('diagnosePanel', `点开「环境诊断」后 15 秒内没有任何分组/条目渲染出来${why}`)
      } else {
        out.checks.diagnosePanel = { beforeExpandNodes: before, afterExpandNodes: groups.length, groupNames }
      }
    }

    closeSettings()
    await sleep(300)
  }

  /* ---------------------------------------------------------------- *
   * 5. 首屏引导卡**不该**在这台机器上出现（环境是全的）
   * ---------------------------------------------------------------- */
  const card = document.querySelector('.envset')
  out.checks.setupCardAbsent = !card
  if (card) fail('setupCard', '这台机器上环境是齐的，却仍然显示了环境引导卡')

  out.pass = out.fail.length === 0
  return out
})()
