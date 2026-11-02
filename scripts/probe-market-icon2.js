/**
 * probe-market-icon2.js —— 深查「目录 icon 字段」这条路为什么没出现图片，并精确复验 Esc 焦点回归。
 * 纯读：不改任何数据，只读 CSP、试着加载一张远程图、读卡片 DOM。
 * 用法：node scripts/cdp-eval.mjs --file scripts/probe-market-icon2.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().startsWith(txt))
  const txt = (el) => (el?.innerText || '').replace(/\n+/g, ' | ').trim()
  const out = {}

  // 0) 页面 CSP（决定远程 icon 能不能显示）
  out.csp = [...document.querySelectorAll('meta[http-equiv]')].map((m) => ({ equiv: m.getAttribute('http-equiv'), content: m.getAttribute('content') }))

  // 1) 直接试加载一张目录 icon（evidence：是不是被 CSP 拦掉）
  const iconUrl = 'https://raw.githubusercontent.com/Anmulzhao/DSH-AGINT/main/docs/assets/brand/png/agint-icon-256.png'
  out.remoteImgTest = await new Promise((resolve) => {
    const img = new Image()
    const t = setTimeout(() => resolve({ url: iconUrl, result: '超时 8s' }), 8000)
    img.onload = () => {
      clearTimeout(t)
      resolve({ url: iconUrl, result: '加载成功', naturalWidth: img.naturalWidth })
    }
    img.onerror = () => {
      clearTimeout(t)
      resolve({ url: iconUrl, result: '加载失败（onerror）' })
    }
    img.src = iconUrl
    document.body.appendChild(img)
    setTimeout(() => img.remove(), 9000)
  })

  if (!document.querySelector('.mkt__input')) byText('button', '安装插件')?.click()
  await sleep(500)
  byText('.install__tab', '插件市场')?.click()
  for (let i = 0; i < 60; i++) {
    if (document.querySelectorAll('.mkt__card').length > 0) break
    await sleep(250)
  }
  await sleep(500)

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const type = async (v, wait = 1200) => {
    const input = document.querySelector('.mkt__input')
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(wait)
  }

  // 2) 目录里 icon 字段有值的那条（DSH-AGINT）在宫格里的图标形态
  await type('DSH-AGINT', 2500)
  const card = [...document.querySelectorAll('.mkt__card')].find((c) => (c.querySelector('.mkt__card-name')?.textContent || '').trim() === 'DSH-AGINT')
  out.iconCard = {
    found: !!card,
    hasImg: !!card?.querySelector('.mkt__icon--img'),
    hasMono: !!card?.querySelector('.mkt__icon--mono'),
    monoText: card?.querySelector('.mkt__icon--mono')?.textContent ?? null,
    hole: !!card && !card.querySelector('.mkt__icon, .picon-img, .picon-ph'),
    cardSize: card ? { w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) } : null
  }

  // 3) 已装的条目走本机图标链路（列表里的 .picon-* ）
  await type('', 1500)
  const iconsOfCards = [...document.querySelectorAll('.mkt__card')]
  out.localIconPath = {
    cards: iconsOfCards.length,
    localPicon: document.querySelectorAll('.mkt__card .picon-img, .mkt__card .picon-ph, .mkt__card .picon').length,
    mono: document.querySelectorAll('.mkt__card .mkt__icon--mono').length,
    holes: iconsOfCards.filter((c) => !c.querySelector('.mkt__icon, [class*="picon"]')).length
  }

  // 4) Esc 焦点回归（精确版）
  const target = iconsOfCards[2]
  const face = target.querySelector('.mkt__card-face')
  const nameAt = (target.querySelector('.mkt__card-name')?.textContent || '').trim()
  face.focus()
  const focusedBefore = document.activeElement === face
  face.click()
  await sleep(450)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(450)
  const ae = document.activeElement
  out.escFocus = {
    focusedBefore,
    clickedCard: nameAt,
    sheetGone: !document.querySelector('.mkt__sheet'),
    activeTag: ae?.tagName ?? null,
    activeClass: ae?.className ?? null,
    isSameCardFace: ae === face,
    activeCardName: (ae?.querySelector?.('.mkt__card-name')?.textContent || '').trim() || (ae?.closest?.('.mkt__card')?.querySelector('.mkt__card-name')?.textContent || '').trim() || null
  }

  // 5) 覆盖层点空白也能关
  face.click()
  await sleep(400)
  const overlay = document.querySelector('.mkt__overlay')
  overlay?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  overlay?.click()
  await sleep(400)
  out.overlayClickCloses = !document.querySelector('.mkt__sheet')
  return out
})()
