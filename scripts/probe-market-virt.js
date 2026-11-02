// 虚拟滚动验收探针（纯读，不改数据）：
//   首屏可交互时间 / 首屏 DOM 增量 / 连续滚到底 DOM 是否增长 / 滚动中是否出现空白 /
//   搜索与换分类的响应时间 / 卡片数与滚动高度上限
(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const dom = () => document.getElementsByTagName('*').length;
  const cards = () => document.querySelectorAll('.mkt__card').length;
  // 骨架卡也用 .mkt__card，所以「真实卡片出现」用 .mkt__card-name（骨架里没有）来判定
  const realCards = () => document.querySelectorAll('.mkt__card-name').length;
  const byText = (sel, txt) =>
    [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt));
  const setVal = (el, v) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const footerText = () => document.querySelector('.mkt__more-count')?.innerText ?? null;

  const out = { domBase: dom() };

  const installTab = byText('button', '安装插件');
  if (!installTab) return Object.assign(out, { error: '没找到「安装插件」入口' });
  installTab.click();
  await nap(200);

  const mktTab = byText('button', '插件市场');
  if (!mktTab) return Object.assign(out, { error: '没找到「插件市场」tab' });

  // ---- 首屏 ----
  const t0 = performance.now();
  mktTab.click();
  let skeletonMs = null;
  let firstCardMs = null;
  for (let i = 0; i < 600; i += 1) {
    if (skeletonMs === null && cards() > 0) skeletonMs = Math.round(performance.now() - t0);
    if (realCards() > 0) {
      firstCardMs = Math.round(performance.now() - t0);
      break;
    }
    await nap(20);
  }
  await nap(500);
  out.skeletonMs = skeletonMs;
  out.firstCardMs = firstCardMs;
  out.interactiveMs = Math.round(performance.now() - t0);
  out.cardsAfterOpen = cards();
  out.domAfterOpen = dom();
  out.domAfterOpenDelta = out.domAfterOpen - out.domBase;
  out.status = document.querySelector('.mkt__status')?.innerText ?? null;
  out.footer = footerText();
  out.cardH = (() => {
    const c = document.querySelector('.mkt__card');
    return c ? Math.round(c.getBoundingClientRect().height) : null;
  })();
  out.rowH = (() => {
    const cs = getComputedStyle(document.querySelector('.mkt__grid') || document.body);
    const card = out.cardH ?? 0;
    return Math.round(card + (Number.parseFloat(cs.rowGap) || 0));
  })();
  out.gridH = (() => {
    const w = document.querySelector('.mkt__vwrap');
    return w ? Math.round(w.getBoundingClientRect().height) : null;
  })();
  // 空图标盒 / 首字母盒统计
  out.iconImg = document.querySelectorAll('.mkt__card .mkt__icon--img').length;
  out.iconMono = document.querySelectorAll('.mkt__card .mkt__icon--mono').length;

  // ---- 目录 icon 字段交叉核对：默认排序下前 48 条里有多少条带了 icon ----
  let catalog = null;
  try {
    catalog = await window.dsh.marketList();
    const top = (catalog.plugins || [])
      .slice()
      .sort((a, b) => (b.stars || 0) - (a.stars || 0))
      .slice(0, 48);
    out.top48 = top.length;
    out.top48WithIcon = top.filter((e) => e.icon).length;
    out.iconSampleUrl = (top.find((e) => e.icon) || {}).icon || null;
    if (out.iconSampleUrl) {
      const img = new Image();
      out.iconSampleResult = await new Promise((r) => {
        img.onload = () => r('load');
        img.onerror = () => r('error');
        setTimeout(() => r('timeout'), 4000);
        img.src = out.iconSampleUrl;
      });
    }
  } catch (e) {
    out.iconCheckErr = String(e);
  }

  // ---- 首屏图标的真实解码数（等一会让懒加载的图有机会回来）----
  await nap(3000);
  const imgs = [...document.querySelectorAll('.mkt__card .mkt__icon--img')];
  out.iconImgAfterWait = imgs.length;
  out.iconDecoded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
  out.iconMonoAfterWait = document.querySelectorAll('.mkt__card .mkt__icon--mono').length;

  // ---- 「按仓库地址猜图标」的命中率单独在 probe-market-guess.js 里量（它自己会发很多请求，
  //      混在这一轮会把滚动耗时的测量结果带脏）----

  // ---- 找滚动容器 ----
  let scroller = null;
  for (const el of document.querySelectorAll('div, section, ul')) {
    const cs = getComputedStyle(el);
    if (
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 40 &&
      el.querySelector('.mkt__card')
    ) {
      scroller = el;
      break;
    }
  }
  out.scrollerFound = Boolean(scroller);
  if (!scroller) scroller = document.scrollingElement;
  out.scrollHeightStart = scroller.scrollHeight;
  out.maxScrollTop = scroller.scrollHeight - scroller.clientHeight;

  const visibleCards = () => {
    const r =
      scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
    let n = 0;
    for (const c of document.querySelectorAll('.mkt__card')) {
      const b = c.getBoundingClientRect();
      if (b.bottom > r.top + 1 && b.top < r.bottom - 1) n += 1;
    }
    return n;
  };

  // ---- 连续滚到底 12 次 ----
  const gridWin = () => document.querySelector('.mkt__grid--win');
  const diag = () => {
    const w = document.querySelector('.mkt__vwrap');
    const c = document.querySelector('.mkt__card');
    const r =
      scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
    return {
      transform: gridWin() ? getComputedStyle(gridWin()).transform : null,
      inlineTransform: gridWin() ? gridWin().style.transform : null,
      wrapTop: w ? Math.round(w.getBoundingClientRect().top) : null,
      wrapH: w ? Math.round(w.getBoundingClientRect().height) : null,
      scrollRect: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
      cardTop: c ? Math.round(c.getBoundingClientRect().top) : null,
      cardBottom: c ? Math.round(c.getBoundingClientRect().bottom) : null,
      cardsInDom: cards()
    };
  };
  out.diagBefore = diag();
  const steps = [];
  const tScroll = performance.now();
  for (let i = 0; i < 12; i += 1) {
    scroller.scrollTop = scroller.scrollHeight;
    await nap(220);
    steps.push({
      i,
      cards: cards(),
      dom: dom(),
      visible: visibleCards(),
      scrollTop: Math.round(scroller.scrollTop),
      pct: Math.round((scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight || 1)) * 100),
      transform: gridWin() ? gridWin().style.transform : null,
      firstCardTop: (() => {
        const c = document.querySelector('.mkt__card');
        return c ? Math.round(c.getBoundingClientRect().top) : null;
      })()
    });
  }
  out.diagAfter = diag();
  out.scrollLoopMs = Math.round(performance.now() - tScroll);
  out.steps = steps;
  out.domEnd = dom();
  out.domGrowth = out.domEnd - out.domAfterOpen;
  out.maxCards = Math.max(out.cardsAfterOpen, ...steps.map((s) => s.cards));
  out.maxDom = Math.max(out.domAfterOpen, ...steps.map((s) => s.dom));
  out.blankSteps = steps.filter((s) => s.visible === 0).map((s) => s.i);
  out.reachedEnd = steps[steps.length - 1].pct >= 99;

  // ---- 回顶部，量搜索 / 换分类 ----
  scroller.scrollTop = 0;
  await nap(250);
  out.cardsBackTop = cards();

  const input = document.querySelector('.mkt__input');
  if (input) {
    const before = footerText();
    const t1 = performance.now();
    setVal(input, 'dshmarket');
    let ms = null;
    for (let i = 0; i < 400; i += 1) {
      if (footerText() !== before) {
        ms = Math.round(performance.now() - t1);
        break;
      }
      await nap(15);
    }
    out.searchMs = ms;
    await nap(200);
    out.searchFooter = footerText();
    out.searchCards = cards();
    const t2 = performance.now();
    setVal(input, '');
    for (let i = 0; i < 400; i += 1) {
      if ((footerText() || '').includes('共 8281')) {
        out.searchClearMs = Math.round(performance.now() - t2);
        break;
      }
      await nap(15);
    }
    await nap(150);
  }

  const sel = document.querySelector('.mkt__select select');
  if (sel) {
    const opt = [...sel.options].find((o) => o.value !== 'all');
    const before = footerText();
    const t3 = performance.now();
    if (opt) {
      setVal(sel, opt.value);
      for (let i = 0; i < 400; i += 1) {
        if (footerText() !== before) {
          out.categoryMs = Math.round(performance.now() - t3);
          break;
        }
        await nap(15);
      }
      await nap(200);
      out.categoryLabel = opt.textContent;
      out.categoryFooter = footerText();
      out.categoryCards = cards();
      out.categoryDom = dom();
      setVal(sel, 'all');
      await nap(250);
    }
  }

  out.domFinal = dom();
  out.cardsFinal = cards();
  return out;
})();
