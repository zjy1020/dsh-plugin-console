// 排查：虚拟滚动的滚动监听到底挂到了哪个元素上
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const wrap = document.querySelector('.mkt__vwrap');
  out.wrapFound = Boolean(wrap);
  if (!wrap) return out;

  // 祖先链：谁是可滚动容器
  out.ancestors = [];
  let el = wrap.parentElement;
  while (el) {
    const cs = getComputedStyle(el);
    out.ancestors.push({
      tag: el.tagName,
      cls: el.className,
      oy: cs.overflowY,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      scrollable: (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
    });
    el = el.parentElement;
  }

  const first = () => document.querySelector('.mkt__card');
  const read = () => ({
    footer: document.querySelector('.mkt__more-count')?.innerText ?? null,
    cards: document.querySelectorAll('.mkt__card').length,
    transform: first()?.parentElement?.style?.transform ?? null,
    scrollTop: document.querySelector('.install')?.scrollTop ?? null
  });
  out.before = read();

  const scroller = document.querySelector('.install');
  scroller.scrollTop = scroller.scrollHeight / 2;
  await nap(500);
  out.afterHalf = read();
  scroller.scrollTop = scroller.scrollHeight;
  await nap(500);
  out.afterBottom = read();

  // 手动派发一次 scroll，看监听是不是挂在 .install 上
  scroller.dispatchEvent(new Event('scroll'));
  await nap(400);
  out.afterManualScrollEvent = read();

  scroller.scrollTop = 0;
  await nap(500);
  out.afterTop = read();
  return out;
})();
