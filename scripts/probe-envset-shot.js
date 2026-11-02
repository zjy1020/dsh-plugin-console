/**
 * probe-envset-shot.js —— 把「环境全缺」那一屏真实画出来，供肉眼验收。
 *
 * 为什么要注入真卡而不是造个假的：真卡的布局由 App.tsx 的 JSX + env-setup.css 共同决定，
 * 造一个看起来像的 div 只能验 CSS 不能验 JSX。这里的做法是**把 store 的 runtime 打残**
 * （installRoot/dshHome/nodePath 全 null），让 React 自己渲染出 EnvSetupCard ——
 * 但 store 是闭包里的，外部改不到。所以退一步：注入一张与真卡同构的卡，
 * 同时**保留页面原有的一切**（侧栏、标题栏、壁纸、主区），这样量出来的是
 * 「卡片进到这个真实页面里」的效果，而不是「一张孤零零的卡」。
 *
 * 唯一的近似：真卡出现时主区会被往下顶（它在 .app__body 之上）。这里也照做 ——
 * 量完把卡片留在 DOM 里给截图用，脚本结束时才删。
 */
(async () => {
  const app = document.querySelector('.app')
  const titlebar = document.querySelector('.titlebar')
  if (!app || !titlebar) return { ok: false, error: '找不到 .app / .titlebar' }

  // 先把上一轮残留清掉
  document.querySelectorAll('.envset[data-probe]').forEach((n) => n.remove())

  const card = document.createElement('div')
  card.className = 'banner banner--danger app__fatal envset'
  card.setAttribute('role', 'alert')
  card.setAttribute('data-probe', '1')
  card.innerHTML = [
    '<div class="envset__head">',
    '  <span aria-hidden="true">✕</span>',
    '  <div class="envset__title-wrap">',
    '    <strong class="envset__title">DSH 环境不完整：缺 安装目录、DSH_HOME</strong>',
    '    <span class="envset__lead">插件台没能把 DSH 的位置定下来，装插件、更新、导入清单都会失败。下面两个按钮随便点一个就能自己解决，不用手打路径。</span>',
    '  </div>',
    '</div>',
    '<div class="envset__actions">',
    '  <button type="button" class="btn btn--sm btn--primary">自动检测一遍</button>',
    '  <button type="button" class="btn btn--sm envbrowse">手动选择安装目录…</button>',
    '  <button type="button" class="btn btn--sm btn--ghost">打开设置</button>',
    '</div>',
    '<button type="button" class="btn btn--sm btn--ghost envset__diagtoggle" aria-expanded="false">看诊断明细（57 条没命中）▾</button>'
  ].join('')
  titlebar.after(card)

  await new Promise((r) => setTimeout(r, 260))

  const c = card.getBoundingClientRect()
  const body = document.querySelector('.app__body')
  const b = body ? body.getBoundingClientRect() : null
  return {
    ok: true,
    card: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) },
    bodyAfter: b ? { y: Math.round(b.y), h: Math.round(b.height) } : null,
    hint: '卡片已留在 DOM 里，紧接着跑截图即可；清场用 scripts/probe-envset-clear.js'
  }
})()
