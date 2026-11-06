(() => {
  const c = document.createElement('canvas').getContext('2d')
  const missing = 'NoSuchFontFamilyXYZ123'
  const meas = (fam) => { c.font = `40px "${fam}", monospace`; return c.measureText('WgqjMmMMMiiWW').width }
  const base = meas(missing)
  const check = (fam) => {
    let ok = false
    try { ok = document.fonts.check(`40px "${fam}"`, 'WgqjMmMMMiiWW') } catch (e) { ok = 'err:' + e.message }
    const w = meas(fam)
    return { fam, diff: +(w - base).toFixed(1), fontsCheck: ok }
  }
  return {
    base: +base.toFixed(1),
    probes: [
      'CaskaydiaMono NF', 'CaskaydiaMono Nerd Font', 'CaskaydiaMono NFM',
      'CaskaydiaMono Nerd Font Mono', 'CaskaydiaMono NFP', 'CaskaydiaMono Nerd Font Propo',
      'CaskaydiaMono NF Bold Italic', 'MartianMono NF', 'MartianMono Nerd Font',
      'CaskaydiaCove Nerd Font', 'Consolas', missing,
    ].map(check),
  }
})()
