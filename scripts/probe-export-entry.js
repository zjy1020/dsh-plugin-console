// 一次性探针：dump「已安装」工具条上每个按钮的文案 / title / 可见性 / 包围盒。
// 用法：node scripts/cdp-eval.mjs --file scripts/probe-export-entry.js
(() => {
  const win = { w: window.innerWidth, h: window.innerHeight }
  const bar = document.querySelector('.toolbar__actions')
  if (!bar) {
    return {
      ok: false,
      reason: '没有找到 .toolbar__actions：当前可能不在「已安装」页',
      view: [...document.querySelectorAll('[data-view], nav button, aside button')]
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 30)
    }
  }

  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  const buttons = [...bar.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect()
    return {
      text: (b.textContent || '').trim(),
      title: b.getAttribute('title'),
      cls: b.className,
      disabled: b.disabled,
      offset: [b.offsetWidth, b.offsetHeight],
      rect: rectOf(b),
      // 是否真的画在窗口里（宽度>0 且包围盒落在视口内）
      onScreen: b.offsetWidth > 0 && r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= win.h && r.right <= win.w
    }
  })

  const target = [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '导出清单') || null
  let targetDetail = null
  if (target) {
    const cs = getComputedStyle(target)
    const r = target.getBoundingClientRect()
    // 采样按钮正中心，看最上层命中的是不是它自己（判断有没有被别的元素盖住）
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    targetDetail = {
      title: target.getAttribute('title'),
      disabled: target.disabled,
      cls: target.className,
      text: (target.textContent || '').trim(),
      offset: [target.offsetWidth, target.offsetHeight],
      rect: rectOf(target),
      style: {
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        color: cs.color,
        background: cs.backgroundColor,
        borderTopColor: cs.borderTopColor,
        borderTopWidth: cs.borderTopWidth,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        whiteSpace: cs.whiteSpace
      },
      // 文字被截断的判定：内容宽度 > 可视宽度
      clipped: target.scrollWidth > target.clientWidth + 1,
      pointHitSelf: !!hit && (hit === target || target.contains(hit)),
      pointHitTag: hit ? `${hit.tagName.toLowerCase()}.${(hit.className || '').toString().split(' ')[0]}` : null
    }
  }

  const activeBtn = document.querySelector('.toolbar__actions button.btn--primary')
  return {
    ok: !!target,
    win,
    toolbarRect: rectOf(bar),
    buttons,
    exportButton: targetDetail,
    // 顺带把刷新 / 主按钮的样式拿出来对比视觉权重
    ghostRefresh: (() => {
      const b = [...bar.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('刷新'))
      if (!b) return null
      const cs = getComputedStyle(b)
      return { color: cs.color, background: cs.backgroundColor, borderTopColor: cs.borderTopColor }
    })(),
    primaryInstall: activeBtn
      ? (() => {
          const cs = getComputedStyle(activeBtn)
          return { text: (activeBtn.textContent || '').trim(), color: cs.color, background: cs.backgroundColor }
        })()
      : null
  }
})()
