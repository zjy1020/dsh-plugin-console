(async () => {
  const lab = document.querySelector('.sidebar__switch')
  if (!lab) return 'no label'
  const cs = getComputedStyle(lab)
  const r = lab.getBoundingClientRect()
  const inp = lab.querySelector('input')
  const ics = inp ? getComputedStyle(inp) : null
  const ir = inp ? inp.getBoundingClientRect() : null
  return JSON.stringify({
    labelText: JSON.stringify(lab.textContent),
    label: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), color: cs.color, display: cs.display, overflow: cs.overflow, fontSize: cs.fontSize },
    input: ir ? { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height), opacity: ics.opacity, position: ics.position } : null
  }, null, 2)
})()
