import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { loadPolicy } from '../../governance/policy'
import { scoreRisk } from '../../governance/risk'
import { commitAutoWrite, createHumanTask, getOrCreateDraft } from '../../db/pending-writes'
import { getDbClient } from '../../db/client'
import {
  ARTIFACT_KINDS,
  MARKETING_OBJECTIVES,
  MARKETING_ROLES,
  currentSiteHash,
  getFailedAction,
  getMarketingBundle,
  insertMarketingArtifacts,
  listMarketingArtifacts,
  listPublishSucceeded,
  markBundleStaged,
  roleColumnsOf,
  setBundleLeadToken,
  type ArtifactInput,
  type MarketingBundleRow,
} from '../../db/marketing'
import { computeBundleHash } from '../../marketing/hash'
import {
  LEAD_ENDPOINT_PLACEHOLDER,
  leadEndpointUrl,
  mintLeadToken,
  stampLeadEndpoint,
} from '../../marketing/lead-token'
import {
  blockedActions,
  deriveActions,
  isExecutable,
  pageSlugOf,
  slotProblemCheck,
  unreadPlanColumns,
  type MarketingActionName,
} from '../../marketing/outbox'
import { promotePayload, retryPayload, saveRiskView, stagePayload } from '../../marketing/payload'
import { SlugProblemError, slugProblem } from '../../marketing/site'

// One role output is a JSON document, not a fixed shape: each producer owns its
// own contract and the columns exist so an audit can say which version of which
// role produced a live page. Validating the inner shape here would put the
// prompt contracts in two places.
const RoleOutput = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])

const SaveOutputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  bundleId: z.string().uuid().optional(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval']),
  artifactCount: z.number().int().min(0),
  message: z.string(),
})

const ArtifactInputSchema = z.object({
  role: z.enum(MARKETING_ROLES),
  kind: z.enum(ARTIFACT_KINDS),
  documentId: z.string().uuid().nullable().default(null),
  textContent: z.string().min(1).max(200_000).nullable().default(null),
})

/**
 * The same rule the 0018 CHECK enforces, run before anything is staged, so a
 * bad artifact set costs nothing rather than leaving a bundle whose asset cannot
 * be rendered.
 */
function checkArtifactShape(artifacts: readonly ArtifactInput[]): void {
  for (const artifact of artifacts) {
    const hasBytes = artifact.kind === 'image'
    if (hasBytes && artifact.documentId === null) {
      throw new Error(`artifact_shape: an image artifact from ${artifact.role} must name a documentId`)
    }
    if (!hasBytes && artifact.textContent === null) {
      throw new Error(`artifact_shape: a ${artifact.kind} artifact from ${artifact.role} must carry textContent`)
    }
  }
}

/**
 * One wording for a spent credential, because the early read and the set-once
 * update are the same refusal seen at two moments: the owner is told the page
 * was already published once and that a new bundle is the way forward.
 */
function leadTokenLocked(bundleId: string): Error {
  return new Error(
    `lead_token_locked: bundle ${bundleId} already carries a credential, so this page was already published once. Save a new bundle.`,
  )
}

async function assertDocumentsVisible(tenantId: string, artifacts: readonly ArtifactInput[]): Promise<void> {
  const ids = artifacts.map((a) => a.documentId).filter((id): id is string => id !== null)
  for (const id of ids) {
    const found = await getDbClient().query<{ id: string }>(
      `SELECT id FROM documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    )
    if (!found.rows[0]) throw new Error(`document_not_found: ${id} is not visible to this tenant`)
  }
}

export const saveBundleTool = createTool({
  id: 'marketing.save_bundle',
  title: 'Save Marketing Bundle',
  description:
    'Store one campaign bundle: the brief, each role output in its own column, and its assets. Writes a draft bundle only. Stages nothing for approval and publishes nothing.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    brief: z.string().min(20).max(4000),
    objective: z.enum(MARKETING_OBJECTIVES),
    audienceNote: z.string().max(2000).nullable().default(null),
    strategy: RoleOutput.nullable().default(null),
    copy: RoleOutput.nullable().default(null),
    mediaPlan: RoleOutput.nullable().default(null),
    funnelPlan: RoleOutput.nullable().default(null),
    analysis: RoleOutput.nullable().default(null),
    promptVersion: z.string().min(1).max(120),
    artifacts: z.array(ArtifactInputSchema).default([]),
  }),
  outputSchema: SaveOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) => {
    return context.observe.span('marketing.save_bundle', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }
      const artifacts = input.artifacts as ArtifactInput[]
      checkArtifactShape(artifacts)
      await assertDocumentsVisible(rc.tenantId, artifacts)

      // Objective decides whether the page must carry a form target. A proof
      // asset with no intake is a document, not a broken funnel.
      let pendingLeadToken: string | null = null
      const page = artifacts.find((a) => a.kind === 'page_html')
      if (input.objective === 'inbound_leads') {
        if (!page?.textContent) {
          throw new Error(
            'needs_page_html: an inbound_leads bundle must carry one page_html artifact holding the landing page',
          )
        }
        const token = mintLeadToken()
        const apiOrigin = process.env.CRUM_LEAD_API_ORIGIN ?? process.env.CRUM_MARKETING_SITE_ORIGIN ?? ''
        const stamp = stampLeadEndpoint(page.textContent, leadEndpointUrl(apiOrigin, token))
        if (!stamp.ok || stamp.html === undefined) {
          throw new Error(
            `lead_endpoint_${stamp.reason ?? 'refused'}: the landing page must hold exactly one ` +
              `${LEAD_ENDPOINT_PLACEHOLDER} in its form action, and this one holds ${stamp.count ?? 0}`,
          )
        }
        page.textContent = stamp.html
        // Stamped before anything is hashed: the artifact id below is derived
        // from these bytes, and the approval signs a site hash over them, so the
        // credential cannot arrive after the hash that covers it.
        pendingLeadToken = token
      }

      // `columns` (hashed just below) and the `payload` handed to getOrCreateDraft
      // are two hand-written views of one bundle: the first keys the idempotency
      // hash, the second becomes the marketing_bundles row the commit writes.
      // Nothing in the type system ties them, so a lane added to one but not the
      // other would silently desync the draft hash from the stored bundle. The
      // coupling is pinned by a test, not a compile error: the marketing-write-
      // tools test recomputes computeBundleHash from the staged payload and
      // asserts it equals the staged idempotency key, which fails if either
      // object drops a lane.
      const columns = {
        brief: input.brief,
        objective: input.objective,
        audienceNote: input.audienceNote,
        strategy: input.strategy,
        copy: input.copy,
        mediaPlan: input.mediaPlan,
        funnelPlan: input.funnelPlan,
        analysis: input.analysis,
        promptVersion: input.promptVersion,
      }
      const draftHash = computeBundleHash(columns)

      const policy = loadPolicy()
      // Scored on the redacted view, deliberately: see src/marketing/payload.ts.
      const assessment = scoreRisk(
        saveRiskView({ objective: input.objective, artifactCount: artifacts.length, bundleDraftHash: draftHash }),
        policy.risk,
        'marketing.save_bundle',
      )
      const gate = policy.gateFor('marketing.save_bundle', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'auto',
        objectType: 'marketing_bundle',
        operation: 'create',
        payload: {
          brief: input.brief,
          objective: input.objective,
          audienceNote: input.audienceNote,
          status: 'draft',
          // jsonb parameters are passed as text on purpose: node-pg turns a
          // plain object into JSON, but turns an array into a Postgres array
          // literal, which is not jsonb and would fail on a top-level list.
          strategy: input.strategy === null ? null : JSON.stringify(input.strategy),
          copy: input.copy === null ? null : JSON.stringify(input.copy),
          mediaPlan: input.mediaPlan === null ? null : JSON.stringify(input.mediaPlan),
          funnelPlan: input.funnelPlan === null ? null : JSON.stringify(input.funnelPlan),
          analysis: input.analysis === null ? null : JSON.stringify(input.analysis),
          promptVersion: input.promptVersion,
          draftHash,
        },
        riskScore: assessment.score,
        gate,
        requestedBy: rc.userId,
        idempotencyKey: `bundle:${draftHash}`,
      })

      // Policy-drift guard, not a prediction of a runtime refusal. While
      // `marketing.save_bundle`'s declared class stays `auto` — pinned by its
      // row in the conformance test's SPEC_TOOL_SURFACE (tests/governance/
      // conformance.test.ts:51) — gateFor returns `auto` for this tool in this
      // lane, so the branch below is unreachable today. It exists so that raising
      // the declared class in policy/tools.yaml cannot silently turn this tool
      // into one that auto-commits what governance now calls an approval-class
      // write: a promotion to `approval` stages the draft and reports it here
      // rather than committing content a human was meant to click.
      if (gate !== 'auto') {
        return {
          pendingWriteId: draft.id,
          riskScore: assessment.score,
          gate: 'approval' as const,
          artifactCount: artifacts.length,
          message: `Bundle staged for approval (${draft.id}). Nothing is stored until it is approved.`,
        }
      }

      const applied = await commitAutoWrite(draft)
      const bundleId = applied.committedRecordId ?? draft.id

      // A credentialed bundle is spent. A re-save of it mints a new token, so
      // the page bytes differ and the content-addressed artifact id differs
      // too: inserting first would leave a second page_html row behind on a
      // bundle whose token then refuses the update, and `slotProblem` will not
      // derive a page from an ambiguous slot, so that bundle could never be
      // staged again. Refusing before the write keeps the one page it had. The
      // read is the early refusal; the conditional update below stays the
      // enforcement when two saves race past it. No row right after a commit is
      // not this refusal, so the path carries on.
      if (pendingLeadToken !== null) {
        const existing = await getMarketingBundle(rc.tenantId, bundleId)
        if (existing !== null && existing.leadToken !== null) throw leadTokenLocked(bundleId)
      }

      // `inserted` counts rows this call newly wrote: an idempotent replay of a
      // save whose artifacts already exist reports 0, not the size of the input.
      const inserted = await insertMarketingArtifacts({
        tenantId: rc.tenantId,
        bundleId,
        artifacts,
      })

      if (pendingLeadToken !== null) {
        const stored = await setBundleLeadToken({
          tenantId: rc.tenantId,
          bundleId,
          token: pendingLeadToken,
        })
        if (!stored) throw leadTokenLocked(bundleId)
      }

      return {
        bundleId,
        pendingWriteId: draft.id,
        riskScore: assessment.score,
        gate: 'auto' as const,
        artifactCount: inserted,
        message: `Bundle saved (${bundleId}) with ${inserted} asset(s). Approve it with marketing.stage_bundle.`,
      }
    })
  },
})

const StageOutputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval']),
  proceed: z.boolean().optional(),
  reason: z.string().optional(),
  message: z.string(),
})

function hashOf(bundle: MarketingBundleRow): string {
  return computeBundleHash(roleColumnsOf(bundle))
}

export const stageBundleTool = createTool({
  id: 'marketing.stage_bundle',
  title: 'Stage Marketing Bundle',
  description:
    'Put one saved bundle in front of a human for approval. Always requires approval. Publishes nothing, spends nothing, and refuses a bundle whose plan asks for an action this build cannot execute.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    bundleId: z.string().uuid(),
    // Minor units. A ceiling is the one number the approver is being asked to
    // trust, so it is stated explicitly rather than buried in the media plan.
    requestedCeilingMinor: z.number().int().min(0).max(10_000_000),
  }),
  outputSchema: StageOutputSchema,
  outputValidation: 'warn',

  /**
   * This scores a placeholder view, not the payload that is finally staged: the
   * real draft hash, objective and counts are not knowable without a database
   * read, and a hook that must stay synchronous and side-effect free cannot do
   * one. It is therefore a pure declared-class check — for an `approval` class
   * tool whose payload is identifiers, hashes and numbers the result is the same
   * whatever the placeholders hold — and `execute` below recomputes the score on
   * the real payload. This is not the authoritative decision.
   */
  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(
      stagePayload({
        bundleId: input.bundleId,
        draftHash: '',
        objective: 'outreach_support',
        artifactCount: 0,
        requestedCeilingMinor: input.requestedCeilingMinor,
        actionCount: 0,
        siteHash: null,
      }),
      policy.risk,
      'marketing.stage_bundle',
    )
    return policy.gateFor('marketing.stage_bundle', assessment, { requestContext }) === 'approval'
  },

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(
      stagePayload({
        bundleId: input.bundleId,
        draftHash: '',
        objective: 'outreach_support',
        artifactCount: 0,
        requestedCeilingMinor: input.requestedCeilingMinor,
        actionCount: 0,
        siteHash: null,
      }),
      policy.risk,
      'marketing.stage_bundle',
    )
    if (policy.gateFor('marketing.stage_bundle', assessment, { requestContext }) === 'refuse') {
      const humanTaskId = await createHumanTask(
        {
          tenantId: requestContext?.['tenantId'] as string,
          runId: toolCallId,
          toolName: 'marketing.stage_bundle',
          riskScore: assessment.score,
          title: `Policy refused stage_bundle: ${input.bundleId}`,
          requestedBy: requestContext?.['userId'] as string,
        },
        'refusal',
      )
      return {
        proceed: false as const,
        output: {
          // The human task id, not the bundle id: nothing was staged, so a
          // caller must not read this as a pending write awaiting a decision.
          pendingWriteId: humanTaskId,
          riskScore: assessment.score,
          gate: 'approval' as const,
          message: 'Policy refuses this bundle. A human task was created; nothing is staged.',
        },
      }
    }
  },

  execute: async (input, context) => {
    return context.observe.span('marketing.stage_bundle', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }

      const bundle = await getMarketingBundle(rc.tenantId, input.bundleId)
      if (!bundle) throw new Error(`not_found: no bundle ${input.bundleId} for this tenant`)
      if (bundle.status !== 'draft' && bundle.status !== 'staged') {
        throw new Error(`bundle_not_stageable: ${bundle.id} is ${bundle.status}`)
      }

      // All four refusals answer the same question — can this build say at all
      // what approving this bundle would cause — so they are one branch, not four
      // copies of the human-task call. An unread plan is checked first because a
      // plan you cannot read is also a plan whose actions you cannot count (Task 5,
      // Ruling T5-D3); the arms after it name the page, the slot and the adapter
      // that would each stop a derivation somewhere further down.
      const unread = unreadPlanColumns(bundle)
      // One read, three uses: the slot check, the hash, and the artifact count the
      // payload and the message report. `countMarketingArtifacts` is gone from this
      // file because a count you cannot name the rows behind is the number this
      // slice stops trusting.
      const artifacts = await listMarketingArtifacts(rc.tenantId, bundle.id)
      const slugIssue = slugProblem(pageSlugOf(bundle))
      // Nothing is derived for a bundle whose page cannot be placed. deriveActions
      // calls resolveSite, which throws SlugProblemError on such a slug, and a throw
      // inside an agent turn is not a refusal a human can act on — the queue entry
      // below is.
      const actions = slugIssue === null ? deriveActions(bundle, artifacts) : []
      const blocked = blockedActions(actions)
      const slotIssue = slotProblemCheck(artifacts)
      // The arms stay in this order because each is a cheaper question than the
      // next: an unread plan cannot be counted, an unnameable page cannot be
      // placed, an ambiguous slot cannot be hashed, and a name with no adapter is
      // a build question, not a bundle question.
      const refusal =
        unread.length > 0
          ? `unreadable ${unread.join(' and ')}`
          : slugIssue !== null
            ? `unusable page slug: ${slugIssue}`
            : slotIssue !== null
              ? `ambiguous page slot: ${slotIssue}`
              : blocked.length > 0
                ? `no adapter for ${blocked.join(', ')}`
                : null
      if (refusal !== null) {
        // Refusing here rather than at commit time is the difference between one
        // wasted review and a queue full of decisions that cannot be made.
        const humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `stage:${bundle.id}`,
            toolName: 'marketing.stage_bundle',
            riskScore: 0,
            title: `Refused stage_bundle: ${refusal}`,
            body: `Bundle ${bundle.id} was not staged: ${refusal}. Nothing is queued and nothing is live.`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
        return {
          proceed: false as const,
          reason: refusal,
          pendingWriteId: humanTaskId,
          riskScore: 0,
          gate: 'approval' as const,
          message: `Staging refused (${refusal}). A human task was created; nothing is staged.`,
        }
      }

      const publish = actions.find((a) => a.action === 'publish_page')
      const payload = stagePayload({
        bundleId: bundle.id,
        // Recomputed from the stored row, never handed back by the caller: jsonb
        // normalisation means the row is the only version that stays stable.
        draftHash: hashOf(bundle),
        objective: bundle.objective,
        artifactCount: artifacts.length,
        requestedCeilingMinor: input.requestedCeilingMinor,
        actionCount: actions.length,
        siteHash: typeof publish?.payload['siteHash'] === 'string' ? publish.payload['siteHash'] : null,
      })

      const policy = loadPolicy()
      const assessment = scoreRisk(payload, policy.risk, 'marketing.stage_bundle')
      const gate = policy.gateFor('marketing.stage_bundle', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'marketing_stage',
        operation: 'update',
        targetId: bundle.id,
        payload,
        riskScore: assessment.score,
        gate,
        requestedBy: rc.userId,
        idempotencyKey: `stage:${bundle.id}:${payload.draftHash}`,
      })

      // After the draft, so a failure above never leaves a bundle marked staged.
      const moved = await markBundleStaged({ tenantId: rc.tenantId, bundleId: bundle.id })
      if (!moved) {
        throw new Error(
          `stage_failed: bundle ${bundle.id} no longer reads as draft or staged, so approval ` +
            `${draft.id} describes a bundle this build cannot honour`,
        )
      }

      /**
       * The row is the truth. getOrCreateDraft's ON CONFLICT is a no-op
       * (src/db/pending-writes.ts:93-95), so when the key already matches an open
       * draft, the stored payload keeps the numbers it was created with and the ones
       * in `payload` above were never written anywhere. Reporting those instead would
       * tell the owner their new ceiling is awaiting approval while the row they are
       * about to click still says the old one, and the ceiling is the one number the
       * approver is being asked to trust.
       */
      const stored = draft.payload as Record<string, unknown>
      const numOf = (key: string, asked: number): number =>
        typeof stored[key] === 'number' ? stored[key] : asked

      return {
        pendingWriteId: draft.id,
        riskScore: draft.riskScore,
        gate: draft.gate === 'auto' ? ('auto' as const) : ('approval' as const),
        message:
          `Bundle ${bundle.id} staged for approval (${draft.id}). ` +
          `${numOf('artifactCount', artifacts.length)} asset(s), ${numOf('actionCount', actions.length)} action(s), ` +
          `ceiling ${numOf('requestedCeilingMinor', input.requestedCeilingMinor)} minor units.`,
      }
    })
  },
})

/**
 * The tokens a caller branches on. Each names one refusal: a slug that cannot
 * be published, bytes that no longer hash to the recorded value, and a bundle
 * with no page to hash are three different answers, and only the last two are
 * about bytes at all. `bundle_is_*` stays open because it names the status the
 * bundle actually holds.
 */
export type PromotionRefusal =
  | 'bad_bundle_id'
  | 'not_found'
  | 'no_published_preview'
  | 'not_executable'
  | 'slug_unpublishable'
  | 'site_hash_moved'
  | 'bundle_unavailable'
  | `bundle_is_${string}`

export type StagePromotionResult =
  | { ok: true; pendingWriteId: string; riskScore: number }
  // `message` is prose for the owner; `reason` stays the token a caller branches
  // on. A sentence overrides the token only when it says something the token
  // cannot, which today is the slug itself inside the unpublishable refusal.
  | { ok: false; reason: PromotionRefusal; message?: string }

// The id shape the uuid columns need. The tools' inputSchemas already ask for a
// uuid, but Task 12's REST routes will pass raw path parameters, and a value
// that is not a uuid cannot be answered by a uuid column at all.
const ID_SHAPE = z.string().uuid()

/**
 * The one implementation of "ask the owner to put that preview on the domain",
 * behind the Mastra tool here and Task 12's REST route. A second copy for HTTP
 * would be a second answer to the same governance question.
 *
 * `userRole` is threaded rather than hard-coded so the signature is stable once
 * `gateFor` consumes it. Today `src/governance/policy.ts` does `void context`
 * and returns a gate that depends only on the score and the declared class: a
 * promotion scored as 'admin' regardless of who asked would report a different
 * gate to the owner than the policy would apply the day it reads a role. Task
 * 11's `stageRetry` takes the same parameter for the same reason.
 */
export async function stagePromotion(params: {
  tenantId: string
  userId: string
  userRole: string
  bundleId: string
}): Promise<StagePromotionResult> {
  if (!ID_SHAPE.safeParse(params.bundleId).success) {
    return { ok: false, reason: 'bad_bundle_id' }
  }

  const bundle = await getMarketingBundle(params.tenantId, params.bundleId)
  if (!bundle) return { ok: false, reason: 'not_found' }
  // `live` is accepted because the owner may ask again for a page already on the
  // domain; anything else has not been through the first approval.
  if (bundle.status !== 'approved' && bundle.status !== 'live') {
    return { ok: false, reason: `bundle_is_${bundle.status}` }
  }

  // The publish this promotion refers to must exist and have succeeded. A
  // promotion staged against a vanished preview is a receipt over nothing, so
  // this is asked before anything is queued, and it is asked first because it
  // is the question about the bundle the caller named.
  const published = await listPublishSucceeded(params.tenantId, params.bundleId)
  if (published.length === 0) return { ok: false, reason: 'no_published_preview' }
  const pageAction = published[0]!

  // Then the build's own capability: an action may not be approvable before it
  // is executable, and a build without a promote adapter would queue a row the
  // drainer could only record as no_adapter.
  if (!isExecutable('promote_page')) return { ok: false, reason: 'not_executable' }

  // The same recomputation the bundle approval does, one step later: a promotion
  // authorises the bytes that are already on the preview URL, and if the bundle
  // was re-saved since, those bytes are not what the reviewer looked at.
  let liveHash: string | null
  try {
    liveHash = await currentSiteHash(params.tenantId, params.bundleId)
  } catch (err) {
    // currentSiteHash resolves the slug through resolveSite, which throws rather
    // than returns null when the slug cannot name a page. The approval path
    // translates the same throw (src/marketing/outbox.ts:276-281). This is its
    // own token, not site_hash_moved: the bytes may be untouched, and a caller
    // that told the owner "the bytes moved" would send them looking in the wrong
    // place. The message names the slug, because that is the part a human can fix.
    if (err instanceof SlugProblemError) {
      return {
        ok: false,
        reason: 'slug_unpublishable',
        message:
          `the page slug ${JSON.stringify(err.slug)} cannot be published, ` +
          'so the preview bytes cannot be put on the domain',
      }
    }
    throw err
  }
  // Null and unequal are two answers, not one: null means there is no page to
  // compare (a missing bundle, a plan with no page, or an ambiguous slot), while
  // unequal means there is a page and it is not the one the reviewer saw.
  if (liveHash === null) return { ok: false, reason: 'bundle_unavailable' }
  if (liveHash !== pageAction.siteHash) {
    return { ok: false, reason: 'site_hash_moved' }
  }

  const payload = promotePayload({ bundleId: bundle.id, pageActionId: pageAction.id, siteHash: pageAction.siteHash })
  const policy = loadPolicy()
  const assessment = scoreRisk(payload, policy.risk, 'marketing.promote_bundle')
  const gate = policy.gateFor('marketing.promote_bundle', assessment, {
    requestContext: { tenantId: params.tenantId, userId: params.userId, userRole: params.userRole },
  })
  const draft = await getOrCreateDraft({
    tenantId: params.tenantId,
    runId: 'pending',
    objectType: 'marketing_promote',
    operation: 'create',
    targetId: bundle.id,
    payload,
    riskScore: assessment.score,
    gate,
    requestedBy: params.userId,
    // One live decision per preview deployment: a re-ask for the same preview
    // lands on the draft that already exists rather than a second one.
    idempotencyKey: `promote:${bundle.id}:${pageAction.id}`,
  })
  // The row, not the request: getOrCreateDraft's ON CONFLICT is a no-op, so an
  // existing draft keeps the score it was created with.
  return { ok: true, pendingWriteId: draft.id, riskScore: draft.riskScore }
}

/**
 * The tokens a retry caller branches on. They mirror the promotion door's set
 * minus the bundle-status questions: an action id replaces a bundle id because
 * the failed row is what a retry names.
 */
export type RetryRefusal =
  | 'bad_action_id'
  | 'not_failed'
  | 'bundle_mismatch'
  | 'not_executable'
  | 'slug_unpublishable'
  | 'site_hash_moved'
  | 'bundle_unavailable'

export type StageRetryResult =
  | { ok: true; pendingWriteId: string; riskScore: number }
  | { ok: false; reason: RetryRefusal; message?: string }

/**
 * The one implementation of "ask the owner for another go at that failed
 * publish", behind the Mastra tool here and Task 12's REST route.
 *
 * A retry is not a re-run inside the failed row: the database caps attempts at
 * 3 and `failed` is terminal, so the decision stages one new queued row cloned
 * from the payload the owner approved the first time. Like the stage and
 * promotion stagers, it refuses before anything is queued when this build
 * cannot execute the action or the bytes no longer hash to what the failed row
 * recorded, because an approval may not exist before its action is executable.
 * Spec section 5.
 *
 * `expectedBundleId` is how a caller that named a bundle says which one it
 * meant. The row is keyed on `actionId` alone, so without it an action of one
 * bundle could be retried through another bundle's URL and the approval would
 * be filed against a bundle the owner is not looking at. The REST route passes
 * its path segment; the Mastra tool omits it because an agent naming only an
 * action is a legitimate request.
 */
export async function stageRetry(params: {
  tenantId: string
  userId: string
  userRole: string
  actionId: string
  expectedBundleId?: string
}): Promise<StageRetryResult> {
  if (!ID_SHAPE.safeParse(params.actionId).success) {
    return { ok: false, reason: 'bad_action_id' }
  }
  const failed = await getFailedAction(params.tenantId, params.actionId)
  if (!failed) return { ok: false, reason: 'not_failed' }
  // Asked before the executable and byte checks because it is a question about
  // the request, not about the bundle: the wrong URL is refused even when the
  // action would have staged, and nothing is queued under the named bundle.
  if (params.expectedBundleId !== undefined && failed.bundleId !== params.expectedBundleId) {
    return { ok: false, reason: 'bundle_mismatch' }
  }
  if (!isExecutable(failed.action as MarketingActionName)) return { ok: false, reason: 'not_executable' }

  let liveHash: string | null
  try {
    liveHash = await currentSiteHash(params.tenantId, failed.bundleId)
  } catch (err) {
    // currentSiteHash resolves the slug through resolveSite, which throws rather
    // than returns null when the slug cannot name a page. The promotion door
    // makes the same translation to the same token. It is not site_hash_moved:
    // the bytes may be untouched, and the message names the slug because that
    // is the part a human can fix.
    if (err instanceof SlugProblemError) {
      return {
        ok: false,
        reason: 'slug_unpublishable',
        message:
          `the page slug ${JSON.stringify(err.slug)} cannot be published, ` +
          'so the failed action cannot be re-queued',
      }
    }
    throw err
  }
  // Null and unequal are two answers, not one: null means the row's bundle has
  // no page to compare (missing, plan without one, or an ambiguous slot), while
  // unequal means there is a page and it is not the bytes the failed row
  // recorded.
  if (liveHash === null) return { ok: false, reason: 'bundle_unavailable' }
  if (liveHash !== failed.siteHash) return { ok: false, reason: 'site_hash_moved' }

  const payload = retryPayload({ actionId: failed.id, siteHash: failed.siteHash })
  const policy = loadPolicy()
  const assessment = scoreRisk(payload, policy.risk, 'marketing.retry_publish')
  const gate = policy.gateFor('marketing.retry_publish', assessment, {
    requestContext: { tenantId: params.tenantId, userId: params.userId, userRole: params.userRole },
  })
  const draft = await getOrCreateDraft({
    tenantId: params.tenantId,
    runId: 'pending',
    objectType: 'marketing_retry',
    operation: 'create',
    targetId: failed.id,
    payload,
    riskScore: assessment.score,
    gate,
    requestedBy: params.userId,
    idempotencyKey: `retry:${failed.id}`,
  })
  return { ok: true, pendingWriteId: draft.id, riskScore: draft.riskScore }
}

/**
 * Refusal reasons are tokens so a caller can branch on them; the sentence the
 * model repeats is prose. The three byte-related tokens answer different
 * questions now, so each gets its own sentence rather than the generic
 * underscore replacement: a slug problem, a missing page and moved bytes are
 * not interchangeable to the person who has to fix them. This is a message, not
 * a scored payload, so spelling the token out is safe here and unreadable
 * otherwise.
 */
const REFUSAL_PROSE: Record<string, string> = {
  slug_unpublishable: 'the page slug cannot be published',
  site_hash_moved: 'the page bytes changed since this action was staged',
  bundle_unavailable: 'the bundle has no publishable page to hash',
  bundle_mismatch: 'the action belongs to a different bundle than the one in the request',
}

function readableReason(reason: string): string {
  return REFUSAL_PROSE[reason] ?? reason.replaceAll('_', ' ')
}

export const promoteBundleTool = createTool({
  id: 'marketing.promote_bundle',
  title: 'Promote Marketing Bundle',
  description:
    'Ask the owner to approve putting a bundle whose preview page is already published onto the live domain. Stages one approval. Publishes nothing until it is approved and drained.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ bundleId: z.string().uuid() }),
  outputSchema: StageOutputSchema,
  outputValidation: 'warn',

  /**
   * Scored on a placeholder, like the stage tool: the action id and hash are not
   * knowable without a database read, and this hook must stay synchronous and
   * side-effect free. The payload is identifiers, hashes and numbers only, so
   * the declared class decides the gate whatever the placeholders hold;
   * `execute` recomputes the score on the payload it actually stages.
   */
  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(
      promotePayload({ bundleId: input.bundleId, pageActionId: '', siteHash: '' }),
      policy.risk,
      'marketing.promote_bundle',
    )
    // The same plain record stagePromotion passes, not Mastra's context wrapper:
    // `gateFor` declares a record, and one shape at both call sites is one thing
    // to keep true when it starts reading the role.
    const rc = requestContext?.all as Record<string, unknown> | undefined
    return policy.gateFor('marketing.promote_bundle', assessment, { requestContext: rc }) === 'approval'
  },

  execute: async (input, context) =>
    context.observe.span('marketing.promote_bundle', async () => {
      const rc = context.requestContext.all as { tenantId: string; userId: string; userRole: string }
      const result = await stagePromotion({
        tenantId: rc.tenantId,
        userId: rc.userId,
        userRole: rc.userRole,
        bundleId: input.bundleId,
      })
      if (!result.ok) {
        // Refusing as a queue entry rather than a throw, the same way the stage
        // tool does: an owner reading a refusal can act on it, and a failed turn
        // leaves no record of why nothing went live.
        const why = result.message ?? readableReason(result.reason)
        const humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `promote:${input.bundleId}`,
            toolName: 'marketing.promote_bundle',
            riskScore: 0,
            title: `Refused promotion of bundle ${input.bundleId}`,
            body: `Not staged: ${why}. Nothing went live.`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
        return {
          pendingWriteId: humanTaskId,
          riskScore: 0,
          gate: 'approval' as const,
          message: `Promotion refused (${why}). A human task was created; nothing is staged.`,
        }
      }
      return {
        pendingWriteId: result.pendingWriteId,
        riskScore: result.riskScore,
        gate: 'approval' as const,
        message: `Promotion staged for approval (${result.pendingWriteId}). The page stays on its preview URL until it is approved and drained.`,
      }
    }),
})

export const retryPublishTool = createTool({
  id: 'marketing.retry_publish',
  title: 'Retry Failed Marketing Publish',
  description:
    'Ask the owner to approve re-queuing one failed publish as a new outbox row. Stages one approval. Never retries inside the failed row, and publishes nothing until the new row is drained.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ actionId: z.string().uuid() }),
  outputSchema: StageOutputSchema,
  outputValidation: 'warn',

  /**
   * Scored on a placeholder, like the other two marketing approvals: the failed
   * row's hash is not knowable without a database read, and this hook must stay
   * synchronous and side-effect free. The payload is identifiers and hashes
   * only, so the declared class decides the gate whatever the placeholder
   * holds; `execute` recomputes the score on the payload it actually stages.
   */
  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(
      retryPayload({ actionId: input.actionId, siteHash: '' }),
      policy.risk,
      'marketing.retry_publish',
    )
    // The same plain record stageRetry passes, not Mastra's context wrapper:
    // `gateFor` declares a record, and one shape at both call sites is one
    // thing to keep true when it starts reading the role.
    const rc = requestContext?.all as Record<string, unknown> | undefined
    return policy.gateFor('marketing.retry_publish', assessment, { requestContext: rc }) === 'approval'
  },

  execute: async (input, context) =>
    context.observe.span('marketing.retry_publish', async () => {
      const rc = context.requestContext.all as { tenantId: string; userId: string; userRole: string }
      const result = await stageRetry({
        tenantId: rc.tenantId,
        userId: rc.userId,
        userRole: rc.userRole,
        actionId: input.actionId,
      })
      if (!result.ok) {
        // Refusing as a queue entry rather than a throw, the same way the stage
        // and promote tools do: an owner reading a refusal can act on it, and a
        // failed turn leaves no record of why nothing was re-queued. The
        // stager's own sentence wins when it has one, because it can name the
        // slug, and no token can.
        const why = result.message ?? readableReason(result.reason)
        const humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `retry:${input.actionId}`,
            toolName: 'marketing.retry_publish',
            riskScore: 0,
            title: `Refused retry of action ${input.actionId}`,
            body: `Not staged: ${why}. Nothing was re-queued.`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
        return {
          pendingWriteId: humanTaskId,
          riskScore: 0,
          gate: 'approval' as const,
          message: `Retry refused (${why}). A human task was created; nothing is staged.`,
        }
      }
      return {
        pendingWriteId: result.pendingWriteId,
        riskScore: result.riskScore,
        gate: 'approval' as const,
        message: `Retry staged for approval (${result.pendingWriteId}). The failed row stays failed; a new action is queued only after it is approved and drained.`,
      }
    }),
})
