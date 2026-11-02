/* eslint-disable */
/**
 * probe-detail2.js —— bug 1 复验：点开一个插件后详情面板的衬底与内部布局
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-detail2.js
 *
 * 只在界面里点一下插件行（纯选中，不写盘），量完再按 Esc 关掉。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const R = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const n = (v) => Math.round(v * 100) / 100
    return { x: n(r.x), y: n(r.y), w: n(r.width), h: n(r.height) }
  }
  const q = (s) => document.querySelector(s)
  const cs = (el, ...ps) => {
    if (!el) return null
    const c = getComputedStyle(el)
    const o = {}
    for (const p of ps) o[p] = c.getPropertyValue(p)
    return o
  }

  // 找到第一张插件卡并点开（行元素的类是 .prow）
  const rows = document.querySelectorAll('.plist__body .prow')
  const first = rows[0]
  if (!first) return { error: '没找到插件行', tried: rows.length }
  first.click()
  await sleep(900)

  const d = q('.detail')
  if (!d) return { error: '点了之后没有出现 .detail', rowHtml: first.className }

  const body = q('.detail__body')
  const head = q('.detail__head')
  const actions = q('.detail__actions')
  const meta = q('.gal__meta')
  const grid = q('.gal__grid')
  const thumbs = [...document.querySelectorAll('.gal__thumb')]

  const dRect = d.getBoundingClientRect()

  const out = {
    detail: R(d),
    /** 衬底：alpha 必须 > 0（透板时代的 bug 就是这里全透明） */
    shell: cs(d, 'background-color', 'border-radius', 'backdrop-filter', 'overflow', 'border-top-color'),
    /** 是否真的贴在窗口右沿（修好后应当留出 10px 外边距） */
    rightGap: Math.round((window.innerWidth - dRect.right) * 100) / 100,
    head: R(head),
    body: R(body),
    actions: R(actions),
    bodyScroll: body ? { sh: body.scrollHeight, ch: body.clientHeight, scrollable: body.scrollHeight > body.clientHeight } : null,
    /** 正文首块必须是简介，而不是把它留在滚动区外（那会把 body 压成 0 高） */
    firstBodyChild: body ? (body.firstElementChild?.className || body.firstElementChild?.tagName) : null,
    sections: [...document.querySelectorAll('.detail__section .section-title')].map((e) => e.textContent.trim()),
    gallery: {
      metaRect: R(meta),
      metaColor: meta ? getComputedStyle(meta).color : null,
      metaText: meta ? meta.textContent.trim().slice(0, 40) : null,
      gridRect: R(grid),
      thumbCount: thumbs.length,
      /** 缩略图不能超出网格容器（400px 宽的详情里最容易出这条） */
      thumbOverflow: thumbs.some((t) => {
        const a = t.getBoundingClientRect()
        const b = grid ? grid.getBoundingClientRect() : null
        return b ? a.right > b.right + 0.6 || a.left < b.left - 0.6 : false
      }),
      thumbSizes: [...new Set(thumbs.map((t) => `${Math.round(t.getBoundingClientRect().width)}x${Math.round(t.getBoundingClientRect().height)}`))]
    },
    /** 内部元素有没有被 overflow:hidden 切掉 */
    clipped: [head, body, actions].map((el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        cls: el.className.split(' ')[0],
        overflowBottom: Math.round((r.bottom - dRect.bottom) * 100) / 100,
        overflowTop: Math.round((dRect.top - r.top) * 100) / 100
      }
    })
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(200)
  out.closed = !q('.detail')
  return out
})()