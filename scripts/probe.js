(async () => {
  const out = {}
  const t = (fn) => fn().then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e: String(e && e.message ? e.message : e) }))

  out.settings = await window.dsh.settingsGet()
  out.rt = await window.dsh.runtimeInfo()

  const profs = await window.dsh.profiles()
  out.profiles = profs.map((p) => ({ name: p.name, deps: p.depCount, bundles: p.bundleCount, nm: p.hasNodeModules }))

  const plugs = await window.dsh.plugins('desktop', { deep: false })
  out.desktopCount = plugs.length
  out.disabled = plugs.filter((p) => p.disabled).map((p) => p.name)
  out.builtin = plugs.filter((p) => p.builtin).length
  out.notInBundles = plugs.filter((p) => p.installed && !p.inBundles).map((p) => p.name)
  out.sample = plugs.slice(0, 2).map((p) => ({
    name: p.name, spec: p.spec, kind: p.sourceKind, ver: p.version,
    inBundles: p.inBundles, idx: p.bundleIndex, disabled: p.disabled, path: p.path
  }))

  out.parse = {}
  for (const s of [
    'https://github.com/dsh-market/dsh-market',
    'dsh-market/dsh-market',
    'https://github.com/o/r/tree/dev/packages/x',
    'dsh-music-player@1.0.3',
    '@scope/name',
    'https://example.com/x.tgz',
    'git@github.com:o/r.git',
    'not a spec!!'
  ]) {
    const r = await window.dsh.parseSpec(s)
    out.parse[s] = { ok: r.ok, kind: r.kind, norm: r.normalized, reason: r.reason, err: r.error }
  }

  out.search = await t(() => window.dsh.registrySearch('dsh-music', 3))
  out.preview = await t(() => window.dsh.installPreview('desktop', 'https://github.com/dsh-market/dsh-market'))
  out.updates = await t(() => window.dsh.checkUpdates('web', ['dsh-context']))

  return JSON.stringify(out, null, 2)
})()