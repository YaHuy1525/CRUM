export const AMOUNT_TOLERANCE = 0.01
export const MAX_PLAUSIBLE_AMOUNT = 100_000_000

export function isAbsent(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

export function parseAmount(v: unknown): number | null {
  if (isAbsent(v)) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  let s = v.trim()
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  s = s.replace(/[^0-9.,eE+-]/g, '').replace(/,/g, '')
  const n = Number(s)
  return s !== '' && Number.isFinite(n) ? sign * n : null
}

const EMAIL = /^[^\s@,;]+@[^\s@,;.]+\.[A-Za-z]{2,}$/

export function isEmail(v: unknown): boolean {
  return typeof v === 'string' && EMAIL.test(v.trim())
}

export function isCurrencyShape(v: unknown): boolean {
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim())
}

const DATE_OR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/

export function parseDate(v: unknown): string | null {
  if (isAbsent(v)) return null
  const m = String(v).trim().match(DATE_OR_TIMESTAMP)
  if (!m) return null
  const [, y, mo, d] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  if (!Number.isFinite(ms)) return null
  const back = new Date(ms).toISOString().slice(0, 10)
  return back === `${y}-${mo}-${d}` ? back : null
}
