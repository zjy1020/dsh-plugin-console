// 打开设置面板并 dump 外观分区结构（CDP，走真实 UI 点击）
(() => {
  const out = { steps: [] }

  // 侧栏「环境与设置」
  const navBtns = Array.from(document.querySelectorAll('.sb__item'))
  const gear = navBtns.find((b) => (b.textContent || '').includes('环境与设置'))
  out.steps.push('navFound=' + !!gear)
  if (gear) gear.click()

  return out
})()
