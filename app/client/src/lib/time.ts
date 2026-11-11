/* Relative FUTURE time for cadence/next-run labels: `in 4h`, `in 3d`, `now`. */
export function relativeFuture(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const delta = t - Date.now()
  if (delta <= 0) return 'now'
  const s = Math.floor(delta / 1000)
  if (s < 60)  return 'in <1m'
  const m = Math.floor(s / 60)
  if (m < 60)  return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24)  return `in ${h}h`
  const d = Math.floor(h / 24)
  if (d < 30)  return `in ${d}d`
  const mo = Math.floor(d / 30)
  return `in ${mo}mo`
}

/* Relative time for the card meta line. Mono-formatted: `2m`, `4h`, `3d`. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const delta = Math.max(0, Date.now() - t)
  const s = Math.floor(delta / 1000)
  if (s < 60)      return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60)      return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24)      return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30)      return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12)     return `${mo}mo`
  const y = Math.floor(mo / 12)
  return `${y}y`
}
