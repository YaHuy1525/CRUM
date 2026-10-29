import { scoreProspect, type Band, type Reachability, type ScoreInput } from './score'
import type { AudienceBasis } from './normalize'

export interface ScoreRowInput {
  prospectId: string
  tenantId: string
  audience: { count: number | null; basis: AudienceBasis }
  offers: { priceVisible: boolean; sellsSomething: boolean }
  weaknessSignals: string[]
  reachability: Reachability
}

export interface ScoreRow {
  prospectId: string
  tenantId: string
  audienceScore: number
  monetisationScore: number
  funnelGapScore: number
  reachabilityScore: number
  total: number
  band: Band
  weightsVersion: string
}

export function toScoreRow(input: ScoreRowInput): ScoreRow {
  const score = scoreProspect({
    audience: input.audience,
    offers: input.offers,
    weaknessSignals: input.weaknessSignals,
    reachability: input.reachability,
  } satisfies ScoreInput)

  return {
    prospectId: input.prospectId,
    tenantId: input.tenantId,
    audienceScore: score.audience,
    monetisationScore: score.monetisation,
    funnelGapScore: score.funnelGap,
    reachabilityScore: score.reachability,
    total: score.total,
    band: score.band,
    weightsVersion: score.weightsVersion,
  }
}
