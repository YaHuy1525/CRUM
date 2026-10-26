// console/lib/time.ts
/**
 * Relative-time formatting for conversation rows and headers.
 *
 * One helper, one vocabulary: `just now`, `Nm`, `Nh`, `yesterday`, then a real
 * date. It is deliberately coarse — a thread list does not need minute
 * precision from three days ago, and a coarse label ages gracefully instead of
 * going stale on screen the way an absolute timestamp does.
 *
 * `now` is an injectable parameter (defaulting to `Date.now()`) so tests can pin
 * a reference instant instead of racing the clock. A missing, empty or unparseable
 * iso string returns an em dash rather than `Invalid Date`, because an unknown
 * time is not the same fact as a known one and must not render as a lie.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'

  const diffMs = now - then
  // A clock skew or a just-minted thread can land a hair in the future; treat
  // anything not clearly in the past as "just now" rather than a negative count.
  if (diffMs < 45_000) return 'just now'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  // Calendar-aware "yesterday": compare local dates, not a flat 24h division, so
  // a thread from 23:00 the previous evening still reads as yesterday this
  // morning rather than as "1 day" only after a full 24h has elapsed.
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
