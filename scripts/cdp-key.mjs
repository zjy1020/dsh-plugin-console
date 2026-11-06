#!/usr/bin/env node
/**
 * cdp-key.mjs —— 用 CDP 的 Input.dispatchKeyEvent 发**真实键盘事件**。
 *
 * 为什么不用 cdp-eval 里的 KeyboardEvent：合成事件是从 document 直接派发的，
 * 根本不经过焦点的元素，React 挂在 #root 上的委托监听收不到，而挂在 document 上的
 * 监听又会误收 —— 于是「Esc 只关灯箱还是连详情页一起关」这种判断会得出错误结论。
 *
 * 用法：node scripts/cdp-key.mjs Escape [--times 2] [--gap 600]
 */
const PORT = process.env.CDP_PORT || 9333
const argv = process.argv.slice(2)
const key = argv[0] || 'Escape'
const times = Number((argv[argv.indexOf('--times') + 1] || 1)) || 1
const gap = Number((argv[argv.indexOf('--gap') + 1] || 600)) || 600

const KEYS = {
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
}

const spec = KEYS[key] ?? { code: key, windowsVirtualKeyCode: 0 }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
})

let seq = 0
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq
    const onMsg = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < times; i++) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
  })
  await sleep(gap)
}

const dom = await send('Runtime.evaluate', {
  expression:
    'JSON.stringify({ lightbox: !!document.querySelector(".gal-preview"), sheet: !!document.querySelector(".mkt__sheet"), active: document.activeElement && (document.activeElement.className || document.activeElement.tagName) })',
  returnByValue: true,
})
console.log(`${key} x${times} ->`, dom.result?.result?.value)
ws.close()
