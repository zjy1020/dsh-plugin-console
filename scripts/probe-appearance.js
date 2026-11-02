/**
 * probe-appearance.js —— 验证「外观设置 → CSS 变量」这条桥是不是真的通了。
 *
 * 背景：之前 sidebarWidth / sidebarRadius / sidebarOpacity / sidebarBlur /
 * accent / ambient 这六个字段只写进了 settings.json，样式表一次都没读到，
 * 拖滑块界面不动。修法是在 App.tsx 里把值灌到 documentElement 的自定义属性上。
 *
 * 这个探针同时读三层，缺一层都不算通过：
 *   1) vars    —— getComputedStyle 拿到的变量值（证明桥跑过）
 *   2) inline  —— documentElement 的内联变量（证明是桥写的，不是样式表默认值）
 *   3) measured —— 元素实际量出来的宽 / 圆角 / 背板模糊（证明变量真的被消费了）
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-appearance.js
 */
;(async () => {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  const v = (n) => cs.getPropertyValue(n).trim()

  const sb = document.querySelector('.sb')
  const sbCs = sb ? getComputedStyle(sb) : null
  const main = document.querySelector('.app__main')

  return {
    theme: root.dataset.theme || null,
    glass: root.dataset.glass || null,
    contrast: root.dataset.contrast || null,
    motion: root.dataset.motion || null,

    // 1) 计算值
    vars: {
      sbW: v('--sb-w-expanded'),
      sbRadius: v('--sb-radius'),
      panelAlpha: v('--gl-panel-alpha'),
      panelBlur: v('--gl-panel-blur'),
      brand: v('--p-brand'),
      brand06: v('--p-brand-06'),
      ambient: v('--p-ambient'),
      veil: v('--gl-veil-color'),
      t1: v('--t-1'),
      t6: v('--t-6'),
      fg1: v('--fg-1'),
      fg2: v('--fg-2')
    },

    // 2) 内联（桥写进去的那一份）
    inline: {
      sbW: root.style.getPropertyValue('--sb-w-expanded') || null,
      sbRadius: root.style.getPropertyValue('--sb-radius') || null,
      panelAlpha: root.style.getPropertyValue('--gl-panel-alpha') || null,
      panelBlur: root.style.getPropertyValue('--gl-panel-blur') || null,
      brand: root.style.getPropertyValue('--p-brand') || null,
      ambient: root.style.getPropertyValue('--p-ambient') || null
    },

    // 3) 元素实际呈现
    measured: {
      sbWidth: sb ? Math.round(sb.getBoundingClientRect().width) : null,
      sbRadius: sbCs ? sbCs.borderTopLeftRadius : null,
      sbBackdrop: sbCs ? sbCs.backdropFilter || sbCs.webkitBackdropFilter : null,
      sbBg: sbCs ? sbCs.backgroundColor : null,
      mainMarginLeft: main ? getComputedStyle(main).marginLeft : null
    }
  }
})()