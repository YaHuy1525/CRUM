import { createHash } from 'node:crypto'
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
import { SlugProblemError, siteProblem, slugProblem, unreferencedAssetNames } from '../../marketing/site'
import {
  getDesignerArtifactText,
  insertAssetDocument,
  listImageAssetStatuses,
  loadSiteArtifacts,
} from '../../db/marketing-assets'
import { parseAssetPrompts } from '../../marketing/asset-prompts'
import type { AssetPrompt } from '../../marketing/asset-prompts'
import { getImageAdapter } from '../../marketing/image-provider'
import { admitsRun, committedSpendMinor, recordImageSpend } from '../../marketing/image-spend'
import { generateAssetsRiskView } from '../../marketing/payload'

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
  // Optional because this schema answers three tools and only stage produces
  // it: a required field that `promote_bundle` and `retry_publish` never
  // return would put an output-validation warning on every one of their
  // results under their `outputValidation: 'warn'`.
  assetsUnreferenced: z.array(z.string()).optional(),
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

      // The first five refusals answer the same question — can this build say at all
      // what approving this bundle would cause — and the sixth asks whether a
      // reviewer would be signing off a picture nobody has looked at. They are one
      // branch, not six copies of the human-task call. An unread plan is checked
      // first because a plan you cannot read is also a plan whose actions you cannot
      // count (Task 5, Ruling T5-D3); the arms after it name the page, the slot, the
      // picture the page cannot place, the adapter and the unreviewed image that
      // each stop a bundle short of an honest approval.
      const unread = unreadPlanColumns(bundle)
      // One read, five uses: the slot check, the asset question, the hash, the
      // unreferenced-picture report, and the artifact count the payload and the
      // message report. `countMarketingArtifacts` is gone from this file because a
      // count you cannot name the rows behind is the number this slice stops
      // trusting.
      const artifacts = await loadSiteArtifacts(rc.tenantId, bundle.id)
      const slugIssue = slugProblem(pageSlugOf(bundle))
      const slotIssue = slotProblemCheck(artifacts)
      // `siteProblem` asks the slot question first, so with a clean slot anything
      // it returns is an asset sentence: a name with no picture, two pictures with
      // one name, bytes that are not there, a mime with no extension, a page over
      // a ceiling. Stage is the cheapest place any of them can be answered, and a
      // human task is how the answer reaches the person who can change the page.
      const assetIssue = slotIssue === null ? siteProblem(artifacts) : null
      // Nothing is derived for a bundle whose page cannot be placed. `deriveActions`
      // calls `resolveSite`, which throws `SlugProblemError` on an unusable slug and
      // `AssetProblemError` on a placeholder that resolves to nothing or to two
      // pictures, and a throw inside an agent turn is not a refusal a human can act
      // on — the queue entry below is. Both questions are answered above, before this
      // call, precisely so that neither throw has to be caught.
      const actions =
        slugIssue === null && assetIssue === null ? deriveActions(bundle, artifacts) : []
      const blocked = blockedActions(actions)
      // Behind the in-memory check, so a bundle with no picture never issues the
      // second read and no existing stage fixture has to learn about it. The read
      // is Task 5's, not a fresh one filtered to not-ready rows, because the
      // filtering has to be somewhere a test can reach (Ruling 8a) — and because
      // a document that is not a marketing asset is not a picture under review
      // (Ruling 8b).
      const unreviewedTitles = artifacts.some((artifact) => artifact.kind === 'image')
        ? (await listImageAssetStatuses(rc.tenantId, bundle.id))
            .filter((row) => row.kind === 'marketing_asset' && row.status !== 'ready')
            .map((row) => row.title)
        : []
      // The arms stay in this order because each is a cheaper question than the
      // next: an unread plan cannot be counted, an unnameable page cannot be
      // placed, an ambiguous slot cannot be hashed, a slot that resolves to no
      // picture or to two cannot be hashed either, and a name with no adapter is
      // a build question, not a bundle question. The last is the only question
      // that needs the database at all, and the read above pays for it whether or
      // not this arm is reached — an earlier refusal throws the answer away. That
      // is one indexed SELECT against marketing_artifacts_bundle_idx on a path
      // that already writes a human task, so the read stays where a test can see
      // it rather than becoming a closure the chain cannot be read through.
      const refusal =
        unread.length > 0
          ? `unreadable ${unread.join(' and ')}`
          : slugIssue !== null
            ? `unusable page slug: ${slugIssue}`
            : slotIssue !== null
              ? `ambiguous page slot: ${slotIssue}`
              : assetIssue !== null
                ? `unresolvable page asset: ${assetIssue}`
                : blocked.length > 0
                  ? `no adapter for ${blocked.join(', ')}`
                  : unreviewedTitles.length > 0
                    ? // `documents.title` is NOT NULL with no unique constraint
                      // (migrations/0009_crum_documents.sql:30), so two pictures can
                      // share a name. Listing it twice tells the reviewer nothing they
                      // can act on twice, so the refusal names each title once.
                      `unreviewed images: ${[...new Set(unreviewedTitles)].join(', ')}`
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
      // Computed once: the output field and the message sentence answer the same
      // question — which pictures this bundle paid for and no page placed.
      const unreferenced = unreferencedAssetNames(artifacts)
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
        // Paid for, reviewed, and placed nowhere. Publishing it would put bytes on
        // a public host that no reviewer positioned, so `resolveSite` leaves it out
        // and this is the sentence that tells the funnel builder to place it.
        assetsUnreferenced: unreferenced,
        message:
          `Bundle ${bundle.id} staged for approval (${draft.id}). ` +
          `${unreferenced.length > 0 ? `${unreferenced.length} image(s) are not referenced by any page and will not be published: ${unreferenced.join(', ')}. ` : ''}` +
          // The publish this approval queues carries the page's slug, so the
          // answer names the bytes the staged hash covered rather than only the
          // bundle uuid that produced them.
          `${typeof publish?.payload['slug'] === 'string' ? `Approving this queues a publish of the page ${publish.payload['slug']}. ` : ''}` +
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
  // compare (a missing bundle, a plan with no page, an ambiguous slot, or a page
  // whose picture cannot resolve), while unequal means there is a page and it is
  // not the one the reviewer saw.
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
  // no page to compare (missing, plan without one, an ambiguous slot, or a page
  // whose picture cannot resolve), while unequal means there is a page and it is
  // not the bytes the failed row recorded.
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
 * The analyst's scale and kill recommendations stage a draft that changes a
 * campaign's status. A scale (ACTIVE) requires the campaign to be currently
 * paused, so the draft re-activates it; a kill (PAUSED) may target any campaign
 * regardless of its current state, because pausing an already-paused campaign
 * is harmless and the owner may still want the audit trail. Spec section 9.4.
 *
 * Like `stagePromotion`, the function validates before it stages: a campaign
 * that does not exist, or that is already active when the recommendation is to
 * scale, is refused before any row is written. The caller (the analyst cron)
 * logs the refusal and moves on.
 */
export async function stageCampaignStatusChange(args: {
  tenantId: string
  bundleId: string
  campaignExternalId: string
  status: 'ACTIVE' | 'PAUSED'
  reason: string
  userRole: string
}): Promise<string> {
  const db = getDbClient()

  // The campaign must have been created by a succeeded create_campaign action.
  // A draft over a campaign that does not exist would authorise nothing, so
  // this is asked before anything is queued.
  const created = await db.query<{ id: string }>(
    `SELECT id FROM marketing_actions
      WHERE tenant_id = $1
        AND action = 'create_campaign'
        AND status = 'succeeded'
        AND result ->> 'externalId' = $2`,
    [args.tenantId, args.campaignExternalId],
  )
  if (created.rows.length === 0) {
    throw new Error(
      `campaign_not_found: no succeeded create_campaign action for external id ${args.campaignExternalId}`,
    )
  }

  // A scale recommendation activates a paused campaign. If the campaign is
  // already active, the draft would change nothing, so refuse before staging.
  // A kill recommendation pauses a campaign regardless of its current state,
  // so no status check is needed for PAUSED.
  if (args.status === 'ACTIVE') {
    const latest = await db.query<{ status: string }>(
      `SELECT payload ->> 'status' AS status
         FROM marketing_actions
        WHERE tenant_id = $1
          AND action = 'set_campaign_status'
          AND payload ->> 'campaignId' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [args.tenantId, args.campaignExternalId],
    )
    // No status change means the campaign is still in its initial paused state
    // (campaigns are created paused, spec section 2). A latest status of ACTIVE
    // means the campaign is already running, so a scale draft would be a no-op.
    if (latest.rows.length > 0 && latest.rows[0]!.status === 'ACTIVE') {
      throw new Error(
        `campaign_already_active: ${args.campaignExternalId} is already active, cannot scale`,
      )
    }
  }

  // The payload is identifiers and a status only: no prose, no slug, no bytes.
  // scoreRisk stringifies the whole draft, so keeping it free of agent-written
  // text keeps the score stable across runs that differ only in the reason.
  const payload = { campaignId: args.campaignExternalId, status: args.status }
  const policy = loadPolicy()
  const assessment = scoreRisk(payload, policy.risk, 'marketing.set_campaign_status')
  const gate = policy.gateFor('marketing.set_campaign_status', assessment, {
    requestContext: { tenantId: args.tenantId, userRole: args.userRole },
  })

  // One draft per campaign per desired status: a re-ask for the same change
  // lands on the existing draft rather than a second one.
  const draft = await getOrCreateDraft({
    tenantId: args.tenantId,
    runId: 'analyst-cron',
    objectType: 'marketing_set_campaign_status',
    operation: 'update',
    targetId: args.campaignExternalId,
    payload,
    riskScore: assessment.score,
    gate,
    requestedBy: 'analyst-cron',
    idempotencyKey: `campaign_status:${args.campaignExternalId}:${args.status}`,
  })
  return draft.id
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

/**
 * The codes this tool can put in `refused[].code`, in the order the refusal chain
 * reaches them: run-level `not_found`, `bundle_not_generable`,
 * `image_provider_not_configured`, `no_asset_prompts`, `asset_prompts_unparsable`,
 * `image_spend_ceiling_reached`, `policy_gate_raised`; per-asset
 * `image_generation_failed`, `image_generation_timeout`, `asset_too_large`,
 * `prompt_too_long`, `unsupported_aspect_ratio` (the five `ImageFailureCode` values
 * `src/marketing/replicate.ts:26-31` can answer with, carried through verbatim) and
 * `asset_storing_failed`.
 *
 * The adapter check (`getImageAdapter()`) comes before the artifact read
 * (`getDesignerArtifactText`) on purpose, so a run with no adapter
 * registered and an unparsable artifact answers `image_provider_not_configured`,
 * not `asset_prompts_unparsable`: the adapter is the cheaper of the two questions
 * and it is the one that decides whether any request could leave at all. Both
 * refusals bail before a cent is spent, so the order costs nothing but the code,
 * which is why it is not reordered.
 *
 * This is a comment and not a `const`, for two reasons an implementer would
 * otherwise hit in Step 7: a module-scope `const` nothing reads is a
 * `no-unused-vars` error in this repo, and the first draft of this list named only
 * two of the five adapter codes, so any list-shaped assertion would have been
 * wrong. Task 13's console groups by code and cannot import across its package
 * boundary, so no consumer of an array here exists to keep it honest.
 */

// A bundle someone already shipped or already threw away is not a bundle to buy
// art for. Everything else in the enum (draft, staged, approved, publishing,
// failed) is a bundle whose asset set is still live work.
const NOT_GENERABLE_STATUSES = new Set(['live', 'archived'])

const GenerateAssetsOutputSchema = z.object({
  bundleId: z.string().uuid(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        documentId: z.string().uuid(),
        status: z.string(),
        deduplicated: z.boolean(),
        costMinor: z.number().int().min(0),
      }),
    )
    .default([]),
  refused: z
    .array(z.object({ name: z.string(), code: z.string(), detail: z.string() }))
    .default([]),
  spentMinor: z.number().int().min(0),
  // Null on a run that never found an adapter, which is the one refusal that
  // happens before the provider is even named.
  provider: z.string().nullable(),
  model: z.string().nullable(),
  humanTaskId: z.string().uuid().nullable(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval', 'refuse']),
  message: z.string(),
})

/**
 * The seed is a function of the bundle and the asset name, not of the clock.
 *
 * Spec section 6's idempotency claim depends on it: a re-run has to produce
 * byte-identical output for the sha256 dedup to reuse the row it already paid
 * for, and a random seed makes every run a fresh purchase. Eight hex digits
 * masked under 2^31 stays exactly representable through `parseInt`, so the
 * number Replicate sees is the number this line computed.
 */
function seedFor(bundleId: string, assetName: string): number {
  const hex = createHash('sha256').update(`${bundleId}\u0000${assetName}`).digest('hex')
  return Number.parseInt(hex.slice(0, 8), 16) % 2147483647
}

/**
 * A refusal detail is owner-facing copy: it goes into the tool output the model
 * reads and into `human_tasks.body`, where it is joined with every other detail in
 * the run. Task 5's parser is the reason this bound exists —
 * `src/marketing/asset-prompts.ts:49` interpolates `JSON.stringify(parsed)`, so a
 * designer artifact that is a 2 MB JSON array produces a 2 MB refusal string, and
 * the parked finding at the end of Task 5's review named this layer as the one that
 * owns message length. The adapter's own `detail` is the other lane: it carries
 * provider prose. Every `detail:` built from text this tool did not write passes
 * through here; the template literals in between interpolate only ids, statuses and
 * numbers.
 */
const DETAIL_LIMIT = 400

function boundedDetail(detail: string): string {
  return detail.length <= DETAIL_LIMIT ? detail : `${detail.slice(0, DETAIL_LIMIT - 1)}\u2026`
}

/**
 * The prose half of a human task. The tool output keeps every refusal — an owner
 * deciding what the bundle is missing reads that list — but `human_tasks.body` is
 * one line in a queue, and `pending.length` is bounded only by the document ceiling
 * the designer's artifact was written under. Without this, a bundle whose artifact
 * is a 5,000-prompt array writes 5,000 sentences into one row.
 */
function refusedProse(entries: Array<{ name: string; code: string; detail: string }>): string {
  const shown = entries.slice(0, 10).map((entry) => `${entry.name}: ${entry.code}: ${entry.detail}`)
  const more = entries.length - shown.length
  return more > 0 ? `${shown.join(' ')} \u2026and ${more} more.` : shown.join(' ')
}

export const generateAssetsTool = createTool({
  id: 'marketing.generate_assets',
  title: 'Generate Campaign Images',
  description:
    'Turn the creative designer\u2019s stored asset prompts into images through the configured image provider. Writes documents and spends from the daily image budget. Takes no prompts: it reads only what the bundle already holds.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ bundleId: z.string().uuid() }),
  outputSchema: GenerateAssetsOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) => {
    return context.observe.span('marketing.generate_assets', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }

      const assets: Array<{
        name: string
        documentId: string
        status: string
        deduplicated: boolean
        costMinor: number
      }> = []
      const refused: Array<{ name: string; code: string; detail: string }> = []
      let spentMinor = 0

      const bundle = await getMarketingBundle(rc.tenantId, input.bundleId)
      if (bundle === null) {
        refused.push({ name: '*', code: 'not_found', detail: `No bundle ${input.bundleId} in this tenant.` })
      } else if (NOT_GENERABLE_STATUSES.has(bundle.status)) {
        refused.push({
          name: '*',
          code: 'bundle_not_generable',
          detail: `Bundle ${bundle.id} is ${bundle.status}; images are not bought for a campaign already shipped or archived.`,
        })
      }

      const adapter = refused.length === 0 ? getImageAdapter() : null
      if (refused.length === 0 && adapter === null) {
        refused.push({
          name: '*',
          code: 'image_provider_not_configured',
          detail: 'No image adapter is registered, so CRUM_REPLICATE_API_TOKEN is unset. Nothing was requested and nothing was spent.',
        })
      }

      let prompts: AssetPrompt[] = []
      if (refused.length === 0 && adapter !== null && bundle !== null) {
        const stored = await getDesignerArtifactText(rc.tenantId, bundle.id)
        const parsed = parseAssetPrompts(stored)
        if (!parsed.ok) {
          refused.push({ name: '*', code: parsed.reason, detail: boundedDetail(parsed.detail) })
        } else {
          prompts = parsed.prompts
        }
      }

      // The carry check is the whole idempotency story: an asset the bundle
      // already attaches under this name is reported from the row that exists
      // and never re-ordered. Titles are the asset names the designer wrote and
      // the reviewer reads, so this is the same identity, not a second one.
      const carried = new Map<string, { documentId: string; status: string }>()
      if (refused.length === 0 && prompts.length > 0 && bundle !== null) {
        for (const row of await listImageAssetStatuses(rc.tenantId, bundle.id)) {
          carried.set(row.title, { documentId: row.documentId, status: row.status })
        }
      }

      const pending: AssetPrompt[] = []
      for (const entry of prompts) {
        const existing = carried.get(entry.name)
        if (existing) {
          assets.push({
            name: entry.name,
            documentId: existing.documentId,
            status: existing.status,
            deduplicated: true,
            costMinor: 0,
          })
        } else {
          pending.push(entry)
        }
      }

      const policy = loadPolicy()
      const estimatedCostMinor = pending.length * (adapter?.costMinorPerImage ?? 0)
      const assessment = scoreRisk(
        generateAssetsRiskView({
          bundleId: input.bundleId,
          objective: bundle?.objective ?? 'outreach_support',
          assetCount: pending.length,
          estimatedCostMinor,
        }),
        policy.risk,
        'marketing.generate_assets',
      )
      const gate = policy.gateFor('marketing.generate_assets', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      // Unreachable while the declared class stays `auto`, and the reason it is
      // here is the reason saveBundleTool's identical branch is here
      // (src/mastra/tools/marketing-writes.ts:231-244): if somebody raises the
      // class in policy/tools.yaml, this tool must stop buying pictures rather
      // than carry on auto-committing what governance now calls an approval.
      if (refused.length === 0 && gate !== 'auto' && pending.length > 0) {
        refused.push({
          name: '*',
          code: 'policy_gate_raised',
          detail: `Governance now gates marketing.generate_assets at "${gate}". A run that costs money is not an unreviewed write.`,
        })
      }

      // A run with nothing pending has nothing to buy, so it never reaches the
      // ceiling check: admitsRun is false for an empty count by design (Task 4),
      // and a fully-carried bundle is a success, not a refusal.
      let committedMinor = 0
      if (refused.length === 0 && pending.length > 0 && adapter !== null) {
        committedMinor = await committedSpendMinor(rc.tenantId)
        if (
          !admitsRun({
            ceilingMinor: adapter.ceilingMinor,
            committedMinor,
            costMinorPerImage: adapter.costMinorPerImage,
            assetCount: pending.length,
          })
        ) {
          // One refusal per pending asset, not one `'*'` for the whole run. Two
          // reasons, and they point the same way: the mid-loop boundary refusal
          // below already names every asset left in the queue, because an owner
          // reading the human task has to be able to tell what the bundle is
          // missing; and Step 8's integration case reads `refused.map(r => r.code)`
          // as two `image_spend_ceiling_reached` entries under a human task titled
          // "refused 2 asset(s)". A run-level `'*'` here writes one entry and titles
          // it "1", so the plan's two halves disagreed with each other.
          for (const entry of pending) {
            refused.push({
              name: entry.name,
              code: 'image_spend_ceiling_reached',
              detail:
                `Not attempted: today's image spend is ${committedMinor} minor with a ${adapter.ceilingMinor} ceiling, ` +
                `and ${pending.length} asset(s) at ${adapter.costMinorPerImage} minor each need ${estimatedCostMinor}. ` +
                'Raise CRUM_IMAGE_SPEND_CEILING_MINOR or run tomorrow. Nothing was requested.',
            })
          }
        }
      }

      const attached: ArtifactInput[] = []
      if (refused.length === 0 && bundle !== null && adapter !== null) {
        for (let index = 0; index < pending.length; index += 1) {
          const entry = pending[index]!
          const nowCommitted = await committedSpendMinor(rc.tenantId)
          if (
            !admitsRun({
              ceilingMinor: adapter.ceilingMinor,
              committedMinor: nowCommitted,
              costMinorPerImage: adapter.costMinorPerImage,
              assetCount: 1,
            })
          ) {
            // The boundary moved under the run, because what the provider
            // charged exceeded the estimate that admitted it. Every asset left
            // in the queue is reported as refused: an owner reading the human
            // task has to be able to tell what the bundle is missing.
            for (const stopped of pending.slice(index)) {
              refused.push({
                name: stopped.name,
                code: 'image_spend_ceiling_reached',
                detail: `Not attempted: today's spend reached ${nowCommitted} of a ${adapter.ceilingMinor} minor ceiling.`,
              })
            }
            break
          }

          const seed = seedFor(bundle.id, entry.name)
          const outcome = await adapter.generate({
            prompt: entry.prompt,
            aspectRatio: entry.aspectRatio,
            seed,
            negativePrompt: entry.negativePrompt,
          })

          if (!outcome.ok) {
            if (outcome.charge !== null) {
              await recordImageSpend({
                tenantId: rc.tenantId,
                documentId: null,
                costMinor: outcome.charge.costMinor,
                // Named, not left to image-spend.ts's default. That default is
                // REPLICATE_PROVIDER, so omitting it would book a row saying
                // 'replicate' while this run's output reports `adapter.provider`
                // in its own return — the ledger and the answer disagreeing for
                // any adapter that is not Replicate.
                provider: adapter.provider,
                rawExtract: {
                  predictionId: outcome.charge.predictionId,
                  model: adapter.model,
                  costUsd: outcome.charge.costUsd,
                },
              })
              spentMinor += outcome.charge.costMinor
            }
            refused.push({ name: entry.name, code: outcome.code, detail: boundedDetail(outcome.detail) })
            if (outcome.deadToken) {
              for (const stopped of pending.slice(index + 1)) {
                refused.push({
                  name: stopped.name,
                  code: 'image_generation_failed',
                  detail: 'Not attempted: the provider rejected the API token, so the run stopped rather than paying forty visits to a dead credential.',
                })
              }
              break
            }
            continue
          }

          // The provider has already been charged by the time this line runs, and
          // `insertAssetDocument` rejects before it touches the database when the
          // bytes handed to it are 0 long (`src/db/marketing-assets.ts:75`), while
          // any real document write can reject too. The first draft of this tool
          // booked the spend *after* the insert with nothing around it, so such a
          // rejection escaped `execute`: no ledger row for money already spent, no
          // human task, and a tool error as the only trace. Spec section 9's
          // "money spent, nothing usable" case is the one that must still be
          // invoiced, and `src/marketing/image-spend.ts:65-69` already says an
          // invoice for an image we failed to save is a real cost.
          //
          // The run stops here rather than continuing to the next asset, for the
          // same reason a 401 stops it above: a lane that refuses one image is
          // refusing them all, and each remaining asset would buy a prediction CRUM
          // cannot store. `asset_storing_failed` is deterministic per adapter
          // output, so nothing is lost by stopping — the next run reuses the bytes
          // it already has and re-orders only what is genuinely missing.
          let document: { id: string; status: string; deduplicated: boolean }
          try {
            document = await insertAssetDocument({
              tenantId: rc.tenantId,
              ownerId: rc.userId,
              title: entry.name,
              bytes: outcome.image.bytes,
              mime: outcome.image.mime,
              provenance: {
                replicateId: outcome.image.predictionId,
                model: outcome.image.model,
                aspectRatio: outcome.image.aspectRatio,
                negativePrompt: entry.negativePrompt,
                costMinor: outcome.image.costMinor,
                seed,
                prompt: entry.prompt,
              },
            })
          } catch (err) {
            // Not wrapped, on purpose: a ledger write that cannot be made is the
            // tool failing loudly, which is Task 4's fail-closed ruling. Defaulting
            // it would silently un-invoice the run.
            await recordImageSpend({
              tenantId: rc.tenantId,
              documentId: null,
              costMinor: outcome.image.costMinor,
              provider: adapter.provider,
              rawExtract: {
                predictionId: outcome.image.predictionId,
                model: outcome.image.model,
                costUsd: outcome.image.costUsd,
              },
            })
            spentMinor += outcome.image.costMinor
            refused.push({
              name: entry.name,
              code: 'asset_storing_failed',
              detail: boundedDetail(err instanceof Error ? err.message : String(err)),
            })
            for (const stopped of pending.slice(index + 1)) {
              refused.push({
                name: stopped.name,
                code: 'asset_storing_failed',
                detail: 'Not attempted: the document lane refused the previous image, so the run stopped rather than paying for pictures CRUM cannot store.',
              })
            }
            break
          }

          // Booked after the insert and pointing at the row the insert returned,
          // so a re-run that reused the bytes still books the prediction that
          // cost money to make. The ledger is what the day cost, not what the
          // bundle gained.
          await recordImageSpend({
            tenantId: rc.tenantId,
            documentId: document.id,
            costMinor: outcome.image.costMinor,
            provider: adapter.provider,
            rawExtract: {
              predictionId: outcome.image.predictionId,
              model: outcome.image.model,
              costUsd: outcome.image.costUsd,
            },
          })
          spentMinor += outcome.image.costMinor

          assets.push({
            name: entry.name,
            documentId: document.id,
            status: document.status,
            deduplicated: document.deduplicated,
            costMinor: outcome.image.costMinor,
          })
          attached.push({
            role: 'creative-designer',
            kind: 'image',
            documentId: document.id,
            textContent: null,
          })
        }
      }

      if (attached.length > 0 && bundle !== null) {
        await insertMarketingArtifacts({
          tenantId: rc.tenantId,
          bundleId: bundle.id,
          artifacts: attached,
        })
      }

      let humanTaskId: string | null = null
      if (refused.length > 0 && bundle !== null) {
        const codes = Array.from(new Set(refused.map((entry) => entry.code))).join(', ')
        humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `assets:${bundle.id}`,
            toolName: 'marketing.generate_assets',
            riskScore: assessment.score,
            title: `Image run for bundle ${bundle.id} refused ${refused.length} asset(s)`,
            body:
              `Refused codes: ${codes}. Newly stored: ${attached.length}. Reused from the bundle: ${assets.length - attached.length}. ` +
              `Recorded spend: ${spentMinor} minor. ${refusedProse(refused)}`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
      }

      // One path leaves `bundle` null: the `not_found` refusal above. It always
      // fills `refused`, so a run with no row to name is a run that bought nothing
      // because there was nothing to buy — and a refusal message that interpolates
      // `bundle.id` on its way to saying so throws instead of saying it. The id the
      // caller asked for is the id worth naming when there is no row, and it is the
      // same expression the `bundleId` field below returns, hoisted here so the
      // prose and the field cannot drift apart.
      const bundleLabel = bundle?.id ?? input.bundleId

      // The human-task block above is guarded by `bundle !== null`, so the
      // `not_found` run files no task at all. Prose that promised one would be
      // this tool telling an owner it parked something it never parked, so the
      // sentence follows `humanTaskId` rather than the refusal.
      const taskSentence =
        humanTaskId === null
          ? ' No human task was created because there is no bundle row to file one against.'
          : ' A human task was created.'

      const message =
        refused.length === 0
          ? `Stored ${attached.length} new image(s) for bundle ${bundleLabel}, reused ${assets.length - attached.length}, recorded ${spentMinor} minor of image spend. Each new image is needs_review until you review it.`
          : `Refused ${refused.length} asset(s) for bundle ${bundleLabel} (${Array.from(new Set(refused.map((entry) => entry.code))).join(', ')}). Stored ${attached.length}, recorded ${spentMinor} minor.${taskSentence}`

      return {
        bundleId: bundleLabel,
        assets,
        refused,
        spentMinor,
        provider: adapter?.provider ?? null,
        model: adapter?.model ?? null,
        humanTaskId,
        riskScore: assessment.score,
        gate,
        message,
      }
    })
  },
})
