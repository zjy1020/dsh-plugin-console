// 打开「安装插件」→「导入清单」tab，粘贴一份清单，dump 预览结果
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (sel, txt) =>
  [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt));

const SAMPLE = JSON.stringify(
  {
    version: 1,
    profile: 'desktop',
    dshVersion: '0.2.1-rc.5',
    generatedAt: '2026-11-02T04:00:00.000Z',
    plugins: [
      { name: 'dsh-context', spec: 'dsh-context@0.78.1', sourceKind: 'npm', version: '0.78.1' },
      { name: 'dsh-music-player', spec: 'dsh-music-player@1.0.3', sourceKind: 'npm', version: '1.0.3' },
      { name: 'dsh-pet', spec: 'dsh-pet@0.3.8', sourceKind: 'npm', version: '0.3.8' },
      { name: 'dsh-not-installed-xyz', spec: 'dsh-not-installed-xyz@1.0.0', sourceKind: 'npm', version: '1.0.0' },
      { name: 'dsh-also-missing-abc', spec: 'dsh-also-missing-abc@2.0.0', sourceKind: 'npm', version: '2.0.0' }
    ]
  },
  null,
  2
);

(async () => {
  const out = {};

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

  // 切到「安装插件」
  const installTab = byText('button', '安装插件') || byText('[role="tab"]', '安装插件');
  out.installTabFound = Boolean(installTab);
  installTab?.click();
  await sleep(500);

  // 切到「导入清单」子 tab
  const subTabs = [...document.querySelectorAll('button, [role="tab"]')];
  out.subTabLabels = subTabs.map((t) => (t.textContent || '').trim()).filter((t) => t.length > 0 && t.length < 12);
  const importTab = subTabs.find((t) => (t.textContent || '').trim().startsWith('导入清单'));
  out.importTabFound = Boolean(importTab);
  importTab?.click();
  await sleep(500);

  const ta = document.querySelector('textarea');
  out.textareaFound = Boolean(ta);
  if (ta) {
    ta.focus();
    setter.call(ta, SAMPLE);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await sleep(1800); // 等 500ms 防抖 + IPC

  const preview = document.querySelector('.install__preview');
  out.previewText = preview ? preview.innerText.replace(/\n+/g, ' | ').slice(0, 900) : null;

  const installBtn = [...document.querySelectorAll('button')].find((b) => /^安装\s*\d+\s*个/.test((b.textContent || '').trim()));
  out.installButtonLabel = installBtn ? installBtn.textContent.trim() : null;
  out.bodyLen = document.body.textContent.length;
  return out;
})();
