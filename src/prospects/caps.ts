export type SendChannel = 'instagram' | 'linkedin' | 'facebook' | 'tiktok' | 'shopee' | 'email'
export type SendKind = 'dm' | 'email' | 'manual'

export interface SendLedgerEntry {
  prospectId: string
  channel: SendChannel
  sentAt: Date
}

export interface CapInput {
  prospectId: string
  channel: SendChannel
  kind: SendKind
  now: Date
  timeZone: string
  consented: boolean
  ledger: SendLedgerEntry[]
}

export type CapReason =
  | 'daily_cap'
  | 'cooldown'
  | 'touch_limit'
  | 'no_consent'
  | 'quiet_hours'
  | 'ok'

export interface CapDecision {
  allowed: boolean
  reason: CapReason
}

const DAILY_CAP: Record<SendKind, number> = { dm: 20, email: 40, manual: 30 }
const COOLDOWN_DAYS = 14
const TOUCH_LIMIT = 3
const QUIET_START = 20
const QUIET_END = 8

function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const format = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return format(a) === format(b)
}

// `hourCycle: 'h23'` rather than `hour12: false`: some ICU builds render
// midnight as "24" under the latter, which would make the whole working day
// look like quiet hours.
function localHour(now: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now)
  return Number(formatted)
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000
}

export function checkSendCaps(input: CapInput): CapDecision {
  const hour = localHour(input.now, input.timeZone)
  if (hour >= QUIET_START || hour < QUIET_END) {
    return { allowed: false, reason: 'quiet_hours' }
  }

  if (input.kind === 'email' && !input.consented) {
    return { allowed: false, reason: 'no_consent' }
  }

  const todayCount = input.ledger.filter(
    (e) => e.channel === input.channel && sameLocalDay(e.sentAt, input.now, input.timeZone),
  ).length
  if (todayCount >= DAILY_CAP[input.kind]) {
    return { allowed: false, reason: 'daily_cap' }
  }

  const mine = input.ledger.filter((e) => e.prospectId === input.prospectId)
  if (mine.length >= TOUCH_LIMIT) {
    return { allowed: false, reason: 'touch_limit' }
  }
  const last = mine.reduce<SendLedgerEntry | null>(
    (latest, e) => (latest === null || e.sentAt > latest.sentAt ? e : latest),
    null,
  )
  if (last !== null && daysBetween(last.sentAt, input.now) < COOLDOWN_DAYS) {
    return { allowed: false, reason: 'cooldown' }
  }

  return { allowed: true, reason: 'ok' }
}
