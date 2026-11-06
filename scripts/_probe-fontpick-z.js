(async () => {
  const rows = [...document.querySelectorAll('.fp__row')]
  const trig = rows[0].querySelector('.fpick__trigger')
  if (!trig.classList.contains('is-open')) trig.click()
  await new Promise((r) => setTimeout(r, 300))
  const pop = document.querySelector('.fpick__pop')
  if (!pop) return { err: 'no-pop' }
  const pr = pop.getBoundingClientRect()
  const cs = getComputedStyle(pop)
  const row2 = rows[1]
  const sel2 = row2.querySelector('.fpick__trigger, .fp__rowside > *')
  const sr = sel2 ? sel2.getBoundingClientRect() : null
  const mid = { x: Math.round(pr.x + pr.width / 2), y: Math.round(pr.y + pr.height / 2) }
  const top = document.elementFromPoint(mid.x, Math.round(pr.y + 30))
  const bot = document.elementFromPoint(mid.x, Math.round(pr.bottom - 12))
  const at = (e) => e ? (e.className || e.tagName).toString().slice(0, 40) : null
  return {
    pop: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height), bg: cs.backgroundColor, zi: cs.zIndex, pos: cs.position },
    row2sel: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
    hitInsidePopTop: at(top), hitInsidePopBottom: at(bot), hitAbovePop: at(document.elementFromPoint(mid.x, Math.round(pr.y - 8)))
  }
})()
