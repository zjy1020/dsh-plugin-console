// 检查「导出清单」按钮的条数与 title 口径（本地路径来源是否已被排除）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(1200);
  const btns = [...document.querySelectorAll('button')];
  const exp = btns.find((b) => (b.textContent || '').trim() === '导出清单');
  const out = {
    found: Boolean(exp),
    title: exp ? exp.title : null,
    disabled: exp ? exp.disabled : null
  };
  // 数一下当前列表里各来源的已装条目
  const rows = [...document.querySelectorAll('.prow')];
  out.rows = rows.length;
  out.badges = {};
  for (const r of rows) {
    const b = r.querySelector('.prow__badge');
    if (b) out.badges[b.textContent.trim()] = (out.badges[b.textContent.trim()] || 0) + 1;
  }
  // 页脚
  const foot = document.querySelector('.plist__foot');
  out.foot = foot ? foot.innerText.replace(/\n+/g, ' | ') : null;
  return out;
})();
