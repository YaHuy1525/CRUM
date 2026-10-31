/**
 * The two payloads the risk scorer is allowed to see for a marketing bundle.
 *
 * `scoreRisk` stringifies the whole draft, keys and values
 * (src/governance/risk.ts:59), and `gateFor` can only raise the declared class
 * (src/governance/policy.ts:118-125). Scoring prose would therefore move
 * `marketing.save_bundle` out of `auto` and `marketing.stage_bundle` out of the
 * approval queue and into a refusal, on the strength of words that are only
 * describing an intention. Spec section 7: identifiers, hashes and numbers.
 */
export interface SaveRiskView {
  objective: string
  artifactCount: number
  bundleDraftHash: string
}

export function saveRiskView(input: SaveRiskView): Record<string, unknown> {
  return {
    objective: input.objective,
    artifactCount: input.artifactCount,
    bundleDraftHash: input.bundleDraftHash,
  }
}

export interface StagePayload {
  bundleId: string
  draftHash: string
  objective: string
  artifactCount: number
  requestedCeilingMinor: number
  actionCount: number
  // null when the bundle carries no page. A number where a hash belongs would
  // let a stage pass while describing nothing to re-derive at approval.
  siteHash: string | null
}

export function stagePayload(input: StagePayload): StagePayload {
  return {
    bundleId: input.bundleId,
    draftHash: input.draftHash,
    objective: input.objective,
    artifactCount: input.artifactCount,
    requestedCeilingMinor: input.requestedCeilingMinor,
    actionCount: input.actionCount,
    siteHash: input.siteHash,
  }
}
