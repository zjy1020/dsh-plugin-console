#!/usr/bin/env node
/**
 * cdp-eval.mjs —— 通过 Chrome DevTools Protocol 在运行中的 DSH 插件台里执行一段 JS，
 * 或者直接抓一张像素级准确的截图。
 *
 * 为什么要有截图模式：Win32 PrintWindow 抓 Electron 的 GPU 合成窗口会随机丢图层
 * （实测「显示官方内置层」这行字时有时无），Windows 缩放显示器上还要额外处理 DPI。
 * CDP 的 Page.captureScreenshot 直接拿 Chromium 自己合成的帧，所见即所得。
 *
 * 用法：
 *   node scripts/cdp-eval.mjs "document.documentElement.scrollWidth"
 *   node scripts/cdp-eval.mjs --file scripts/probe.js
 *   node scripts/cdp-eval.mjs --shot docs/shots/foo.png
 *   node scripts/cdp-eval.mjs --shot docs/shots/foo.png --wait 800
 *
 * 前置：应用带 --remote-debugging-port=9333 启动。
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const PORT = process.env.CDP_PORT || 9333

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!res.ok) throw new Error(`CDP /json/list -> ${res.status}`)
  return res.json()
}

function pickPage(list) {
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const app = pages.find((t) => !/^devtools:/.test(t.url))
  return app || pages[0]
}

async function withSession(fn) {
  const list = await targets()
  const page = pickPage(list)
  if (!page) throw new Error('没有找到可附加的页面')

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

  try {
    return await fn(send)
  } finally {
    ws.close()
  }
}

async function evaluate(expression) {
  return withSession(async (send) => {
    await send('Runtime.enable', {})
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    const result = reply?.result
    if (!result) return undefined
    if (result.exceptionDetails) {
      const d = result.exceptionDetails
      throw new Error(`${d.text}${d.exception?.description ? `\n${d.exception.description}` : ''}`)
    }
    return result.result?.value
  })
}

async function screenshot(outPath, waitMs) {
  return withSession(async (send) => {
    await send('Page.enable', {})
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
    const reply = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    })
    const data = reply?.result?.data
    if (!data) throw new Error('captureScreenshot 没返回数据')
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, Buffer.from(data, 'base64'))
    return outPath
  })
}

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('用法: node scripts/cdp-eval.mjs "<js>" | --file <路径> | --shot <png> [--wait ms]')
  process.exit(2)
}

try {
  if (argv[0] === '--shot') {
    const outPath = argv[1]
    const waitIdx = argv.indexOf('--wait')
    const waitMs = waitIdx > 0 ? Number(argv[waitIdx + 1]) || 0 : 400
    const written = await screenshot(outPath, waitMs)
    console.log(written)
  } else {
    let expression
    if (argv[0] === '--file') expression = await readFile(argv[1], 'utf8')
    else expression = argv.join(' ')

    const value = await evaluate(expression)
    if (value === undefined) console.log('undefined')
    else if (typeof value === 'string') console.log(value)
    else console.log(JSON.stringify(value, null, 2))
  }
} catch (err) {
  console.error(`[cdp-eval] ${err.message}`)
  process.exit(1)
}