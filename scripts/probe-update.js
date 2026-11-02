(async () => {
  const P = 'dsh-console-selftest'
  const NAME = 'dsh-context'
  const tail = (s, n = 10) => (typeof s === 'string' ? s.split(/\r?\n/).filter(Boolean).slice(-n) : [])
  const snap = async () => {
    const list = await window.dsh.plugins(P, { deep: false })
    return list.map((p) => `${p.name}@${p.version}${p.inBundles ? ' [bundled#' + p.bundleIndex + ']' : ''}${p.updateAvailable ? ' → ' + p.latestVersion : ''}`)
  }

  const out = {}

  const ins = await window.dsh.runOp({ kind: 'install', profile: P, spec: `${NAME}@0.61.0` })
  out.install = { ok: ins.ok, code: ins.code, msg: ins.message }
  out.afterInstall = await snap()

  const upd = await window.dsh.checkUpdates(P, [NAME])
  out.check = Object.fromEntries(Object.entries(upd).map(([k, v]) => [k, { ver: v.version, latest: v.latestVersion, avail: v.updateAvailable, kind: v.updateKind, err: v.updateError }]))
  out.afterCheck = await snap()

  const doUpd = await window.dsh.runOp({ kind: 'update', profile: P, targets: [NAME] })
  out.update = {
    ok: doUpd.ok,
    code: doUpd.code,
    msg: doUpd.message,
    changes: doUpd.changes,
    restart: doUpd.restartRequired,
    tail: tail(doUpd.log, 12)
  }
  out.afterUpdate = await snap()

  const recheck = await window.dsh.checkUpdates(P, [NAME])
  out.recheck = Object.fromEntries(Object.entries(recheck).map(([k, v]) => [k, { ver: v.version, latest: v.latestVersion, avail: v.updateAvailable }]))

  return JSON.stringify(out, null, 2)
})()