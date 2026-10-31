import type { MarketingBundleRow } from '../db/marketing'
import {
  SlugProblemError,
  resolveSite,
  siteHashOf,
  slotProblem,
  type SiteArtifact,
} from './site'

export const MARKETING_ACTION_NAMES = [
  'publish_page',
  'unpublish_page',
  'create_campaign',
  'set_campaign_status',
  'promote_page',
] as const

export type MarketingActionName = (typeof MARKETING_ACTION_NAMES)[number]

/**
 * Declared, executable in this build, and never produced by a plan. A media or
 * funnel plan can ask for a page; nothing in a plan can ask for that page to be
 * put on the owner's domain, because that is the decision the owner reserved.
 * Computed apart from DERIVED so the conformance test below cannot pass by
 * hiding a name in the wrong list.
 */
export const HUMAN_INITIATED_ACTION_NAMES: readonly MarketingActionName[] = ['promote_page']

export interface DerivedAction {
  action: MarketingActionName
  payload: Record<string, unknown>
}

export interface MarketingActionAdapter {
  name: MarketingActionName
  /**
   * Called by the drainer after the approval transaction has committed. It must
   * never be called from inside one: an approval that signs a receipt for a page
   * the provider never received is the exact failure the outbox exists to make
   * impossible (spec section 5).
   */
  execute: (action: DerivedAction) => Promise<{ externalId: string; url?: string; fileCount?: number }>
}

/**
 * Thrown instead of importing UnsupportedCommitError from
 * src/db/pending-writes, which imports this module: the caller translates it at
 * the branch in applyDraft, which keeps the dependency one way.
 */
export class BundleNotApprovableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleNotApprovableError'
  }
}

const adapters = new Map<MarketingActionName, MarketingActionAdapter>()

/** Slice 2 and slice 3 call this at boot. It returns the unregister function so
 * a test can put the registry back exactly as it found it. */
export function registerActionAdapter(adapter: MarketingActionAdapter): () => void {
  adapters.set(adapter.name, adapter)
  return () => {
    if (adapters.get(adapter.name) === adapter) adapters.delete(adapter.name)
  }
}

export function isExecutable(action: MarketingActionName): boolean {
  return adapters.has(action)
}

export function blockedActions(actions: readonly DerivedAction[]): MarketingActionName[] {
  return actions.filter((action) => !isExecutable(action.action)).map((action) => action.action)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function pageSlugOf(bundle: Pick<MarketingBundleRow, 'funnelPlan'>): string | null {
  const funnel = asRecord(bundle.funnelPlan)
  const page = funnel ? asRecord(funnel['page']) : null
  const slug = page?.['slug']
  return typeof slug === 'string' && slug.length > 0 ? slug : null
}

export function slotProblemCheck(artifacts: readonly SiteArtifact[]): string | null {
  return slotProblem(artifacts)
}

/**
 * The bytes, not just the intent: `slug` alone cannot build a manifest, and a
 * publisher that resolved the file set later would be publishing bytes the
 * reviewer never saw. `siteHash` here is the same value the stage payload shows
 * and the same value the approval recomputes under the row lock.
 */
export function deriveActions(
  bundle: Pick<MarketingBundleRow, 'id' | 'funnelPlan' | 'mediaPlan'>,
  artifacts: readonly SiteArtifact[],
): DerivedAction[] {
  const actions: DerivedAction[] = []
  const slug = pageSlugOf(bundle)
  if (slug !== null && slotProblem(artifacts) === null) {
    const files = resolveSite(slug, artifacts)
    if (files.length > 0) {
      actions.push({
        action: 'publish_page',
        payload: { bundleId: bundle.id, slug, siteHash: siteHashOf(files) },
      })
    }
  }
  const media = asRecord(bundle.mediaPlan)
  const campaigns = media?.['campaigns']
  if (Array.isArray(campaigns) && campaigns.length > 0) {
    actions.push({
      action: 'create_campaign',
      payload: { bundleId: bundle.id, campaignCount: campaigns.length },
    })
  }
  return actions
}

export const DERIVED_ACTION_NAMES: readonly MarketingActionName[] = ['publish_page', 'create_campaign']

/** Declared in the database and in this build's vocabulary, but no plan shape that our roles emit
 * can express them yet. Computed rather than hand-copied so widening MARKETING_ACTION_NAMES lands
 * here instead of disappearing into a derivation that will never fire. */
export const UNMAPPED_ACTION_NAMES: MarketingActionName[] = MARKETING_ACTION_NAMES.filter(
  (name) => !DERIVED_ACTION_NAMES.includes(name) && !HUMAN_INITIATED_ACTION_NAMES.includes(name),
)

/**
 * A plan column that is not null must be readable, because an approval that derives no action from
 * a plan that plainly asks for one signs a receipt over a bundle that will silently do nothing.
 * Only the two contract containers are inspected — the funnel builder answers with
 * `{page, form, thankYou, tracking}` and the media buyer with `{objective, audience, placements,
 * campaigns}` — so decoration the derivation has no use for is never mistaken for an intent.
 * An explicit null page, and an empty campaigns list, are understood plans, not unread ones: a
 * media plan that spends nothing is exactly what it says.
 */
export function unreadPlanColumns(
  bundle: Pick<MarketingBundleRow, 'funnelPlan' | 'mediaPlan'>,
): string[] {
  const unread: string[] = []
  const funnel = asRecord(bundle.funnelPlan)
  if (bundle.funnelPlan !== null && !funnel) unread.push('funnel_plan')
  else if (funnel && 'page' in funnel) {
    if (funnel['page'] !== null) {
      const page = asRecord(funnel['page'])
      const slug = page?.['slug']
      if (!page || typeof slug !== 'string' || slug.length === 0) unread.push('funnel_plan')
    }
  } else if (funnel) unread.push('funnel_plan')

  const media = asRecord(bundle.mediaPlan)
  if (bundle.mediaPlan !== null && !media) unread.push('media_plan')
  else if (media && 'campaigns' in media) {
    const campaigns = media['campaigns']
    if (campaigns !== null && !Array.isArray(campaigns)) unread.push('media_plan')
  } else if (media) unread.push('media_plan')

  return unread
}

interface BundleLockRow {
  id: string
  status: string
  funnel_plan: unknown
  media_plan: unknown
}

interface ArtifactSqlRow {
  id: string
  kind: string
  text_content: string | null
}

export async function commitBundleApproval(
  client: { query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  params: {
    tenantId: string
    bundleId: string
    receiptId: string | null
    expectedSiteHash: string | null
  },
): Promise<string> {
  const locked = await client.query<BundleLockRow>(
    `SELECT id, status, funnel_plan, media_plan
       FROM marketing_bundles
      WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
    [params.bundleId, params.tenantId],
  )
  const row = locked.rows[0]
  if (!row) {
    throw new BundleNotApprovableError(
      `marketing bundle ${params.bundleId} is not visible to this tenant, so it cannot be approved`,
    )
  }
  if (row.status !== 'staged') {
    throw new BundleNotApprovableError(
      `marketing bundle ${params.bundleId} is ${row.status}; only a staged bundle can be approved`,
    )
  }

  // Before the adapter question, not after it: a plan this build cannot read is
  // also a plan whose actions it cannot know, so `blockedActions` has nothing
  // honest to answer with, and an unread plan that derives nothing would let the
  // approval sign a receipt over a bundle that silently does nothing.
  const unread = unreadPlanColumns({ funnelPlan: row.funnel_plan, mediaPlan: row.media_plan })
  if (unread.length > 0) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} has a ${unread.join(' and ')} this build cannot read, so it cannot say ` +
        'what approving it would cause. Re-save the bundle with that plan as null, or in the shape its role produces.',
    )
  }

  // The bytes the reviewer approved are identified by a hash in the staged
  // payload. Nothing else in this transaction knows what the human looked at, so
  // the lock is the last place that can still ask. Artifacts are read here rather
  // than passed in: they live in rows the FOR UPDATE lock does not cover, and a
  // re-read inside the transaction is the only version the commit may rely on.
  const artifactResult = await client.query<ArtifactSqlRow>(
    `SELECT id, kind, text_content
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND bundle_id = $2
      ORDER BY created_at ASC`,
    [params.tenantId, row.id],
  )
  const artifacts: SiteArtifact[] = artifactResult.rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    textContent: a.text_content,
  }))

  const problem = slotProblem(artifacts)
  if (problem !== null) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} cannot be approved: ${problem}`,
    )
  }

  // A bundle with an unusable slug should never reach here, because the stage tool
  // refuses it. If one does — an older row, or a plan edited after staging — the
  // approval still fails closed: no receipt over a page whose path nobody can
  // publish. resolveSite throws SlugProblemError, which is translated below to the
  // refusal type applyDraft turns into an unapprovable answer; a raw throw would
  // surface as a 500 instead.
  let actions: DerivedAction[]
  try {
    actions = deriveActions(
      { id: row.id, funnelPlan: row.funnel_plan, mediaPlan: row.media_plan },
      artifacts,
    )
  } catch (err) {
    if (err instanceof SlugProblemError) {
      throw new BundleNotApprovableError(err.message)
    }
    throw err
  }

  const publish = actions.find((a) => a.action === 'publish_page')
  const liveHash = typeof publish?.payload['siteHash'] === 'string' ? publish.payload['siteHash'] : null
  // No null escape on either side. A payload that identified no page cannot
  // approve a bundle that now has one, and a page that lost its bytes is the
  // same refusal in the other direction. Null on both sides means neither the
  // review nor this commit had a page to publish, which is the one case with
  // nothing to compare.
  if (liveHash !== params.expectedSiteHash) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} no longer hashes to the bytes this review was shown ` +
        `(${params.expectedSiteHash ?? 'nothing'} staged, ${liveHash ?? 'nothing'} now). ` +
        'Approve nothing; re-save and re-stage.',
    )
  }

  const blocked = blockedActions(actions)
  if (blocked.length > 0) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} asks for ${blocked.join(' and ')}, which has no adapter in this build. ` +
        'CRUM will not sign a receipt for a page or a campaign that does not exist.',
    )
  }

  const updated = await client.query<{ id: string }>(
    `UPDATE marketing_bundles SET status = 'approved'
      WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [params.bundleId, params.tenantId],
  )
  const approvedId = updated.rows[0]?.id
  if (!approvedId) {
    throw new BundleNotApprovableError(`marketing bundle ${params.bundleId} could not be marked approved`)
  }

  for (const action of actions) {
    await client.query(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, receipt_id)
       VALUES ($1, $2, $3, $4, 'queued', $5)`,
      [params.tenantId, approvedId, action.action, JSON.stringify(action.payload), params.receiptId],
    )
  }
  return approvedId
}
