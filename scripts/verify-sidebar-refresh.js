/*
 * sb-verify-A.js —— 复验 bug A：侧栏里关于「代理速度」只剩一个刷新入口，且它真的会重新测速。
 *
 * 前置：应用带 --remote-debugging-port=9333 运行（重启后的新构建）。
 * 跑法：node scripts/cdp-eval.mjs --file %TEMP%\sb-verify-A.js
 *
 * 断言链（与主控给的验收条件一一对应）：
 *   1) 记录点之前的 .sb__latency 行文本
 *   2) 点 .sb__refresh
 *   3) ≤1000ms 内必须看到「测试中」状态（文案含「测试中」/ 按钮带 .spinner / 按钮 disabled）
 *   4) 点后 4s：读数带数字（\d+ ms），且 .sb__latency-test === null
 *   5) 延迟行里不存在文字恰为「测」的按钮
 *   6) 还原：侧栏展开态回到原值（不写任何持久化状态）
 * 全流程用 setTimeout，不用 requestAnimationFrame —— 窗口被遮挡时 rAF 不触发，会把脚本挂死。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const steps = [];
  const log = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });
  const clean = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null);
  const rhythm = () => document.querySelector('.sb__latency');
  const refresh = () => document.querySelector('.sb__refresh');

  const dumpButtons = () =>
    Array.from(document.querySelectorAll('.sb__status button, .sb__quick button, .sb__quick-mini button')).map((b) => ({
      cls: b.className,
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      disabled: b.disabled,
    }));

  const before = await window.dsh.settingsGet();
  const out = { expandedBefore: before.sidebarExpanded, proxy: before.proxy, steps };
  let expandedByMe = false;

  try {
    // 0) 保证在展开态（延迟行整块只在 !isCollapsed 时渲染）
    if (!before.sidebarExpanded) {
      document.querySelector('.sb__collapse').click();
      expandedByMe = true;
      await sleep(350);
    }
    out.buttonsBefore = dumpButtons();
    out.latencyBefore = clean(rhythm());
    log('延迟行存在', !!rhythm(), out.latencyBefore);
    log('刷新按钮存在', !!refresh(), refresh() ? refresh().className : null);

    // 1) 点刷新
    if (!refresh()) throw new Error('没有 .sb__refresh，跑的是旧构建？');
    const clickAt = Date.now();
    refresh().click();

    // 2) 轮询「测试中」（真代理约 1.7s，实测 latencyMs 9 / totalMs 1719）
    let seenTesting = false;
    let firstSeenMs = null;
    let testingSnapshot = null;
    while (Date.now() - clickAt < 1200) {
      const btn = refresh();
      const txt = clean(rhythm()) || '';
      const spinning = !!document.querySelector('.sb__refresh .spinner');
      if ((btn && btn.disabled) || spinning || txt.includes('测试中')) {
        seenTesting = true;
        firstSeenMs = Date.now() - clickAt;
        testingSnapshot = { latency: txt, disabled: !!(btn && btn.disabled), spinning, flag: !!document.querySelector('.sb__latency-flag') };
        break;
      }
      await sleep(50);
    }
    log('点后出现「测试中」状态', seenTesting, { firstSeenMs, ...testingSnapshot });

    // 3) 等满 4s 收尾读数
    const rest = 4000 - (Date.now() - clickAt);
    if (rest > 0) await sleep(rest);
    out.latencyAfter = clean(rhythm());
    out.buttonsAfter = dumpButtons();
    out.latencyTitle = rhythm() ? rhythm().getAttribute('title') : null;
    log('读数带数字（\\d+ ms）', /\d+\s*ms/.test(out.latencyAfter || ''), out.latencyAfter);
    log('不再有 .sb__latency-test 按钮', document.querySelector('.sb__latency-test') === null, {
      count: document.querySelectorAll('.sb__latency-test').length,
    });
    const bare = Array.from(document.querySelectorAll('.sb__status button')).filter(
      (b) => (b.textContent || '').trim() === '测'
    );
    log('延迟行没有文字恰为「测」的按钮', bare.length === 0, { count: bare.length });
    log('测试结束后刷新按钮恢复可点', (() => { const b = refresh(); return !!b && !b.disabled; })());
  } catch (e) {
    log('脚本异常', false, String(e && e.message ? e.message : e));
  } finally {
    if (expandedByMe) {
      const btn = document.querySelector('.sb__collapse');
      if (btn) btn.click();
      await sleep(350);
    }
    const after = await window.dsh.settingsGet();
    out.expandedAfter = after.sidebarExpanded;
    log('展开态已还原', after.sidebarExpanded === before.sidebarExpanded, {
      before: before.sidebarExpanded,
      after: after.sidebarExpanded,
    });
    out.elapsedMs = Date.now() - t0;
    out.pass = steps.every((s) => s.ok);
    out.failed = steps.filter((s) => !s.ok).map((s) => s.name);
  }
  return JSON.stringify(out);
})()
