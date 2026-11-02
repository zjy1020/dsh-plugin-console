/**
 * 窗口按钮可见性复验脚本（DOM 侧）
 * 用法：node scripts/cdp-eval.mjs --file scripts/verify-titlebar-buttons.js
 *
 * 它是「计算样式 + 命中测试 + 对比度」三重断言，配套 scripts/inkcheck.py（像素侧）一起用：
 *   inkcheck.py 证明「画出来了」，本脚本证明「该画出来的东西几何/颜色/命中都对」。
 *
 * 断言 4 组：
 *   A. 三个按钮自身 opacity === '1'、visibility === 'visible'、display 不是 none
 *   B. elementFromPoint(按钮中心) 命中按钮本身或它的子元素（没被别的元素压住）
 *   C. -webkit-app-region：按钮 = no-drag，.titlebar__drag = drag（要求 4 两半都测）
 *   D. 字形描边颜色与「标题栏底色」的对比度 ≥ 3:1
 *      —— 标题栏背景是透明的（glass.css:1301 有意为之），所以底色 = 墙纸透上来的颜色；
 *         另外标题栏失焦时整条 opacity 会降到 0.82（components.css .titlebar[data-focused='false']），
 *         所以要按「复合 alpha」把颜色压过一遍再算对比度，不能直接拿 token 色算。
 *
 * 对比度算法：WCAG 2.x 相对亮度
 *   通道线性化  c_lin = c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4
 *   L = 0.2126*R_lin + 0.7152*G_lin + 0.0722*B_lin
 *   比值 = (L_亮 + 0.05) / (L_暗 + 0.05)
 * 复合 alpha：painted = color*alpha + bg*(1-alpha)
 *
 * 预期结果（2026-11 实测）：
 *   - 修复前（10×10 / 1.1px / --fg-1）：PASS:false，失败项 strokeFromCss（1.1 < 1.4），
 *     contrast painted 4.97 —— 假阳性 0：它就是「太细太淡」，像素侧 inkcheck 只有 96/154/135 墨点。
 *   - 修复后（16×16 / 1.5px / --fg-0）：PASS:true，contrast raw 12.2 / painted 7.85，
 *     像素侧 102/222/166 墨点。
 *   也就是说这个脚本在旧包上跑**应该**失败；跑出 PASS:true 才说明修复进到运行实例了。
 */
(async () => {
  // 标题栏背后的真实颜色（1980×1323 截图里 (1700,30) 的取样值；标题栏是透明的，
  // 这里取的就是墙纸透上来的底色）。墙纸换了要重新取样，否则算出来的对比度不准。
  const BG_EFFECTIVE = [211, 213, 215]
  const MIN_CONTRAST = 3

  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const lin = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const ratio = (a, b) => {
    const la = lum(a)
    const lb = lum(b)
    const hi = Math.max(la, lb)
    const lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
  }
  const over = (fg, bg, alpha) => [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha)
  ]
  const rgb = (c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]
  const hex = (c) =>
    '#' +
    rgb(c)
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')

  const bar = document.querySelector('.titlebar')
  if (!bar) return { PASS: false, error: '找不到 .titlebar' }
  const btns = [...bar.querySelectorAll('.titlebar__btn')]
  const drag = bar.querySelector('.titlebar__drag')

  // 复合 opacity：按钮自己 × 所有祖先（含 .titlebar）
  const compositeOpacity = (el) => {
    let a = 1
    let n = el
    while (n && n !== document.documentElement) {
      a *= Number(getComputedStyle(n).opacity || 1)
      n = n.parentElement
    }
    return a
  }

  const failures = []
  const rows = btns.map((b) => {
    const cs = getComputedStyle(b)
    const r = b.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    const glyph = b.querySelector('.titlebar__glyph') || b.querySelector('svg')
    const shape = b.querySelector('path,rect,polyline,line')
    const scs = shape ? getComputedStyle(shape) : null
    const strokeColor = scs ? scs.stroke : cs.color
    const rgbStroke = parse(strokeColor) || parse(cs.color) || { r: 0, g: 0, b: 0 }
    const a = compositeOpacity(b)
    const painted = over([rgbStroke.r, rgbStroke.g, rgbStroke.b], BG_EFFECTIVE, a)
    const cRaw = ratio([rgbStroke.r, rgbStroke.g, rgbStroke.b], BG_EFFECTIVE)
    const cPainted = ratio(painted, BG_EFFECTIVE)
    const label = b.getAttribute('aria-label')
    const tag = hit ? hit.tagName.toLowerCase() : null

    const checks = {
      opacity1: cs.opacity === '1',
      visible: cs.visibility === 'visible',
      displayNotNone: cs.display !== 'none',
      hitSelfOrChild: !!(hit && (hit === b || b.contains(hit))),
      noDrag: getComputedStyle(b).webkitAppRegion === 'no-drag',
      hasAriaLabel: !!label,
      hasTitle: !!b.getAttribute('title'),
      hasGlyph: !!glyph,
      strokeFromCss: !scs || parseFloat(scs.strokeWidth) >= 1.4,
      contrastRaw: +cRaw.toFixed(2) >= MIN_CONTRAST,
      contrastPainted: +cPainted.toFixed(2) >= MIN_CONTRAST
    }
    const bad = Object.keys(checks).filter((k) => !checks[k])
    if (bad.length) failures.push(`${label || '?'}: ${bad.join(', ')}`)

    return {
      label,
      title: b.getAttribute('title'),
      rect: [r.left, Math.round(r.top * 100) / 100, r.width, Math.round(r.height * 100) / 100],
      center: [cx, cy],
      btnOpacity: cs.opacity,
      compositeOpacity: Math.round(a * 1000) / 1000,
      visibility: cs.visibility,
      appRegion: getComputedStyle(b).webkitAppRegion,
      hit:
        tag +
        (hit && hit.getAttribute && hit.getAttribute('class')
          ? '.' + hit.getAttribute('class')
          : ''),
      strokeColor,
      strokeWidth: scs ? scs.strokeWidth : null,
      contrast_token_vs_bg: +cRaw.toFixed(2),
      contrast_painted_vs_bg: +cPainted.toFixed(2),
      paintedHex: hex(painted),
      bg: rgb(BG_EFFECTIVE).join(','),
      checks
    }
  })

  return {
    PASS: failures.length === 0,
    failures,
    bgSampled: rgb(BG_EFFECTIVE).join(','),
    dragRegion: drag ? getComputedStyle(drag).webkitAppRegion : 'no .titlebar__drag',
    titlebarRegion: getComputedStyle(bar).webkitAppRegion,
    titlebarOpacity: getComputedStyle(bar).opacity,
    dataFocused: bar.getAttribute('data-focused'),
    theme: document.documentElement.getAttribute('data-theme'),
    contrastMethod: 'WCAG 相对亮度 + 复合alpha叠底；BG 取截图 (1700,30) 取样值',
    buttons: rows
  }
})()