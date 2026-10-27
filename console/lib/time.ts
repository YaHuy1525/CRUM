export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'

  const diffMs = now - then
  if (diffMs < 45_000) return 'just now'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const thenDate = new Date(then)
  const nowDate = new Date(now)
  const startOfThen = new Date(thenDate.getFullYear(), thenDate.getMonth(), thenDate.getDate()).getTime()
  const startOfNow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()
  const dayDiff = Math.round((startOfNow - startOfThen) / 86_400_000)
  if (dayDiff === 1) return 'yesterday'

  const sameYear = thenDate.getFullYear() === nowDate.getFullYear()
  return thenDate.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
