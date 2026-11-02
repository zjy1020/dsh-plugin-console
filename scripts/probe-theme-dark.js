/* 主题 × 深浅模式 的交叉验证。
 *
 * 关心的问题：现有 ThemeSpec 的材质参数只有一套（不是 design-v3.md §4 给的深浅两套）。
 * 如果一套参数在两种模式下都直接套用，那么在浅色模式下应用一套为深色调的材质，
 * 就会出现「浅色界面 + 深色玻璃」的错配。这一版把状态切过去，量实际的 CSS 变量值。
 *
 * 全程只读 + 点真实控件，最后会把模式切回浅色。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = async (n = 3) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => requestAnimationFrame(() => r()));
  };
  const byText = (sel, txt) =>
    Array.from(document.querySelectorAll(sel)).find((el) => (el.textContent || '').trim() === txt);
  const snap = (tag) => {
    const cs = getComputedStyle(document.documentElement);
    const vars = [
      '--gl-panel-blur',
      '--gl-panel-sat',
      '--gl-panel-lum',
      '--gl-noise',
      '--p-brand',
      '--p-brand-10',
      '--bg-0',
      '--bg-1',
      '--fg-0',
      '--fg-1',
    ];
    const o = { tag, theme: document.documentElement.dataset.theme, material: document.documentElement.dataset.material };
    for (const v of vars) o[v] = cs.getPropertyValue(v).trim();
    // 主区实际的背景与模糊
    const main = document.querySelector('.app__main');
    if (main) {
      const m = getComputedStyle(main);
      o.mainBg = m.backgroundColor;
      o.mainBackdrop = (m.backdropFilter || m.webkitBackdropFilter || '').slice(0, 70);
    }
    return o;
  };

  const log = [];
  log.push(snap('起始'));

  // 开设置
  const gear = Array.from(document.querySelectorAll('.sb__icon-btn')).pop();
  if (gear) {
    gear.click();
    await frames(3);
    await sleep(300);
  }

  // 跳到主题分区：直接应用第一张内置主题卡（「应用」按钮）
  const themeCards = Array.from(document.querySelectorAll('.aptheme__card, .aptheme'));
  log.push({ themeCards: themeCards.length });
  const applyBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
    (b.textContent || '').trim() === '应用'
  );
  log.push({ applyBtnCount: applyBtns.length });
  if (applyBtns.length) {
    applyBtns[0].click();
    await frames(3);
    await sleep(420);
  }
  log.push(snap('应用主题后（草稿，未保存）'));

  // 深色
  const darkSeg = byText('.apseg button, .apseg [role="radio"], .apseg span', '深色');
  if (darkSeg) {
    darkSeg.click();
    await frames(3);
    await sleep(320);
  }
  log.push({ darkSegFound: Boolean(darkSeg) });
  log.push(snap('切到深色后（草稿）'));

  // 直接看 DOM 上的 data-theme（草稿态通常不生效，只有保存后才改）
  log.push({ dataThemeNow: document.documentElement.dataset.theme });

  // 保存
  const save = byText('.dialog button, .dialog__foot button', '保存');
  if (save) {
    save.click();
    await frames(3);
    await sleep(900);
  }
  log.push({ saveFound: Boolean(save) });
  log.push(snap('保存后'));

  return log;
})()
