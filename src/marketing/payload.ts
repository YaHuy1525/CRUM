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

export interface GenerateAssetsRiskView {
  bundleId: string
  objective: string
  assetCount: number
  estimatedCostMinor: number
}

/**
 * The scored view of an image run: one id, one literal, two numbers.
 *
 * This tool is `auto`, and `gateFor` can only raise a declared class
 * (src/governance/policy.ts:118-125), so a single prose field here would move
 * every paid run into `approval` and then be refused by the drift guard below
 * the call in `marketing-writes.ts` — the run would stop, quietly, the first
 * time a designer wrote "portrait of the founder". The cost is a number, and
 * `estimatedCostMinor` is the estimate the ceiling check used, so the number a
 * reviewer would react to is the number that admitted the run.
 */
export function generateAssetsRiskView(input: GenerateAssetsRiskView): Record<string, unknown> {
  return {
    bundleId: input.bundleId,
    objective: input.objective,
    assetCount: input.assetCount,
    estimatedCostMinor: input.estimatedCostMinor,
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

export interface PromotePayload {
  bundleId: string
  pageActionId: string
  siteHash: string
}

export interface RetryPayload {
  actionId: string
  siteHash: string
}

/**
 * Deliberately no `previewUrl`. The reviewer needs the URL and gets it from the
 * bundle screen, which reads the database; the scorer needs nothing from it, and
 * a URL carries the slug, which is a phrase an agent wrote. Spec section 5.
 */
export function promotePayload(input: PromotePayload): PromotePayload {
  return { bundleId: input.bundleId, pageActionId: input.pageActionId, siteHash: input.siteHash }
}

export function retryPayload(input: RetryPayload): RetryPayload {
  return { actionId: input.actionId, siteHash: input.siteHash }
}

/**
 * The campaign status payload. Identifiers and a status only: the analyst's
 * reason is prose the model wrote, and scoreRisk stringifies the payload, so a
 * reason in here would make the approval gate depend on the phrasing rather than
 * on the change. Both hooks need the same view, which is why it is a builder.
 */
export function campaignStatusPayload(input: {
  campaignId: string
  status: 'ACTIVE' | 'PAUSED'
}): { campaignId: string; status: 'ACTIVE' | 'PAUSED' } {
  return { campaignId: input.campaignId, status: input.status }
}
