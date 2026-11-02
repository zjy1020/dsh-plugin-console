(async () => {
  const bundled = async () => {
    const list = await window.dsh.plugins('desktop', { deep: false })
    return list.filter((p) => p.inBundles).sort((a, b) => (a.bundleIndex ?? 0) - (b.bundleIndex ?? 0)).map((p) => p.name)
  }
  const tail = (s) => (typeof s === 'string' ? s.split(/\r?\n/).filter(Boolean).slice(-8) : [])
  const target = 'dsh-better-sidebar'

  const before = await bundled()
  const off = await window.dsh.runOp({ kind: 'disable', profile: 'desktop', targets: [target] })
  const mid = await bundled()
  const on = await window.dsh.runOp({ kind: 'enable', profile: 'desktop', targets: [target] })
  const after = await bundled()

  return JSON.stringify({
    beforeLen: before.length,
    target,
    idxBefore: before.indexOf(target),
    off: { ok: off.ok, code: off.code, msg: off.message, restart: off.restartRequired, changes: off.changes, tail: tail(off.log) },
    midLen: mid.length,
    idxInMid: mid.indexOf(target),
    on: { ok: on.ok, code: on.code, msg: on.message, restart: on.restartRequired, changes: on.changes, tail: tail(on.log) },
    afterLen: after.length,
    idxAfter: after.indexOf(target),
    restoredExactly: JSON.stringify(before) === JSON.stringify(after)
  }, null, 2)
})()