#!/usr/bin/env node
/**
 * probe-market-shot.mjs —— 一条 CDP 会话里完成「切到安装插件 → 点插件市场 → 等列表 → 截图」，
 * 避免两次 cdp-eval 调用之间页面被别人 reload 掉。
 *
 * 用法：node scripts/probe-market-shot.mjs docs/shots/market.png
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const PORT = process.env.CDP_PORT || 9333
const outPath = process.argv[2] || 'docs/shots/market.png'

const GO_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  if (!document.querySelector('.install__tab')) {
    byText('button', '安装插件')?.click()
    await sleep(500)
  }
  const tab = byText('.install__tab', '插件市场')
  if (!tab) return { ok: false, reason: '没有插件市场 tab' }
  tab.click()
  for (let i = 0; i < 90; i++) {
    if (document.querySelectorAll('.mkt__card-name').length > 0) break
    await sleep(500)
  }
  // 等图标探测队列出结果（有声明的直接用，没声明的按仓库/子目录猜，队列很小，2~3 秒就稳）
  await sleep(2600)
  const imgs = [...document.querySelectorAll('.mkt__card img')]
  return {
    ok: true,
    cards: document.querySelectorAll('.mkt__card').length,
    decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    status: document.querySelector('.mkt__status')?.innerText.split('\\n')[0] ?? null
  }
})()`

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).find((t) => !/^devtools:/.test(t.url)) ||
  list.find((t) => t.type === 'page')
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

await send('Runtime.enable', {})
await send('Page.enable', {})
// 窗口被别的窗口压住时 captureScreenshot 会一直不返回，先把它拿到前台
await send('Page.bringToFront', {})
const evaled = await send('Runtime.evaluate', { expression: GO_JS, returnByValue: true, awaitPromise: true, userGesture: true })
console.log('go:', JSON.stringify(evaled?.result?.result?.value ?? evaled?.result))
await new Promise((r) => setTimeout(r, 900))

/** 截图，15 秒不回来就换一种抓法再来一次；太小说明抓到的是一张空表面（窗口被压住），也换一种 */
const capture = async (params, ms) => {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  const shot = await Promise.race([send('Page.captureScreenshot', params), timeout])
  clearTimeout(timer)
  const data = shot?.result?.data ?? null
  return data && data.length > 40000 ? data : null
}
let data = await capture({ format: 'png', fromSurface: true, captureBeyondViewport: false }, 15000)
if (!data) data = await capture({ format: 'png', fromSurface: false, captureBeyondViewport: false }, 15000)
// 窗口被收进托盘 / 压住时，前两种都可能只拿到一张空表面；这一种会强制整页重绘再抓
if (!data) data = await capture({ format: 'png', fromSurface: true, captureBeyondViewport: true }, 20000)
if (!data) {
  throw new Error('captureScreenshot 抓到的都是空表面——把窗口恢复出来（scripts/foreground-app.ps1）或重启一个实例后立刻截')
}
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, Buffer.from(data, 'base64'))
console.log('shot:', outPath, `${Math.round(data.length / 1024)}KB(base64)`)
ws.close()
