/* 把界面切到「深色 + 收起态」，用来截图验证两个还没看过的状态。
 * 收起态是设计纲领 §2 明确要求「不能只把文字隐藏掉，要重新设计图标间距和选中效果」的地方。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = async (n = 2) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => requestAnimationFrame(() => r()));
  };

  const log = [];

  // 深色：优先点设置面板里的分段控件（走真实链路），找不到就退回直接改 dataset 做视觉验证
  const segs = Array.from(document.querySelectorAll('.apseg button, .apseg [role="radio"]'));
  log.push({ segCount: segs.length });

  // 先开设置面板
  const gear = document.querySelector('.sb__user .sb__icon-btn:last-of-type')
    || Array.from(document.querySelectorAll('.sb__icon-btn')).pop();
  if (gear) {
    gear.click();
    await frames(3);
    await sleep(260);
  }
  log.push({ dialog: Boolean(document.querySelector('.dialog')) });

  // 找「深色」那个 radio 并点它
  let darkClicked = false;
  for (const el of document.querySelectorAll('.apseg [role="radio"], .apseg button')) {
    if ((el.textContent || '').trim() === '深色') {
      el.click();
      darkClicked = true;
      break;
    }
  }
  await frames(2);
  await sleep(160);
  log.push({ darkClicked, theme: document.documentElement.dataset.theme });

  // 关掉设置面板
  const cancel = Array.from(document.querySelectorAll('.dialog button')).find(
    (b) => (b.textContent || '').trim() === '取消'
  );
  if (cancel) cancel.click();
  await frames(2);
  await sleep(200);
  log.push({ dialogAfter: Boolean(document.querySelector('.dialog')) });

  // 收起侧边栏
  const collapse = document.querySelector('.sb__collapse');
  if (collapse) {
    collapse.click();
    await frames(3);
    await sleep(520);
  }
  const sb = document.querySelector('.sb');
  log.push({
    collapsed: sb ? sb.classList.contains('sb--collapsed') : null,
    sbWidth: sb ? Math.round(sb.getBoundingClientRect().width) : null,
    slider: (() => {
      const s = document.querySelector('.gl-slider');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), cls: s.className };
    })(),
    gapVertical: Boolean(document.querySelector('.gap-strip--v')),
    miniLatency: (() => {
      const e = document.querySelector('.sb__mini-latency');
      return e ? e.textContent : null;
    })(),
  });

  return log;
})()
