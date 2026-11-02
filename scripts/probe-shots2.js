// 打开「设置」面板并做一次代理测速，dump 结构供截图定位用
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (sel, txt) =>
  [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().includes(txt));

(async () => {
  const out = {};

  const setBtn = byText('button', '设置');
  out.settingsButtonFound = Boolean(setBtn);
  if (setBtn) setBtn.click();
  await sleep(600);

  // 找模态容器：取覆盖层里 textContent 最长的那个
  const overlays = [...document.querySelectorAll('body > div')].filter(
    (d) => getComputedStyle(d).position === 'fixed'
  );
  out.fixedOverlays = overlays.length;
  const modal = overlays.sort((a, b) => b.textContent.length - a.textContent.length)[0] || null;
  out.modalClass = modal ? modal.className : null;

  const scroller = modal || document.body;
  const inputs = [...scroller.querySelectorAll('input')];
  out.inputs = inputs.map((i) => ({
    type: i.type,
    value: i.value,
    placeholder: i.placeholder,
    cls: i.className
  }));

  // 代理输入框：placeholder 或 value 里带 proxy/端口
  const proxyInput = inputs.find((i) => /代理|proxy|端口|host/i.test(i.placeholder || ''));
  out.proxyInputFound = Boolean(proxyInput);
  if (proxyInput) {
    proxyInput.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(proxyInput, '65535');
    proxyInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    out.proxyInputValue = proxyInput.value;
  }

  const testBtn = [...scroller.querySelectorAll('button')].find((b) => /测试/.test(b.textContent || ''));
  out.testButtonFound = Boolean(testBtn);
  if (testBtn) {
    testBtn.click();
    await sleep(3000);
  }

  const resultEl = scroller.querySelector('.pxtest--ok, .pxtest--fail');
  out.testResult = resultEl ? resultEl.textContent.trim() : null;
  out.scrollerLen = scroller.textContent.length;
  return out;
})();
