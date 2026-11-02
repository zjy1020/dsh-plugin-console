// 对比实验（纯读，只在页面里临时改一处 inline 样式，reload 就恢复）：
// 窗口跟不跟得上，是不是被「352k 高的滚动容器 + 被提升的 transform 图层」拖的。
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Math.round(performance.now());
  const wrap = document.querySelector('.mkt__vwrap');
  const grid = document.querySelector('.mkt__grid');
  let scroller = wrap ? wrap.parentElement : null;
  while (scroller) {
    const oy = getComputedStyle(scroller).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (!grid || !scroller) return { error: 'market 没开着' };

  const tf = () => getComputedStyle(grid).transform;
  const measure = async (delta, label) => {
    const before = tf();
    const t0 = now();
    let napMs = [];
    scroller.scrollTop = scroller.scrollTop + delta;
    let changeMs = null;
    for (let i = 0; i < 100; i += 1) {
      const t = now();
      await nap(100);
      napMs.push(now() - t);
      if (changeMs === null && tf() !== before) {
        changeMs = now() - t0;
        break;
      }
    }
    return {
      label,
      changeMs,
      avgNapMs: Math.round(napMs.reduce((a, b) => a + b, 0) / Math.max(1, napMs.length)),
      transform: tf()
    };
  };

  const out = { willChangeBefore: getComputedStyle(grid).willChange, gridH: grid.offsetHeight, wrapH: wrap.offsetHeight };
  out.a_default = await measure(20000, 'default');

  // 拆掉图层提升再试一次
  grid.style.willChange = 'auto';
  out.willChangeAfter = getComputedStyle(grid).willChange;
  out.b_noWillChange = await measure(20000, 'will-change:auto');

  // 再把 transform 换成 top 定位试一次
  grid.style.willChange = 'auto';
  const offset = grid.style.transform; // translateY(x)
  out.transformInline = offset;
  out.cards = document.querySelectorAll('.mkt__card').length;
  out.cardImgs = document.querySelectorAll('.mkt__card img').length;
  out.dom = document.getElementsByTagName('*').length;
  grid.style.transform = '';
  grid.style.willChange = 'auto';
  out.c_topMode = await measure(20000, 'transform 清空（靠文档流）');

  return out;
})();
