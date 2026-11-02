/**
 * probe-appearance-save.js —— 端到端验证「拖滑块 → 保存 → 界面真的变了」。
 *
 * 背景：侧边栏四个滑块（宽度/圆角/透明度/模糊）原先只写进 draft，没有任何代码
 * 把它变成 CSS 变量，拖完保存界面纹丝不动。现在 App.tsx 里有一条
 * 「设置 → documentElement 自定义属性」的桥，这个探针走完整条用户路径：
 *   打开设置 → 拖动「宽度」滑杆 → 点保存 → 读回变量与实测宽度
 *
 * 用原生 setter + input 事件而不是 el.value = x：React 在 input 上挂了值追踪器，
 * 直接赋值会被它判成「没变」而不触发 onChange。
 *
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-appearance-save.js
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const root = document.documentElement

  const read = () => {
    const cs = getComputedStyle(root)
    const sb = document.querySelector('.sb')
    return {
      varWidth: cs.getPropertyValue('--sb-w-expanded').trim(),
      inlineWidth: root.style.getPropertyValue('--sb-w-expanded') || null,
      varRadius: cs.getPropertyValue('--sb-radius').trim(),
      inlineRadius: root.style.getPropertyValue('--sb-radius') || null,
      mainMarginLeft: document.querySelector('.app__main')
        ? getComputedStyle(document.querySelector('.app__main')).marginLeft
        : null,
      sbMeasuredWidth: sb ? Math.round(sb.getBoundingClientRect().width) : null
    }
  }

  const before = read()

  // 1) 打开设置。侧边栏收起时按钮只剩图标（aria-label="设置"），
  //    展开时是「环境与设置」那一项 —— 两种形态都要认。
  const settingsBtn =
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '环境与设置') ??
    [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === '设置' || b.getAttribute('title') === '设置'
    )
  if (!settingsBtn) return { error: '没找到入口按钮', before }
  settingsBtn.click()
  await sleep(600)

  const dialog = document.querySelector('.dialog, [role="dialog"]')
  if (!dialog) return { error: '设置面板没打开', before }

  // 2) 找到标签为「宽度」的滑杆并拖到 300
  const label = [...dialog.querySelectorAll('.aprng')].find(
    (l) => l.querySelector('.aprng__label')?.textContent.trim() === '宽度'
  )
  const input = label?.querySelector('input[type="range"]')
  if (!input) return { error: '没找到「宽度」滑杆', before }

  const beforeVal = input.value
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '300')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  const afterDrag = {
    inputValue: input.value,
    readout: label.querySelector('.aprng__val')?.textContent.trim() ?? null,
    varWidthBeforeSave: getComputedStyle(root).getPropertyValue('--sb-w-expanded').trim()
  }

  // 3) 保存
  const saveBtn = dialog.querySelector('.dialog__foot-actions .btn--primary')
  if (!saveBtn) return { error: '没找到保存按钮', before, afterDrag }
  saveBtn.click()
  await sleep(1400)

  const after = read()

  return {
    before,
    beforeVal,
    afterDrag,
    after,
    dialogClosed: !document.querySelector('.dialog__foot-actions'),
    verdict: {
      varWentTo300: after.varWidth === '300px',
      inlineWentTo300: after.inlineWidth === '300px',
      savedNotJustDrafted: afterDrag.varWidthBeforeSave !== '300px'
    }
  }
})()