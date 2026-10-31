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
  getMarketingBundle,
  insertMarketingArtifacts,
  listMarketingArtifacts,
  markBundleStaged,
  roleColumnsOf,
  type ArtifactInput,
  type MarketingBundleRow,
} from '../../db/marketing'
import { computeBundleHash } from '../../marketing/hash'
import {
  blockedActions,
  deriveActions,
  pageSlugOf,
  slotProblemCheck,
  unreadPlanColumns,
} from '../../marketing/outbox'
import { saveRiskView, stagePayload } from '../../marketing/payload'
import { slugProblem } from '../../marketing/site'

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
      // `inserted` counts rows this call newly wrote: an idempotent replay of a
      // save whose artifacts already exist reports 0, not the size of the input.
      const inserted = await insertMarketingArtifacts({
        tenantId: rc.tenantId,
        bundleId,
        artifacts,
      })

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
