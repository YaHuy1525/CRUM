import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { loadPolicy } from '../../governance/policy'
import { scoreRisk } from '../../governance/risk'
import { commitAutoWrite, getOrCreateDraft } from '../../db/pending-writes'
import { getDbClient } from '../../db/client'
import {
  ARTIFACT_KINDS,
  MARKETING_OBJECTIVES,
  MARKETING_ROLES,
  insertMarketingArtifacts,
  type ArtifactInput,
} from '../../db/marketing'
import { computeBundleHash } from '../../marketing/hash'
import { saveRiskView } from '../../marketing/payload'

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
