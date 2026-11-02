/*
 * sb-verify-B.js —— 复验 bug B：收起态（64px）里 logo 必须在条带内容盒的正中心，展开箭头不能消失。
 *
 * 前置：应用带 --remote-debugging-port=9333 运行（重启后的新构建）。
 * 跑法：node scripts/cdp-eval.mjs --file %TEMP%\sb-verify-B.js
 *
 * 断言链：
 *   1) 记下原展开态并把展开态的品牌区几何存成基线
 *   2) 切到收起态：|logo 中心 x - .sb 内容盒中心 x| ≤ 0.5px
 *   3) 收起态展开箭头仍在：width>0、height>0、opacity≠0、pointer-events≠none，
 *      并且 elementFromPoint(中心) 命中的就是它自己（真能点，不只是"在 DOM 里"）
 *   4) 收起态导航项图标仍居中（|图标中心 - 内容盒中心| ≤ 0.5px）
 *   5) 切回展开态：品牌区仍是 row / gap 10 / 高 52、logo 与箭头同一水平线、产品名可见
 *   6) 还原：sidebarExpanded 回到原值
 * 全流程用 setTimeout，不用 requestAnimationFrame —— 窗口被遮挡时 rAF 不触发，会把脚本挂死。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = [];
  const log = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });
  const R = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2),
      cx: +(b.x + b.width / 2).toFixed(2), cy: +(b.y + b.height / 2).toFixed(2),
    };
  };
  const contentBox = (sb) => {
    const b = sb.getBoundingClientRect();
    const cs = getComputedStyle(sb);
    const left = b.left + parseFloat(cs.borderLeftWidth);
    const right = b.right - parseFloat(cs.borderRightWidth);
    return { left: +left.toFixed(2), right: +right.toFixed(2), center: +((left + right) / 2).toFixed(2), w: +(right - left).toFixed(2) };
  };

  const before = await window.dsh.settingsGet();
  const out = { expandedBefore: before.sidebarExpanded, steps };
  const sb = document.querySelector('.sb');
  let toggled = false;

  try {
    const expandedBaseline = {
      brand: R(document.querySelector('.sb__brand')),
      logo: R(document.querySelector('.sb__logo')),
      collapse: R(document.querySelector('.sb__collapse')),
      brandFlex: getComputedStyle(document.querySelector('.sb__brand')).flexDirection,
      brandGap: getComputedStyle(document.querySelector('.sb__brand')).gap,
      brandText: R(document.querySelector('.sb__brand-text')),
    };
    out.expandedBaseline = expandedBaseline;

    // 切收起态
    if (before.sidebarExpanded) {
      document.querySelector('.sb__collapse').click();
      toggled = true;
      await sleep(400);
    }

    const collapsedSb = R(sb);
    const cb = contentBox(sb);
    const logo = R(document.querySelector('.sb__logo'));
    const arrowEl = document.querySelector('.sb__collapse');
    const arrow = R(arrowEl);
    const arrowCs = getComputedStyle(arrowEl);
    const hit = document.elementFromPoint(arrow.cx, arrow.cy);
    const item = document.querySelector('.sb__item');
    const icon = R(item ? item.querySelector('svg, img') : null);
    const brandCs = getComputedStyle(document.querySelector('.sb__brand'));

    out.collapsed = {
      sbClass: sb.className,
      sb: collapsedSb,
      contentBox: cb,
      brand: R(document.querySelector('.sb__brand')),
      brandFlex: brandCs.flexDirection,
      brandGap: brandCs.gap,
      brandPadTop: brandCs.paddingTop,
      logo,
      logoDelta: +(logo.cx - cb.center).toFixed(2),
      arrow,
      arrowOpacity: arrowCs.opacity,
      arrowPointerEvents: arrowCs.pointerEvents,
      arrowLabel: arrowEl.getAttribute('aria-label'),
      arrowHitTest: hit ? hit.className : null,
      navItem: R(item),
      navIcon: icon,
      navIconDelta: icon ? +(icon.cx - cb.center).toFixed(2) : null,
      navScroll: (() => { const n = document.querySelector('.sb__nav'); return n ? { clientH: n.clientHeight, scrollH: n.scrollHeight } : null; })(),
      user: R(document.querySelector('.sb__user')),
    };

    log('收起态条带宽 64', collapsedSb.w === 64, collapsedSb);
    log('logo 在内容盒正中（偏差 ≤ 0.5px）', Math.abs(out.collapsed.logoDelta) <= 0.5, {
      logoCx: logo.cx, contentCenter: cb.center, delta: out.collapsed.logoDelta,
    });
    log('展开箭头仍在且可见', !!arrow && arrow.w > 0 && arrow.h > 0 && arrowCs.opacity !== '0' && arrowCs.pointerEvents !== 'none', {
      arrow, opacity: arrowCs.opacity, pointerEvents: arrowCs.pointerEvents,
    });
    log('展开箭头真的点得到（elementFromPoint 命中它）', !!hit && (hit === arrowEl || arrowEl.contains(hit)), {
      hit: hit ? hit.className : null,
    });
    log('收起态导航图标仍居中（偏差 ≤ 0.5px）', icon ? Math.abs(out.collapsed.navIconDelta) <= 0.5 : false, out.collapsed.navIconDelta);
    log('收起态导航没被挤出滚动条', (() => { const n = out.collapsed.navScroll; return !!n && n.clientH === n.scrollH; })(), out.collapsed.navScroll);

    // 切回展开态
    if (toggled) {
      document.querySelector('.sb__collapse').click();
      await sleep(400);
    }

    const brand = document.querySelector('.sb__brand');
    const bcs = getComputedStyle(brand);
    const afterBrand = {
      brand: R(brand),
      logo: R(document.querySelector('.sb__logo')),
      collapse: R(document.querySelector('.sb__collapse')),
      brandFlex: bcs.flexDirection,
      brandGap: bcs.gap,
      brandPadTop: bcs.paddingTop,
      brandText: R(document.querySelector('.sb__brand-text')),
      textContent: (document.querySelector('.sb__brand-text') || {}).textContent,
    };
    out.expandedAfter = afterBrand;

    log('展开态品牌区仍是横排 row / gap 10', bcs.flexDirection === 'row' && bcs.gap === '10px', { flex: bcs.flexDirection, gap: bcs.gap });
    log('展开态 logo 几何与基线一致', afterBrand.logo.x === expandedBaseline.logo.x && afterBrand.logo.y === expandedBaseline.logo.y, {
      now: afterBrand.logo, baseline: expandedBaseline.logo,
    });
    log('展开态产品名与箭头都在同一水平线', (() => {
      return !!afterBrand.brandText && afterBrand.brandText.w > 0 &&
        Math.abs(afterBrand.logo.cy - afterBrand.collapse.cy) <= 0.5 && Math.abs(afterBrand.brandText.cy - afterBrand.logo.cy) <= 0.5;
    })(), { brandText: afterBrand.brandText, logoCy: afterBrand.logo.cy, arrowCy: afterBrand.collapse.cy });
  } catch (e) {
    log('脚本异常', false, String(e && e.message ? e.message : e));
  } finally {
    const after = await window.dsh.settingsGet();
    out.expandedAfter2 = after.sidebarExpanded;
    log('展开态已还原', after.sidebarExpanded === before.sidebarExpanded, {
      before: before.sidebarExpanded, after: after.sidebarExpanded,
    });
    out.pass = steps.every((s) => s.ok);
    out.failed = steps.filter((s) => !s.ok).map((s) => s.name);
  }
  return JSON.stringify(out);
})()
