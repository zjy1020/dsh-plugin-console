/*
 * sb-verify-all.js —— 一次跑完 bug A + bug B 的复验（重启后一条命令）。
 *
 * 前置：应用带 --remote-debugging-port=9333 运行（重启后的新构建）。
 * 跑法：
 *   $root = "D:\项目\DSH\deepseekharness插件台"
 *   $node = "C:\Users\YBY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
 *   & $node "$root\scripts\cdp-eval.mjs" --file "$env:TEMP\sb-verify-all.js"
 *
 * 返回 JSON：{ ok, A: {...}, B: {...} }，各自 steps[] 里 每步 ok/detail；失败项在 failed[]。
 * 设计约束：
 *   · 全流程 setTimeout，不用 requestAnimationFrame —— 窗口被遮挡时 rAF 不触发，会把脚本挂死。
 *   · 每个测试自己 try/finally 还原 sidebarExpanded，跑完不留下折叠态、不留注入样式。
 *   · 结论以实际 DOM 为准；测速那一步依赖 settings.proxy 真能通
 *     （本机现值 http://127.0.0.1:65535 实测 ok:true / hop 9ms / 全链路 1.7s）。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null);
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
  const mk = () => {
    const steps = [];
    return { steps, log: (name, ok, detail) => steps.push({ name, ok: !!ok, detail }) };
  };

  /* ============================ A：刷新入口 ============================ */
  async function testA() {
    const t = mk();
    const out = { steps: t.steps };
    const setExpanded = async (want) => {
      const s = await window.dsh.settingsGet();
      if (s.sidebarExpanded !== want) {
        document.querySelector('.sb__collapse').click();
        await sleep(400);
      }
    };
    const beat = () => document.querySelector('.sb__latency');
    const btn = () => document.querySelector('.sb__refresh');
    const dump = () =>
      Array.from(document.querySelectorAll('.sb__status button, .sb__quick button, .sb__quick-mini button')).map((b) => ({
        cls: b.className,
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        disabled: b.disabled,
      }));

    const before = await window.dsh.settingsGet();
    out.expandedBefore = before.sidebarExpanded;
    out.proxy = before.proxy;
    try {
      await setExpanded(true);

      out.buttonsBefore = dump();
      out.latencyBefore = clean(beat());
      t.log('延迟行存在', !!beat(), out.latencyBefore);
      t.log('刷新按钮存在', !!btn(), btn() ? btn().className : null);
      if (!btn()) throw new Error('没有 .sb__refresh —— 跑的是旧构建？');

      const clickAt = Date.now();
      btn().click();

      let seen = false, firstSeenMs = null, snap = null;
      while (Date.now() - clickAt < 1200) {
        const b = btn();
        const txt = clean(beat()) || '';
        const spinning = !!document.querySelector('.sb__refresh .spinner');
        if ((b && b.disabled) || spinning || txt.includes('测试中')) {
          seen = true; firstSeenMs = Date.now() - clickAt;
          snap = { latency: txt, disabled: !!(b && b.disabled), spinning, flag: !!document.querySelector('.sb__latency-flag') };
          break;
        }
        await sleep(50);
      }
      t.log('点后出现「测试中」状态', seen, { firstSeenMs, ...snap });

      const rest = 4000 - (Date.now() - clickAt);
      if (rest > 0) await sleep(rest);
      out.latencyAfter = clean(beat());
      out.latencyTitle = beat() ? beat().getAttribute('title') : null;
      out.buttonsAfter = dump();

      t.log('读数带数字（\\d+ ms）', /\d+\s*ms/.test(out.latencyAfter || ''), out.latencyAfter);
      t.log('不再有 .sb__latency-test 按钮', document.querySelector('.sb__latency-test') === null, {
        count: document.querySelectorAll('.sb__latency-test').length,
      });
      const bare = Array.from(document.querySelectorAll('.sb__status button')).filter((b) => (b.textContent || '').trim() === '测');
      t.log('延迟行没有文字恰为「测」的按钮', bare.length === 0, { count: bare.length });
      t.log('测完刷新按钮恢复可点', (() => { const b = btn(); return !!b && !b.disabled; })());
      t.log('延迟行只剩 1 枚按钮', document.querySelectorAll('.sb__status-row--sub button').length === 1, {
        count: document.querySelectorAll('.sb__status-row--sub button').length,
      });
    } catch (e) {
      t.log('脚本异常', false, String(e && e.message ? e.message : e));
    } finally {
      // 还原成脚本开始前的那个状态（默认就是展开；万一跑之前是收起态，也要收回去）
      const s = await window.dsh.settingsGet();
      if (s.sidebarExpanded !== before.sidebarExpanded && document.querySelector('.sb__collapse')) {
        document.querySelector('.sb__collapse').click();
        await sleep(450);
      }
      const after = await window.dsh.settingsGet();
      out.expandedAfter = after.sidebarExpanded;
      t.log('展开态已还原', after.sidebarExpanded === before.sidebarExpanded, { before: before.sidebarExpanded, after: after.sidebarExpanded });
      out.pass = t.steps.every((s2) => s2.ok);
      out.failed = t.steps.filter((s2) => !s2.ok).map((s2) => s2.name);
    }
    return out;
  }

  /* ============================ B：收起态居中 ============================ */
  async function testB() {
    const t = mk();
    const out = { steps: t.steps };
    const before = await window.dsh.settingsGet();
    out.expandedBefore = before.sidebarExpanded;
    const sb = document.querySelector('.sb');
    let toggled = false;
    try {
      const base = {
        logo: R(document.querySelector('.sb__logo')),
        arrow: R(document.querySelector('.sb__collapse')),
        flex: getComputedStyle(document.querySelector('.sb__brand')).flexDirection,
        gap: getComputedStyle(document.querySelector('.sb__brand')).gap,
      };
      out.expandedBaseline = base;

      if (before.sidebarExpanded) {
        document.querySelector('.sb__collapse').click();
        toggled = true;
        await sleep(450);
      }

      const cb = contentBox(sb);
      const logo = R(document.querySelector('.sb__logo'));
      const arrowEl = document.querySelector('.sb__collapse');
      const arrow = R(arrowEl);
      const acs = getComputedStyle(arrowEl);
      const hit = document.elementFromPoint(arrow.cx, arrow.cy);
      const icon = R((document.querySelector('.sb__item') || {}).querySelector?.('svg, img') || null);
      const bcs = getComputedStyle(document.querySelector('.sb__brand'));

      out.collapsed = {
        sbClass: sb.className,
        sb: R(sb),
        contentBox: cb,
        brand: R(document.querySelector('.sb__brand')),
        brandFlex: bcs.flexDirection,
        brandGap: bcs.gap,
        brandPadTop: bcs.paddingTop,
        logo,
        logoDelta: +(logo.cx - cb.center).toFixed(2),
        arrow,
        arrowOpacity: acs.opacity,
        arrowPointerEvents: acs.pointerEvents,
        arrowLabel: arrowEl.getAttribute('aria-label'),
        arrowHit: hit ? hit.className : null,
        navIcon: icon,
        navIconDelta: icon ? +(icon.cx - cb.center).toFixed(2) : null,
        navScroll: (() => { const n = document.querySelector('.sb__nav'); return n ? { clientH: n.clientHeight, scrollH: n.scrollHeight } : null; })(),
        user: R(document.querySelector('.sb__user')),
      };

      t.log('收起态条带宽 64', R(sb).w === 64, R(sb));
      t.log('logo 在内容盒正中（偏差 ≤ 0.5px）', Math.abs(out.collapsed.logoDelta) <= 0.5, {
        logoCx: logo.cx, contentCenter: cb.center, delta: out.collapsed.logoDelta,
      });
      t.log('logo 的 y 与展开态一致（顶部光学留白不变）', logo.y === base.logo.y, { collapsed: logo.y, expanded: base.logo.y });
      t.log('展开箭头仍在且可见', !!arrow && arrow.w > 0 && arrow.h > 0 && acs.opacity !== '0' && acs.pointerEvents !== 'none', {
        arrow, opacity: acs.opacity, pointerEvents: acs.pointerEvents,
      });
      t.log('展开箭头真的点得到（elementFromPoint 命中它）', !!hit && (hit === arrowEl || arrowEl.contains(hit)), { hit: hit ? hit.className : null });
      t.log('收起态导航图标仍居中（偏差 ≤ 0.5px）', !!icon && Math.abs(out.collapsed.navIconDelta) <= 0.5, out.collapsed.navIconDelta);
      t.log('收起态导航没被挤出滚动条', (() => { const n = out.collapsed.navScroll; return !!n && n.clientH === n.scrollH; })(), out.collapsed.navScroll);

      if (toggled) {
        document.querySelector('.sb__collapse').click();
        await sleep(450);
      }
      const after = {
        logo: R(document.querySelector('.sb__logo')),
        arrow: R(document.querySelector('.sb__collapse')),
        brandText: R(document.querySelector('.sb__brand-text')),
        text: clean(document.querySelector('.sb__brand-text')),
        flex: getComputedStyle(document.querySelector('.sb__brand')).flexDirection,
        gap: getComputedStyle(document.querySelector('.sb__brand')).gap,
      };
      out.expandedAfter = after;
      t.log('展开态品牌区仍是 row / gap 10', after.flex === 'row' && after.gap === '10px', { flex: after.flex, gap: after.gap });
      t.log('展开态 logo 几何与基线一致', after.logo.x === base.logo.x && after.logo.y === base.logo.y, { now: after.logo, baseline: base.logo });
      t.log('展开态「logo + 产品名 + 箭头」同一水平线', (() => {
        return !!after.brandText && after.brandText.w > 0 &&
          Math.abs(after.logo.cy - after.arrow.cy) <= 0.5 && Math.abs(after.brandText.cy - after.logo.cy) <= 0.5;
      })(), { brandText: after.brandText, logoCy: after.logo.cy, arrowCy: after.arrow.cy });
    } catch (e) {
      t.log('脚本异常', false, String(e && e.message ? e.message : e));
    } finally {
      const now = await window.dsh.settingsGet();
      if (now.sidebarExpanded !== before.sidebarExpanded) {
        const btn = document.querySelector('.sb__collapse');
        if (btn) btn.click();
        await sleep(450);
      }
      const after = await window.dsh.settingsGet();
      out.expandedAfter2 = after.sidebarExpanded;
      t.log('展开态已还原', after.sidebarExpanded === before.sidebarExpanded, { before: before.sidebarExpanded, after: after.sidebarExpanded });
      out.pass = t.steps.every((s) => s.ok);
      out.failed = t.steps.filter((s) => !s.ok).map((s) => s.name);
    }
    return out;
  }

  /* ============================ 跑 ============================ */
  const A = await testA();
  const B = await testB();
  return JSON.stringify(
    {
      ok: A.pass && B.pass,
      failed: [...A.failed.map((f) => `A:${f}`), ...B.failed.map((f) => `B:${f}`)],
      A,
      B,
    },
    null,
    2
  );
})()
