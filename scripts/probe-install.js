(async () => {
  const P = 'dsh-console-selftest'
  const tail = (s, n = 14) => (typeof s === 'string' ? s.split(/\r?\n/).filter(Boolean).slice(-n) : [])
  const snap = async () => {
    const list = await window.dsh.plugins(P, { deep: false })
    return {
      count: list.length,
      rows: list.map((p) => `${p.name}@${p.version ?? '?'}${p.inBundles ? ' [bundled#' + p.bundleIndex + ']' : ''}`)
    }
  }

  const out = {}

  out.profiles = (await window.dsh.profiles()).map((p) => `${p.name}(deps=${p.depCount},bundles=${p.bundleCount},nm=${p.hasNodeModules})`)
  out.before = await snap()

  const preview = await window.dsh.installPreview(P, 'https://github.com/dsh-market/dsh-market')
  out.preview = {
    ok: preview.parsed?.ok,
    norm: preview.parsed?.normalized,
    isDshPlugin: preview.isDshPlugin,
    already: preview.alreadyInstalled,
    warnings: preview.warnings,
    error: preview.error
  }

  const t0 = Date.now()
  const install = await window.dsh.runOp({ kind: 'install', profile: P, spec: 'https://github.com/dsh-market/dsh-market' })
  out.install = {
    ms: Date.now() - t0,
    ok: install.ok,
    code: install.code,
    msg: install.message,
    restart: install.restartRequired,
    changes: install.changes,
    tail: tail(install.log, 18)
  }
  out.afterInstall = await snap()

  if (install.ok) {
    const un = await window.dsh.runOp({ kind: 'uninstall', profile: P, targets: ['dshmarket'] })
    out.uninstall = {
      ok: un.ok,
      code: un.code,
      msg: un.message,
      changes: un.changes,
      tail: tail(un.log, 14)
    }
    out.afterUninstall = await snap()
  }

  return JSON.stringify(out, null, 2)
})()