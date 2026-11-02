/**
 * verify-update-picks.js —— 第四批第 1 条的验收器（多选更新 + 「更新全部」不再报空）。
 *
 * 用法：
 *   node scripts/cdp-eval.mjs --file scripts/verify-update-picks.js
 * （应用要先带 --remote-debugging-port=9333 起来；CDP_PORT 可覆盖端口。）
 *
 * 为什么要是 async IIFE 且 return 一个值：
 *   cdp-eval 走的是 Runtime.evaluate({ returnByValue: true, awaitPromise: true })，
 *   它把文件内容当作**表达式**求值。写成 `const x = …` 加 console.log 的脚本，
 *   补全值是最后一个语句（console.log 返回 undefined），你只会看到 "undefined"。
 *
 * 这个脚本只读不写：它点「检查更新」（联网只读）与勾选框（纯界面状态），
 * **不会**点确认执行任何 pnpm 更新。真正的更新由主控单独决定要不要跑。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const qa = (s) => Array.from(document.querySelectorAll(s))
  const T = (el) => (el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : null)
  const btnByText = (re, root = document) =>
    Array.from(root.querySelectorAll('button')).find((b) => re.test((b.textContent || '').trim()))

  const report = { steps: [], fail: [] }
  const step = (name, data) => report.steps.push({ name, ...data })

  const rows = () => qa('.prow')
  const pickBoxes = () => qa('.prow__pick input[type=checkbox]')
  const checkableRows = () =>
    rows()
      .map((r) => {
        const box = r.querySelector('.prow__pick input[type=checkbox]')
        const name = T(r.querySelector('.prow__name'))
        return {
          name,
          hasBox: !!box,
          disabled: box ? box.disabled : null,
          // 「可更新」在行上的体现：版本列有「→ x.y.z」或者有 update 徽章
          updatable: !!r.querySelector('[class*=update]') || /→/.test(r.textContent || '')
        }
      })

  /* 0) 前置：图鉴当前位置 -------------------------------------------------- */
  report.before = {
    rows: rows().length,
    pickBoxes: pickBoxes().length,
    headerBox: !!document.querySelector('.plist__pick-all input[type=checkbox]'),
    selectedBtn: T(btnByText(/^更新选中/)),
    allBtn: T(btnByText(/^更新全部/)),
    size: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }
  }

  /* 1) 先跑一次「检查更新」，否则 updateAvailable 全是 false，复选框一个都不会出现 */
  const checkBtn = btnByText(/^检查更新/)
  if (!checkBtn) {
    report.fail.push('找不到「检查更新」按钮')
    return report
  }
  checkBtn.click()
  let waited = 0
  const deadline = 30000
  while (waited < deadline) {
    await sleep(500)
    waited += 500
    const b = btnByText(/^检查更新/)
    if (b && !b.disabled && !/检查中|正在/.test(b.textContent || '')) break
  }
  await sleep(600)
  report.afterCheck = { waitedMs: waited, allBtn: T(btnByText(/^更新全部/)) }

  /* 2) 复选框只应出现在可更新的行上 --------------------------------------- */
  const info = checkableRows()
  report.rowPicks = info
  const withBox = info.filter((r) => r.hasBox)
  const enabledBox = withBox.filter((r) => r.disabled === false)
  report.pickAudit = {
    totalRows: info.length,
    rowsWithBox: withBox.length,
    rowsBoxEnabled: enabledBox.length,
    rowsBoxDisabled: withBox.length - enabledBox.length,
    // 关键不变量：可勾选的（enabled）必须就是「可更新」的那些行
    enabledButNotUpdatable: enabledBox.filter((r) => !r.updatable).map((r) => r.name),
    updatableButNoBox: info.filter((r) => r.updatable && !r.hasBox).map((r) => r.name),
    updatableButDisabled: info.filter((r) => r.updatable && r.hasBox && r.disabled).map((r) => r.name)
  }
  if (report.pickAudit.enabledButNotUpdatable.length) report.fail.push('有不可更新的行却给了可勾选复选框')
  if (report.pickAudit.updatableButNoBox.length) report.fail.push('有可更新的行却没给复选框')

  /* 3) 表头三态全选 -------------------------------------------------------- */
  const headerBox = document.querySelector('.plist__pick-all input[type=checkbox]')
  if (!headerBox) {
    report.fail.push('表头没有全选复选框（.plist__pick-all input）')
  } else {
    headerBox.click()
    await sleep(250)
    const afterAll = pickBoxes().filter((b) => b.checked).length
    const label = T(btnByText(/^更新选中/))
    report.selectAll = { checkedAfter: afterAll, selectedBtn: label }

    headerBox.click()
    await sleep(250)
    report.selectNone = {
      checkedAfter: pickBoxes().filter((b) => b.checked).length,
      selectedBtn: T(btnByText(/^更新选中/))
    }

    /* 4) 单个勾选 → 出现「更新选中 (1)」 */
    const first = pickBoxes().find((b) => !b.disabled)
    if (first) {
      first.click()
      await sleep(250)
      const one = T(btnByText(/^更新选中/))
      report.selectOne = { selectedBtn: one, checked: pickBoxes().filter((b) => b.checked).length }
      if (!one || !/\(1\)/.test(one)) report.fail.push('勾一个后没出现「更新选中 (1)」')
      // 收起勾选，别把界面留在奇怪状态
      first.click()
      await sleep(200)
    } else {
      report.fail.push('没有可勾选的复选框（一个可更新的包都没有？）')
    }
  }

  report.pass = report.fail.length === 0
  return report
})()
