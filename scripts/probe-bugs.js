/**
 * probe-bugs.js —— 一次性核验 Master 报的六条 bug 是否真的修好。
 *
 * 用法（应用须带 --remote-debugging-port=9333 启动）：
 *   node scripts/cdp-eval.mjs --file scripts/probe-bugs.js
 *
 * 为什么写成一个大脚本而不是六个：每一条都要先把界面带到特定状态（开详情面板 /
 * 开设置面板 / 点延迟测试），分开跑就得反复开关面板，反而更容易测出错帧。
 * 这里按 A→B→C→D 的顺序各测一遍，每一步结束都尽量把界面还原。
 *
 * 每条都写清「判定通过的条件」，不通过时把原始数字一起带出来 —— 只报 true/false
 * 等于让我再猜一遍。
 */
;(async () => {
  const out = { ok: true, sections: {} }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const r2 = (n) => (typeof n === 'number' ? +n.toFixed(2) : n)
  const rect = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: r2(b.x), y: r2(b.y), w: r2(b.width), h: r2(b.height) }
  }
  const byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find((el) => (el.textContent || '').includes(text)) || null
  const setNativeValue = (el, value) => {
    // React 在 input 上挂了 value 追踪器，直接 el.value = x 会被判成「没变」而不触发 onChange
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /* ---------------------------------------------------------------- A. 布局 */
  try {
    const se = document.scrollingElement
    const titlebar = document.querySelector('.titlebar')
    const controls = [...(document.querySelectorAll('.titlebar__controls > *') || [])]
    const tbImg = document.querySelector('.titlebar__brand img')
    const sbImg = document.querySelector('.sb__logo img')
    const sb = document.querySelector('.sb')
    const sbBrand = document.querySelector('.sb__brand')
    const sbUser = document.querySelector('.sb__user')
    const sbStatus = document.querySelector('.sb__status')
    const ticks = [...(document.querySelectorAll('.gap-strip .gap-strip__tick') || [])]

    const tickH = ticks.map((t) => r2(t.getBoundingClientRect().height))
    const loadedH = tickH.slice(0, 12)
    const gapH = tickH.slice(12)
    const allSameH = new Set(tickH.map((h) => Math.round(h))).size === 1

    out.sections.layout = {
      // bug 5：标题栏与三个窗口按钮必须整块可见
      scroll: {
        scrollTop: r2(se.scrollTop),
        scrollHeight: se.scrollHeight,
        clientHeight: se.clientHeight,
        canScroll: se.scrollHeight > se.clientHeight
      },
      titlebar: rect(titlebar),
      windowControls: controls.map((c) => rect(c)),
      controlsAllVisible:
        controls.length === 3 && controls.every((c) => c.getBoundingClientRect().y >= 0),
      // bug 2：两处 20×20 logo 的左沿应落在同一根竖线上
      logo: {
        titlebarImg: rect(tbImg),
        sidebarImg: rect(sbImg),
        leftDelta:
          tbImg && sbImg ? r2(sbImg.getBoundingClientRect().x - tbImg.getBoundingClientRect().x) : null
      },
      // bug 3：侧栏上下留白
      sidebar: {
        sb: rect(sb),
        brand: rect(sbBrand),
        user: rect(sbUser),
        status: rect(sbStatus),
        topGap: sb && sbBrand ? r2(sbBrand.getBoundingClientRect().y - sb.getBoundingClientRect().y) : null,
        bottomGap:
          sb && sbUser ? r2(sb.getBoundingClientRect().bottom - sbUser.getBoundingClientRect().bottom) : null,
        statusToUserGap:
          sbUser && sbStatus
            ? r2(sbUser.getBoundingClientRect().y - sbStatus.getBoundingClientRect().bottom)
            : null
      },
      // bug 6a：缝隙刻度条 —— 实心格与缺口格必须同高，否则「数不清」
      gapStrip: {
        tickCount: ticks.length,
        heights: tickH,
        loadedHeight: loadedH.length ? Math.round(loadedH[0]) : null,
        gapHeight: gapH.length ? Math.round(gapH[0]) : null,
        allSameHeight: allSameH
      }
    }
  } catch (e) {
    out.sections.layout = { error: String(e) }
    out.ok = false
  }

  /* ------------------------------------------------------- B. 延迟测试文案 */
  try {
    const btn = document.querySelector('.sb__latency-test')
    const readLabel = () => {
      const el = document.querySelector('.sb__latency')
      return el ? (el.textContent || '').trim() : null
    }
    const before = readLabel()
    const samples = []
    if (btn) {
      btn.click()
      for (const at of [120, 500, 1200, 2400]) {
        await sleep(at === 120 ? 120 : at - samples[samples.length - 1].at)
        samples.push({ at, label: readLabel() })
      }
    }
    out.sections.latency = {
      before,
      samples,
      // 判定：测试进行中必须能看出「在测」，否则用户以为点了没反应
      showsTesting: samples.some((s) => (s.label || '').includes('测试中')),
      finalLabel: samples[samples.length - 1]?.label ?? null,
      buttonFound: !!btn
    }
  } catch (e) {
    out.sections.latency = { error: String(e) }
    out.ok = false
  }

  /* --------------------------------------------------------- C. 详情面板 */
  try {
    const rows = document.querySelectorAll('.plist__rows > *')
    const first = rows[0]
    if (first) {
      ;(first.querySelector('[role="button"], button') || first).click()
      await sleep(700)
    }
    const detail = document.querySelector('.detail')
    const main = document.querySelector('.app__main.shell-main')
    const cs = detail ? getComputedStyle(detail) : null
    const body = document.querySelector('.app__body')
    // 详情必须自成一档：有自己的衬底，不能透出壁纸
    const bg = cs ? cs.backgroundColor : null
    const alpha = (() => {
      if (!bg) return null
      const m = bg.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const parts = m[1].split(',').map((s) => parseFloat(s))
      return parts.length === 4 ? parts[3] : 1
    })()
    out.sections.detail = {
      opened: !!detail,
      detail: rect(detail),
      main: rect(main),
      body: rect(body),
      isSiblingOfMain: !!(detail && main && detail.parentElement === main.parentElement),
      background: bg,
      backgroundAlpha: alpha,
      borderRadius: cs ? cs.borderTopLeftRadius : null,
      backdrop: cs ? cs.backdropFilter : null,
      overflow: cs ? cs.overflow : null,
      scrollOwners: detail
        ? [...detail.querySelectorAll('*')]
            .filter((el) => el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflowY !== 'visible')
            .slice(0, 8)
            .map((el) => ({ cls: el.className, sh: el.scrollHeight, ch: el.clientHeight }))
        : [],
      galleryCells: detail ? detail.querySelectorAll('[class*="gal"] img, [class*="gal"] figure').length : 0,
      // 判定：有衬底（alpha 明显 > 0.5）、有圆角、有边
      pass: !!detail && alpha !== null && alpha > 0.5 && !!cs && cs.borderTopLeftRadius !== '0px'
    }
    // 还原：Esc 关掉详情
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(400)
  } catch (e) {
    out.sections.detail = { error: String(e) }
    out.ok = false
  }

  /* ------------------------------------------------------- D. 换壁纸 */
  try {
    const wpSrc = () => document.querySelector('.wp-layer img')?.getAttribute('src') ?? null
    const beforeSrc = wpSrc()
    // 打开设置
    const entry =
      byText('.sb__item', '环境与设置') || document.querySelector('.sb__icon-btn[aria-label="设置"]')
    if (entry) {
      entry.click()
      await sleep(700)
    }
    const cells = [...document.querySelectorAll('.apwall__cell')]
    const beforeName = document.querySelector('.apwall__name')?.textContent?.trim() ?? null
    let target = null
    if (cells.length >= 2) target = cells.find((c) => !c.classList.contains('is-on')) || cells[1]
    if (target) {
      target.click()
      await sleep(500)
    }
    const noteAfterPick = document.querySelector('.apnote')?.textContent?.trim() ?? null
    const nameAfterPick = document.querySelector('.apwall__name')?.textContent?.trim() ?? null
    const onAfterPick = document.querySelector('.apwall__cell.is-on')?.textContent?.trim()?.slice(0, 20) ?? null
    // 点保存（草稿落盘）
    const save = document.querySelector('.dialog__foot-actions .btn--primary')
    if (save) {
      save.click()
      await sleep(1400)
    }
    const afterSrc = wpSrc()
    const toastText = [...document.querySelectorAll('[class*="toast"]')]
      .map((t) => (t.textContent || '').trim())
      .join(' | ')
      .slice(0, 200)
    out.sections.wallpaper = {
      cells: cells.length,
      beforeSrc,
      afterSrc,
      srcChanged: beforeSrc !== afterSrc,
      beforeName,
      nameAfterPick,
      onAfterPick,
      noteAfterPick,
      toastText,
      saveFound: !!save,
      pass: beforeSrc !== afterSrc
    }
  } catch (e) {
    out.sections.wallpaper = { error: String(e) }
    out.ok = false
  }

  return out
})()