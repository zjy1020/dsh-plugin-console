#!/usr/bin/env node
/**
 * probe-autodiscover3.mjs —— 「新电脑上它自己找到 DSH」的端到端时间线采样。
 *
 * 为什么不能再用 cdp-eval.mjs：
 *   那个脚本是「先启动应用 → 再连上去执行一段 JS」，实测连上时已经过了 16 秒，
 *   主进程早在 2.5 秒时就探到安装根并推送完了 —— 采样完全错过坏窗口，
 *   于是「界面自己好起来了」这件事永远验不到。
 *
 * 这一版的顺序反过来：
 *   1) 先在本进程里**等 CDP 端口出现**（应用还没启动就等着）
 *   2) 一旦页面可附加，立刻开始每 150ms 采一次样
 *   3) 全程**不点任何按钮**，只看界面自己会不会好
 *
 * 用法（先让应用以 --remote-debugging-port=9333 启动，本脚本要**先**跑起来）：
 *   node scripts/probe-autodiscover3.mjs --timeout 45000
 *
 * 判据：
 *   A `wasBrokenAtMount` —— 采样一开始环境就是坏的（否则这次没覆盖到自动修复，如实标出）
 *   B 之后出现 installRoot 且引导卡消失，全程无人工干预
 *   C 最终 node / pnpm 都能解出来（缺了这俩，装插件照样装不了）
 */

const PORT = process.env.CDP_PORT || 9333
const argv = process.argv.slice(2)
const timeoutIdx = argv.indexOf('--timeout')
const TIMEOUT = timeoutIdx >= 0 ? Number(argv[timeoutIdx + 1]) || 45000 : 45000
const STEP = 150

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

async function waitForPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (res.ok) {
        const list = await res.json()
        const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        const app = pages.find((t) => !/^devtools:/.test(t.url))
        if (app) return app
      }
    } catch {
      /* 端口还没起来，继续等 */
    }
    await sleep(120)
  }
  return null
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return
    }
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    slot(msg)
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ws, send }
}

/** 在页面里取一次状态。任何一步失败都返回 {ok:false}，不让探针自己崩掉。 */
const SNAP = `(async () => {
  const out = { hasDsh: Boolean(window.dsh), appMounted: Boolean(document.querySelector('.app')) }
  out.envset = Boolean(document.querySelector('.envset'))
  out.toastTitles = [...document.querySelectorAll('.toast__title')].map((n) => n.textContent.trim())
  out.pluginRows = document.querySelectorAll('.plist__row, .prow').length
  try {
    const rt = await window.dsh.runtimeInfo()
    out.installRoot = rt && rt.installRoot ? rt.installRoot : null
    out.installRootFrom = rt && rt.installRootFrom ? rt.installRootFrom : null
    out.nodeOk = Boolean(rt && rt.nodePath)
    out.pnpmOk = Boolean(rt && rt.pnpmPath)
  } catch (err) {
    out.runtimeError = String(err && err.message ? err.message : err)
  }
  return out
})()`

const started = Date.now()
const deadline = started + TIMEOUT

log(`[probe] 等 CDP 端口 ${PORT} 出现…`)
const page = await waitForPage(deadline)
if (!page) {
  log(`[probe] ${TIMEOUT}ms 内没有可附加的页面（应用没起来？）`)
  process.exit(1)
}
log(`[probe] 已找到页面：${page.url}（等了 ${Date.now() - started}ms）`)

const { ws, send } = await connect(page)
await send('Runtime.enable', {})

const timeline = []
let prevKey = ''
let brokenAtStart = null
let recoveredAt = null

while (Date.now() < deadline) {
  const reply = await send('Runtime.evaluate', {
    expression: SNAP,
    returnByValue: true,
    awaitPromise: true
  })
  const v = reply?.result?.result?.value
  if (v) {
    const at = Date.now() - started
    const key = `${v.appMounted}|${v.envset}|${v.installRoot}|${v.nodeOk}|${v.pnpmOk}|${(v.toastTitles || []).join(',')}`
    if (key !== prevKey) {
      prevKey = key
      const row = { at, ...v }
      timeline.push(row)
      log(
        `[probe] +${String(at).padStart(5)}ms mounted=${v.appMounted} envset=${v.envset} ` +
          `root=${v.installRoot ?? 'null'}(${v.installRootFrom ?? '-'}) node=${v.nodeOk} pnpm=${v.pnpmOk}` +
          (v.toastTitles?.length ? ` toast=${v.toastTitles.join(' / ')}` : '')
      )
    }
    if (brokenAtStart === null && v.appMounted) {
      brokenAtStart = !v.installRoot || Boolean(v.envset)
    }
    if (brokenAtStart && !recoveredAt && v.installRoot && !v.envset && v.nodeOk && v.pnpmOk) {
      recoveredAt = at
      log(`[probe] ★ 界面自己恢复了，用时 ${at}ms（全程没有点任何按钮）`)
      break
    }
  }
  await sleep(STEP)
}

ws.close()

const last = timeline[timeline.length - 1] ?? {}
const out = {
  wasBrokenAtStart: brokenAtStart,
  recoveredAfterMs: recoveredAt,
  samples: timeline.length,
  first: timeline[0] ?? null,
  last,
  timeline
}
const fail = []
if (brokenAtStart !== true) fail.push('采样开始时环境就是好的 —— 这次没有覆盖到「自动修复」，结论无效')
if (brokenAtStart === true && recoveredAt === null) fail.push('超时仍未恢复')
if (last && (!last.nodeOk || !last.pnpmOk)) fail.push('恢复了安装根，但 node/pnpm 仍缺')
out.fail = fail
out.pass = fail.length === 0
log(JSON.stringify({ pass: out.pass, wasBrokenAtStart: out.wasBrokenAtStart, recoveredAfterMs: out.recoveredAfterMs, samples: out.samples, fail: out.fail }, null, 2))
if (!out.pass) {
  log('--- 完整时间线 ---')
  log(JSON.stringify(out.timeline, null, 2))
}
process.exit(out.pass ? 0 : 1)
