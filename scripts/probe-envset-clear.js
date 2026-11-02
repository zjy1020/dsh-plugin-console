/** 清掉 probe-envset-shot.js 注入的临时卡片 */
(async () => {
  const n = document.querySelectorAll('.envset[data-probe]').length
  document.querySelectorAll('.envset[data-probe]').forEach((el) => el.remove())
  return { removed: n }
})()
