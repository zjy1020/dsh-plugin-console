// 滚动更新诊断（纯读）：分开量「scrollTop 赋值本身的耗时」和「定时器延迟」，
// 看卡顿是布局/绘制、主线程被占，还是滚动监听没挂对容器。
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const dom = () => document.getElementsByTagName('*').length;
  const byText = (sel, txt) =>
    [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt));
  const gridTransform = () => {
    const g = document.querySelector('.mkt__grid');
    return g ? getComputedStyle(g).transform : null;
  };
  const firstCard = () => document.querySelector('.mkt__card-name')?.textContent ?? null;

  const out = { hasMarket: Boolean(document.querySelector('.mkt__grid')) };
  if (!out.hasMarket) {
    const installTab = byText('button', '安装插件');
    installTab?.click();
    await nap(200);
    byText('button', '插件市场')?.click();
    await nap(1500);
  }
  out.gridFound = Boolean(document.querySelector('.mkt__grid'));
  if (!out.gridFound) return out;

  // 滚动容器：跟组件里一样的向上找法
  let scroller = null;
  const wrap = document.querySelector('.mkt__vwrap');
  let el = wrap?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) break;
    el = el.parentElement;
  }
  scroller = el;
  out.walkFoundScroller = Boolean(scroller);
  out.walkClass = scroller ? scroller.className : null;
  out.walkScrollHeight = scroller ? scroller.scrollHeight : null;
  if (!scroller) scroller = document.scrollingElement;

  out.transformBefore = gridTransform();
  out.cardsBefore = document.querySelectorAll('.mkt__card').length;
  out.firstCardBefore = firstCard();

  // 1) 赋值耗时
  const t1 = performance.now();
  scroller.scrollTop = scroller.scrollTop + 20000;
  out.assignMs = Math.round(performance.now() - t1);
  out.scrollTopAfterAssign = Math.round(scroller.scrollTop);

  // 2) 定时器延迟（rAF 也量一把，但窗口被遮挡时 rAF 根本不回调，所以必须带超时兜底）
  let t2 = performance.now();
  await nap(220);
  out.napMs = Math.round(performance.now() - t2);
  t2 = performance.now();
  out.rafFired = false;
  await Promise.race([
    new Promise((r) =>
      requestAnimationFrame(() => {
        out.rafFired = true;
        r();
      })
    ),
    nap(1500)
  ]);
  out.rafMs = Math.round(performance.now() - t2);

  // 3) 等窗口跟上
  await nap(1200);
  out.transformAfter = gridTransform();
  out.cardsAfter = document.querySelectorAll('.mkt__card').length;
  out.firstCardAfter = firstCard();

  // 4) 手动派发一次 scroll 再看
  scroller.dispatchEvent(new Event('scroll'));
  await nap(800);
  out.transformAfterManual = gridTransform();
  out.cardsAfterManual = document.querySelectorAll('.mkt__card').length;

  // 5) 有没有被图标请求拖住
  out.cardImgs = document.querySelectorAll('.mkt__card img').length;
  out.imgDecoded = [...document.querySelectorAll('.mkt__card img')].filter((i) => i.complete && i.naturalWidth > 0)
    .length;
  out.monoIcons = document.querySelectorAll('.mkt__card .mkt__icon--mono').length;
  const res = performance.getEntriesByType('resource').filter((r) => /raw\.githubusercontent/.test(r.name));
  out.rawRequests = res.length;
  out.rawPending = res.filter((r) => r.responseEnd === 0).length;
  out.dom = dom();
  return out;
})();
