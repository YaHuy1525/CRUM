import { getDbClient } from './client'
import { artifactIdFor, type BundleHashInput } from '../marketing/hash'
import { pageSlugOf } from '../marketing/outbox'
import { resolveSite, siteHashOf, slotProblem } from '../marketing/site'

export const MARKETING_OBJECTIVES = ['outreach_support', 'inbound_leads', 'proof_asset'] as const
export type MarketingObjective = (typeof MARKETING_OBJECTIVES)[number]

export const MARKETING_ROLES = [
  'offer-strategist',
  'marketer-copywriter',
  'creative-designer',
  'media-buyer',
  'funnel-builder',
  'campaign-analyst',
] as const
export type MarketingRole = (typeof MARKETING_ROLES)[number]

export const ARTIFACT_KINDS = [
  'image',
  'page_html',
  'form_spec',
  'campaign_spec',
  'script',
  'report',
  // The second slot-as-kind, admitted by migration 0019: a thank-you page sits
  // at thanks/index.html under the bundle's slug.
  'thank_you_html',
] as const
export type MarketingArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const BUNDLE_STATUSES = [
  'draft',
  'staged',
  'approved',
  'publishing',
  'live',
  'failed',
  'archived',
] as const
export type BundleStatus = (typeof BUNDLE_STATUSES)[number]

export interface MarketingBundleRow {
  id: string
  tenantId: string
  brief: string
  objective: MarketingObjective
  audienceNote: string | null
  status: BundleStatus
  strategy: unknown
  copy: unknown
  mediaPlan: unknown
  funnelPlan: unknown
  analysis: unknown
  promptVersion: string
  draftHash: string
  // The credential a published page carries in its form action. Null until a
  // save that minted one; set-once from then on.
  leadToken: string | null
  createdAt: string
  updatedAt: string
}

export interface MarketingArtifactRow {
  id: string
  role: MarketingRole
  kind: MarketingArtifactKind
  documentId: string | null
  textContent: string | null
  status: string
  createdAt: string
}

export interface ArtifactInput {
  role: MarketingRole
  kind: MarketingArtifactKind
  documentId: string | null
  textContent: string | null
}

interface BundleSqlRow {
  id: string
  tenant_id: string
  brief: string
  objective: MarketingObjective
  audience_note: string | null
  status: BundleStatus
  strategy: unknown
  copy: unknown
  media_plan: unknown
  funnel_plan: unknown
  analysis: unknown
  prompt_version: string
  draft_hash: string
  lead_token: string | null
  created_at: string
  updated_at: string
}

function toBundle(row: BundleSqlRow): MarketingBundleRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    brief: row.brief,
    objective: row.objective,
    audienceNote: row.audience_note,
    status: row.status,
    strategy: row.strategy,
    copy: row.copy,
    mediaPlan: row.media_plan,
    funnelPlan: row.funnel_plan,
    analysis: row.analysis,
    promptVersion: row.prompt_version,
    draftHash: row.draft_hash,
    leadToken: row.lead_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getMarketingBundle(
  tenantId: string,
  bundleId: string,
): Promise<MarketingBundleRow | null> {
  const db = getDbClient()
  const result = await db.query<BundleSqlRow>(
    `SELECT id, tenant_id, brief, objective, audience_note, status,
            strategy, copy, media_plan, funnel_plan, analysis,
            prompt_version, draft_hash, lead_token, created_at, updated_at
       FROM marketing_bundles
      WHERE id = $1 AND tenant_id = $2`,
    [bundleId, tenantId],
  )
  const row = result.rows[0]
  return row ? toBundle(row) : null
}

export async function listMarketingArtifacts(
  tenantId: string,
  bundleId: string,
): Promise<MarketingArtifactRow[]> {
  const db = getDbClient()
  const result = await db.query<{
    id: string
    role: MarketingRole
    kind: MarketingArtifactKind
    document_id: string | null
    text_content: string | null
    status: string
    created_at: string
  }>(
    `SELECT id, role, kind, document_id, text_content, status, created_at
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND bundle_id = $2
      ORDER BY created_at ASC`,
    [tenantId, bundleId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    kind: row.kind,
    documentId: row.document_id,
    textContent: row.text_content,
    status: row.status,
    createdAt: row.created_at,
  }))
}

/**
 * The approver sees a count, not the bodies, in the staged payload. The bodies
 * are one read away on the bundle screen, which is the point: numbers are safe
 * to score and prose is not (spec section 7).
 */
export async function countMarketingArtifacts(tenantId: string, bundleId: string): Promise<number> {
  const db = getDbClient()
  const result = await db.query<{ count: number | string }>(
    `SELECT count(*) AS count FROM marketing_artifacts WHERE tenant_id = $1 AND bundle_id = $2`,
    [tenantId, bundleId],
  )
  const value = result.rows[0]?.count ?? 0
  return typeof value === 'number' ? value : Number.parseInt(String(value), 10)
}

/**
 * The publish actions that actually succeeded, newest first, with the hash they
 * carried. A promotion is a receipt over one of these rows, so the row has to
 * exist, say `succeeded`, and carry a URL: a publish the owner cannot link is
 * not a preview the owner has seen.
 */
export async function listPublishSucceeded(
  tenantId: string,
  bundleId: string,
): Promise<{ id: string; siteHash: string }[]> {
  const db = getDbClient()
  const result = await db.query<{ id: string; payload: { siteHash?: string } }>(
    `SELECT id, payload FROM marketing_actions
      WHERE tenant_id = $1 AND bundle_id = $2 AND action = 'publish_page' AND status = 'succeeded'
        AND result ->> 'url' IS NOT NULL
      ORDER BY executed_at DESC`,
    [tenantId, bundleId],
  )
  return result.rows
    .map((r) => ({ id: r.id, siteHash: String(r.payload?.siteHash ?? '') }))
    .filter((r) => r.siteHash.length === 64)
}

/** One failed outbox row, with the hash it was published under. */
export async function getFailedAction(
  tenantId: string,
  actionId: string,
): Promise<{ id: string; bundleId: string; action: string; siteHash: string } | null> {
  const db = getDbClient()
  // The hash lane alone, typed as the string it is: this reader only ever
  // compares siteHash, and String() over a Record-wide unknown is the
  // '[object Object]' collision the hash comparison cannot afford.
  const result = await db.query<{
    id: string
    bundle_id: string
    action: string
    payload: { siteHash?: string } | null
  }>(
    `SELECT id, bundle_id, action, payload FROM marketing_actions
      WHERE id = $1 AND tenant_id = $2 AND status = 'failed' AND action IN ('publish_page','promote_page')`,
    [actionId, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    bundleId: row.bundle_id,
    action: row.action,
    siteHash: String(row.payload?.['siteHash'] ?? ''),
  }
}

/**
 * The same hash as `currentSiteHash`, read through the caller's client so an
 * approval can recompute it inside its own transaction rather than on a second
 * connection that a concurrent save could race. Null when the bundle has no
 * publishable page; a slug that cannot be resolved still throws, and the caller
 * translates it the way the approval path does.
 */
export async function siteHashInTransaction(
  client: { query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  tenantId: string,
  bundleId: string,
): Promise<string | null> {
  const bundle = await client.query<{ funnel_plan: unknown }>(
    `SELECT funnel_plan FROM marketing_bundles WHERE id = $1 AND tenant_id = $2`,
    [bundleId, tenantId],
  )
  const row = bundle.rows[0]
  if (!row) return null
  const slug = pageSlugOf({ funnelPlan: row.funnel_plan })
  if (slug === null) return null
  const artifactsResult = await client.query<{ id: string; kind: string; text_content: string | null }>(
    `SELECT id, kind, text_content
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND bundle_id = $2
      ORDER BY created_at ASC`,
    [tenantId, bundleId],
  )
  const artifacts = artifactsResult.rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    textContent: a.text_content,
  }))
  if (slotProblem(artifacts) !== null) return null
  return siteHashOf(resolveSite(slug, artifacts))
}

/**
 * The hash of the bundle's current bytes, or null when it has no uploadable
 * page. The slug lives on the bundle row, not on the artifacts, so this reads
 * the bundle first and cannot be built from an artifact list alone.
 */
export async function currentSiteHash(tenantId: string, bundleId: string): Promise<string | null> {
  return siteHashInTransaction(getDbClient(), tenantId, bundleId)
}

export async function insertMarketingArtifacts(params: {
  tenantId: string
  bundleId: string
  artifacts: readonly ArtifactInput[]
}): Promise<number> {
  const db = getDbClient()
  let inserted = 0
  for (const artifact of params.artifacts) {
    // Content-addressed id plus ON CONFLICT: the artifact set is a property of
    // the bundle content, so replaying a save is silent rather than duplicative.
    //
    // Both content lanes go into the seed. The 0018 payload-shape CHECK requires
    // an image to carry document_id but does not forbid text_content, so two
    // image variants in one bundle/role/kind can share a caption while pointing
    // at different bytes. Hashing one lane only would derive one id for them and
    // let ON CONFLICT DO NOTHING drop the second in silence. The NUL between the
    // lanes keeps them unambiguous: it cannot occur in a UUID, and role and kind
    // are CHECK-restricted literals that never contain it either.
    const id = artifactIdFor({
      tenantId: params.tenantId,
      bundleId: params.bundleId,
      role: artifact.role,
      kind: artifact.kind,
      content: `${artifact.documentId ?? ''}\u0000${artifact.textContent ?? ''}`,
    })
    const result = await db.query<{ id: string }>(
      `INSERT INTO marketing_artifacts
         (id, tenant_id, bundle_id, role, kind, document_id, text_content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        id,
        params.tenantId,
        params.bundleId,
        artifact.role,
        artifact.kind,
        artifact.documentId,
        artifact.textContent,
      ],
    )
    if (result.rows[0]) inserted += 1
  }
  return inserted
}

export async function setBundleLeadToken(params: {
  tenantId: string
  bundleId: string
  token: string
}): Promise<boolean> {
  const db = getDbClient()
  // Set-once: a token that can rotate would let a re-save change a published
  // page's credential without changing its hash.
  const result = await db.query<{ id: string }>(
    `UPDATE marketing_bundles
        SET lead_token = $3
      WHERE id = $1 AND tenant_id = $2 AND lead_token IS NULL
      RETURNING id`,
    [params.bundleId, params.tenantId, params.token],
  )
  return Boolean(result.rows[0])
}

/**
 * A lifecycle marker, not the approval. Only `status` changes here, and the
 * human decision is still the pending write: rejecting that write leaves the
 * bundle staged but never approved, which is the truth, and re-staging from
 * 'staged' is allowed so a rejected review can be redone.
 */
export async function markBundleStaged(params: {
  tenantId: string
  bundleId: string
}): Promise<boolean> {
  const db = getDbClient()
  // updated_at is deliberately not in the SET list: trg_marketing_bundles_touch
  // (migrations/0018) is a BEFORE UPDATE trigger that calls
  // crum_touch_updated_at(), so the database owns that column here.
  const result = await db.query<{ id: string }>(
    `UPDATE marketing_bundles
        SET status = 'staged'
      WHERE id = $1 AND tenant_id = $2 AND status IN ('draft','staged')
      RETURNING id`,
    [params.bundleId, params.tenantId],
  )
  return Boolean(result.rows[0])
}

/**
 * Only a succeeded promote_page may set this. A successful preview publish
 * leaves the bundle `approved`, so `live` keeps meaning one thing: the bytes are
 * on the owner's domain. Spec section 5.
 */
export async function markBundleLive(params: { tenantId: string; bundleId: string }): Promise<boolean> {
  const db = getDbClient()
  const result = await db.query<{ id: string }>(
    `UPDATE marketing_bundles
        SET status = 'live'
      WHERE id = $1 AND tenant_id = $2 AND status IN ('approved','publishing','live')
      RETURNING id`,
    [params.bundleId, params.tenantId],
  )
  return Boolean(result.rows[0])
}

export function roleColumnsOf(bundle: MarketingBundleRow): BundleHashInput {
  return {
    brief: bundle.brief,
    objective: bundle.objective,
    audienceNote: bundle.audienceNote,
    strategy: bundle.strategy,
    copy: bundle.copy,
    mediaPlan: bundle.mediaPlan,
    funnelPlan: bundle.funnelPlan,
    analysis: bundle.analysis,
    promptVersion: bundle.promptVersion,
  }
}
