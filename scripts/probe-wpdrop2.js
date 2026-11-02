/* 拖拽覆盖层二次验证
 *
 * 第一版 probe-wpdrop.js 在派发合成事件后**同步**读 DOM，读到旧状态（overlay:false）。
 * 根因：React 19 的状态更新是异步批处理的，事件派发完当前 tick 里 DOM 还没提交。
 * 这一版在每个阶段后 await 两帧 + 一点点真实时间，再读。
 *
 * 注意：CDP 合成 DragEvent 拿不到真实文件路径（webUtils.getPathForFile 返回空），
 * 所以这里只能验证「覆盖层 + 有效/无效态 + 预览面板」的渲染，
 * **导入写入链路必须靠真实人工拖拽验证**，脚本验证不了。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = async (n = 2) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => requestAnimationFrame(() => r()));
  };

  const read = (tag) => {
    const el = document.querySelector('.wpdrop');
    if (!el) return { tag, overlay: false };
    const cs = getComputedStyle(el);
    const title = el.querySelector('.wpdrop__title');
    const sub = el.querySelector('.wpdrop__sub');
    const frame = el.querySelector('.wpdrop__frame');
    return {
      tag,
      overlay: true,
      cls: el.className,
      valid: el.classList.contains('is-valid'),
      title: title ? title.textContent : null,
      sub: sub ? sub.textContent : null,
      frameBorder: frame ? getComputedStyle(frame).borderTopColor : null,
      backdrop: cs.background.slice(0, 60),
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
    };
  };

  const mkDt = (withFile, type) => {
    const dt = new DataTransfer();
    if (withFile) {
      // 造一个「看起来像图片」的文件，只为让 is-valid 判定走图片分支
      const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', { type: 'image/png' });
      dt.items.add(f);
    }
    Object.defineProperty(dt, 'types', { value: withFile ? ['Files'] : [type || 'text/plain'] });
    return dt;
  };

  const fire = (target, type, dt) => {
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(ev);
  };

  const out = [];
  const host = document.querySelector('.app') || document.body;

  out.push(read('初始'));

  // ① 拖入非文件内容 → 应保持不出现（或出现但非 valid）
  fire(host, 'dragenter', mkDt(false, 'text/plain'));
  await frames(2);
  await sleep(60);
  out.push(read('dragenter:text'));

  // 清干净
  fire(host, 'dragleave', mkDt(false, 'text/plain'));
  await frames(2);
  await sleep(60);

  // ② 拖入文件 → 应出现覆盖层
  const dtFile = mkDt(true);
  fire(host, 'dragenter', dtFile);
  await frames(2);
  await sleep(80);
  out.push(read('dragenter:file'));

  fire(host, 'dragover', dtFile);
  await frames(2);
  await sleep(80);
  out.push(read('dragover:file'));

  // ③ 离开 → 覆盖层应消失
  fire(host, 'dragleave', dtFile);
  await frames(2);
  await sleep(120);
  out.push(read('dragleave'));

  // ④ 直接落盘（合成事件，拿不到真实路径）→ 看错误条会不会出现
  fire(host, 'drop', dtFile);
  await frames(2);
  await sleep(400);
  const err = document.querySelector('.wpdroperr');
  out.push({
    tag: 'drop',
    errVisible: Boolean(err),
    errText: err ? err.textContent : null,
  });

  // ⑤ 预览面板（正常情况下此时不该存在）
  const prev = document.querySelector('.wpprev');
  out.push({ tag: 'preview', present: Boolean(prev) });

  return { stages: out, viewport: { w: innerWidth, h: innerHeight } };
})()
