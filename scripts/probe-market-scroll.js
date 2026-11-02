// 滚到底反复触发「再看 N 个」，确认是否会无限增长到 8281 条、以及滚动是否卡
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };

  // 找市场内容的滚动容器
  let scroller = null;
  for (const el of document.querySelectorAll('div, section, ul')) {
    const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40) {
      if (el.querySelector('.mkt__card')) { scroller = el; break; }
    }
  }
  out.scrollerFound = Boolean(scroller);
  if (!scroller) {
    // 退化：直接滚 documentElement
    scroller = document.scrollingElement;
  }
  out.scrollHStart = scroller.scrollHeight;

  const count = () => document.querySelectorAll('.mkt__card').length;
  out.startCards = count();

  const t0 = performance.now();
  for (let i = 0; i < 12; i += 1) {
    scroller.scrollTop = scroller.scrollHeight;
    await nap(600);
    out.steps.push({ i, cards: count(), scrollH: scroller.scrollHeight, dom: document.getElementsByTagName('*').length });
    if (count() >= 8281) break;
  }
  out.scrollLoopMs = Math.round(performance.now() - t0);
  out.endCards = count();
  out.domTotal = document.getElementsByTagName('*').length;

  // 内存（如果可用）
  if (performance.memory) out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
  return out;
})();
