/* 收起态专项：确保进入收起态，然后清点导航项与滑块的可见性。
 * 上一版探针直接点一下「收起」按钮，但收起状态是持久化的 —— 如果上次跑完留在收起态，
 * 再点一次反而变成展开，量出来的是展开态。所以这一版先读状态再决定点不点。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = async (n = 3) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => requestAnimationFrame(() => r()));
  };

  const isCollapsed = () => {
    const sb = document.querySelector('.sb');
    return Boolean(sb && sb.classList.contains('sb--collapsed'));
  };

  const log = [];

  if (!isCollapsed()) {
    const btn = document.querySelector('.sb__collapse');
    if (btn) {
      btn.click();
      await frames(3);
      await sleep(560);
    }
  }
  await frames(2);
  log.push({ step: 'force-collapse', collapsed: isCollapsed() });

  const sb = document.querySelector('.sb');
  const nav = document.querySelector('.sb__nav');
  const items = Array.from(document.querySelectorAll('.sb__nav .sb__item'));
  const groupHeads = Array.from(document.querySelectorAll('.sb__nav .sb__group-head'));

  const vis = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.x),
      y: Math.round(r.y),
    };
  };

  log.push({
    step: 'nav',
    sbW: sb ? Math.round(sb.getBoundingClientRect().width) : null,
    navVis: vis(nav),
    itemCount: items.length,
    groupHeadCount: groupHeads.length,
    groupHeadHead: groupHeads[0] ? vis(groupHeads[0]) : null,
    itemsFirst3: items.slice(0, 3).map((el) => ({
      label: (el.querySelector('.sb__item-label') || {}).textContent || null,
      active: el.classList.contains('is-active'),
      box: vis(el),
      iconVis: vis(el.querySelector('.sb__item-icon')),
      labelVis: vis(el.querySelector('.sb__item-label')),
      aria: el.getAttribute('aria-current'),
    })),
    activeItem: (() => {
      const a = items.find((el) => el.classList.contains('is-active'));
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return {
        label: (a.querySelector('.sb__item-label') || {}).textContent || null,
        y: Math.round(r.y),
        h: Math.round(r.height),
      };
    })(),
  });

  // 滑块
  const sl = document.querySelector('.gl-slider');
  log.push({
    step: 'slider',
    present: Boolean(sl),
    cls: sl ? sl.className : null,
    box: vis(sl),
    transform: sl ? getComputedStyle(sl).transform : null,
    inlineStyle: sl ? sl.getAttribute('style') : null,
    indicator: (() => {
      if (!sl) return null;
      const cs = getComputedStyle(sl, '::after');
      return { content: cs.content, width: cs.width, left: cs.left, bg: cs.backgroundColor };
    })(),
  });

  // 导航是否溢出（收起态 10 项 + 4 个空 margin 会不会顶出面板）
  const navBox = nav ? nav.getBoundingClientRect() : null;
  const last = items[items.length - 1];
  log.push({
    step: 'overflow',
    navBottom: navBox ? Math.round(navBox.bottom) : null,
    navScrollH: nav ? nav.scrollHeight : null,
    navClientH: nav ? nav.clientHeight : null,
    lastItemBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
    sbBottom: sb ? Math.round(sb.getBoundingClientRect().bottom) : null,
    lastItemClipped: last ? last.getBoundingClientRect().bottom > (navBox ? navBox.bottom + 1 : Infinity) : null,
  });

  return log;
})()
