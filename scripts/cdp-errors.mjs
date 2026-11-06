#!/usr/bin/env node
/**
 * cdp-errors.mjs —— 附加到运行中的插件台，打开 Runtime/Log 域，重载页面，
 * 把重载过程中抛出的异常与 console.error 原样打出来。
 *
 * 存在理由：渲染层白屏时 `document.body.innerHTML` 是空的，光看 DOM 查不出原因；
 * 异常只出现在 console 里，而 CDP 默认不转发。
 */
const PORT = process.env.CDP_PORT || 9333

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('没有可附加的页面')

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
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(msg)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })

const out = []
ws.addEventListener('message', (ev) => {
  let m
  try {
    m = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
  } catch {
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    out.push(`EXCEPTION: ${d.text} ${d.exception?.description ?? ''}`)
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    out.push(
      `CONSOLE.${m.params.type}: ${m.params.args.map((a) => a.description ?? JSON.stringify(a.value)).join(' ')}`
    )
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry
    out.push(`LOG.${e.level}: ${e.text}`)
  }
})

await send('Runtime.enable', {})
await send('Log.enable', {})
await send('Page.enable', {})
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 6000))

const dom = await send('Runtime.evaluate', {
  expression: 'document.getElementById("root") ? document.getElementById("root").children.length : -1',
  returnByValue: true
})
console.log('root children:', dom.result?.result?.value)
console.log(out.length ? out.join('\n') : '(没有异常/错误日志)')
ws.close()
