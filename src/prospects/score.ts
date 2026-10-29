import type { AudienceBasis } from './normalize'

export const WEIGHTS_VERSION = '2026-10-30.1'

export type Reachability = 'email' | 'dm' | 'linkedin' | 'form' | 'none'
export type Band = 'micro' | 'small' | 'mid' | 'big'

export interface ScoreInput {
  audience: { count: number | null; basis: AudienceBasis }
  offers: { priceVisible: boolean; sellsSomething: boolean }
  weaknessSignals: string[]
  reachability: Reachability
}

export interface Score {
  audience: number
  monetisation: number
  funnelGap: number
  reachability: number
  total: number
  band: Band
  weightsVersion: string
}

const WEIGHTS = { audience: 0.25, monetisation: 0.3, funnelGap: 0.3, reachability: 0.15 }

const BASIS_WEIGHT: Record<AudienceBasis, number> = {
  followers: 1,
  students: 0.8,
  clients: 0.6,
  linkedin_connections: 0.35,
  unknown: 0,
}

const SIGNAL_WEIGHT: Record<string, number> = {
  no_website: 0.3,
  no_lead_magnet: 0.25,
  no_email_capture: 0.2,
  no_funnel: 0.25,
  dm_only_sales: 0.25,
  pricing_hidden: 0.15,
  dead_social: 0.15,
  no_online_course: 0.2,
}

const REACH_WEIGHT: Record<Reachability, number> = {
  email: 1,
  dm: 0.8,
  linkedin: 0.7,
  form: 0.4,
  none: 0.1,
}

const TOO_POPULAR_AT = 50000
const TOO_POPULAR_PENALTY = 15

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function bandFor(count: number | null): Band {
  if (count === null) return 'micro'
  if (count < 2000) return 'micro'
  if (count < 20000) return 'small'
  if (count <= TOO_POPULAR_AT) return 'mid'
  return 'big'
}

export function scoreProspect(input: ScoreInput): Score {
  // A negative or non-finite count would make `Math.log10` NaN (or -Infinity)
  // and poison the total. Treat it as "unknown size" instead: no audience
  // points and the micro band, same as a null count.
  const raw = input.audience.count
  const count = raw === null || !Number.isFinite(raw) || raw < 0 ? null : raw
  const reach = count === null ? 0 : clamp01(Math.log10(count + 1) / Math.log10(1000000))
  const audience = reach * BASIS_WEIGHT[input.audience.basis]

  const monetisation = input.offers.priceVisible ? 1 : input.offers.sellsSomething ? 0.6 : 0.2

  const funnelGap = clamp01(
    input.weaknessSignals.reduce((sum, signal) => sum + (SIGNAL_WEIGHT[signal] ?? 0), 0),
  )

  const reachability = REACH_WEIGHT[input.reachability]

  const weighted =
    audience * WEIGHTS.audience +
    monetisation * WEIGHTS.monetisation +
    funnelGap * WEIGHTS.funnelGap +
    reachability * WEIGHTS.reachability

  const penalty = count !== null && count > TOO_POPULAR_AT ? TOO_POPULAR_PENALTY : 0
  const total = Math.max(0, Math.round((weighted * 100 - penalty) * 100) / 100)

  return {
    audience: Math.round(audience * 1000) / 1000,
    monetisation,
    funnelGap: Math.round(funnelGap * 1000) / 1000,
    reachability,
    total,
    band: bandFor(count),
    weightsVersion: WEIGHTS_VERSION,
  }
}
