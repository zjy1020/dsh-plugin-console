// 滚动更新延迟定位（纯读）：量「改 scrollTop → 窗口真的换段」之间隔了多久，
// 同时统计主线程长任务，判断是监听没触发还是被别的活儿堵住。
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Math.round(performance.now());
  const scroller = (() => {
    const wrap = document.querySelector('.mkt__vwrap');
    let el = wrap ? wrap.parentElement : null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  })();
  const grid = document.querySelector('.mkt__grid');
  const footer = () => document.querySelector('.mkt__more-count')?.innerText ?? null;
  const tf = () => (grid ? getComputedStyle(grid).transform : null);

  const out = { scrollerClass: scroller?.className ?? null, scrollTop: Math.round(scroller.scrollTop) };

  // 长任务统计（没法观察时不报错）
  const longTasks = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) {
    out.longtaskErr = String(e);
  }

  // 滚动事件到底有没有到我这儿（只读监听，插在最前面）
  let scrollEvents = 0;
  scroller.addEventListener('scroll', () => {
    scrollEvents += 1;
  }, { passive: true });

  // 定时器延迟：同一时刻排一个 0ms 定时器，看它什么时候轮上
  const t0 = now();
  let timerAt = null;
  setTimeout(() => {
    timerAt = now();
  }, 0);

  const before = tf();
  const beforeFooter = footer();
  scroller.scrollTop = scroller.scrollTop + 60000;
  out.assignAt = now();

  let changeAt = null;
  let footerAt = null;
  const timeline = [];
  for (let i = 0; i < 120; i += 1) {
    await nap(50);
    const t = tf();
    if (changeAt === null && t !== before) changeAt = now();
    if (footerAt === null && footer() !== beforeFooter) footerAt = now();
    if (i % 10 === 0) timeline.push({ t: now() - t0, tf: t, footer: footer() });
    if (changeAt !== null && footerAt !== null) break;
  }

  out.scrollEvents = scrollEvents;
  out.timerDelayMs = timerAt === null ? null : timerAt - t0;
  out.transformChangeMs = changeAt === null ? null : changeAt - t0;
  out.footerChangeMs = footerAt === null ? null : footerAt - t0;
  out.transformBefore = before;
  out.transformAfter = tf();
  out.footerBefore = beforeFooter;
  out.footerAfter = footer();
  out.cards = document.querySelectorAll('.mkt__card').length;
  out.firstCard = document.querySelector('.mkt__card-name')?.textContent ?? null;
  out.timeline = timeline;
  out.longTasks = longTasks.slice(0, 12);
  out.longTaskTotal = longTasks.reduce((a, b) => a + b, 0);
  if (po) po.disconnect();
  return out;
})();
