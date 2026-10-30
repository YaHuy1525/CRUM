import { createHash } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { loadPolicy } from '../../governance/policy'
import { scoreRisk } from '../../governance/risk'
import { getOrCreateDraft, createHumanTask } from '../../db/pending-writes'
import { getDbClient } from '../../db/client'
import { checkDraft, type DraftChannel } from '../../prospects/draft-rules'
import { checkSendCaps, type SendChannel, type SendKind, type SendLedgerEntry } from '../../prospects/caps'

const ApprovalOutputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto', 'approval']),
  message: z.string(),
  // A caps refusal stages nothing, so it reports the refusal on the output
  // rather than pretending a write was queued.
  proceed: z.boolean().optional(),
  reason: z.string().optional(),
})

// The send kind is a property of the channel row, never of caller input: a
// caller could otherwise claim `linkedin` (manual, 30/day) while pointing at an
// Instagram channel and spend the wrong budget.
function sendKindFor(platform: string): SendKind {
  if (platform === 'email') return 'email'
  if (platform === 'linkedin') return 'manual'
  return 'dm'
}

// Drafts only know two media: email bodies and everything-else DMs. The
// platform row decides which rules apply, so a caller cannot claim `email` while
// pointing at an Instagram channel to dodge the first-touch link ban.
function draftChannelFor(platform: string): DraftChannel {
  return platform === 'email' ? 'email' : 'dm'
}

const SnapshotOutputSchema = z.object({
  snapshotId: z.string().uuid(),
  deduped: z.boolean(),
})

export const draftOutreachTool = createTool({
  id: 'crm.draft_outreach',
  title: 'Draft Outreach',
  description: 'Write a message for one prospect. Sends nothing and never bypasses the draft rules.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    prospectId: z.string().uuid(),
    channelId: z.string().uuid(),
    stage: z.enum(['first_touch', 'followup_1', 'followup_2']),
    channel: z.enum(['dm', 'email']),
    body: z.string().min(1),
    language: z.enum(['en', 'vi']),
    angle: z.enum(['funnel_gap', 'audience_leak', 'offer_productisation', 'proof']),
    evidenceSnapshotId: z.string().uuid().nullable(),
    promptVersion: z.string().min(1),
    draftHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',

  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.draft_outreach')
    return policy.gateFor('crm.draft_outreach', assessment, { requestContext }) === 'approval'
  },

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.draft_outreach')
    const gate = policy.gateFor('crm.draft_outreach', assessment, { requestContext })

    if (gate === 'refuse') {
      const tenantId = requestContext?.['tenantId'] as string
      const userId = requestContext?.['userId'] as string
      await createHumanTask({
        tenantId,
        runId: toolCallId,
        toolName: 'crm.draft_outreach',
        riskScore: assessment.score,
        title: `Policy refused draft_outreach: ${input.prospectId}`,
        requestedBy: userId,
      }, 'refusal')
      return {
        proceed: false as const,
        output: {
          pendingWriteId: toolCallId,
          riskScore: assessment.score,
          gate: 'approval' as const,
          message: 'Policy refuses this draft. A human task was created; nothing is staged.',
        },
      }
    }
  },

  execute: async (input, context) => {
    return context.observe.span('crm.draft_outreach', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }
      const db = getDbClient()

      // Every id in the payload is checked against this tenant before anything
      // is staged. A FK alone would accept a prospect, channel or snapshot that
      // belongs to somebody else.
      const prospect = await db.query<{ id: string }>(
        `SELECT id FROM prospects WHERE id = $1 AND tenant_id = $2`,
        [input.prospectId, rc.tenantId],
      )
      if (!prospect.rows[0]) throw new Error('not_found')

      const channel = await db.query<{ platform: string }>(
        `SELECT platform FROM prospect_channels WHERE id = $1 AND tenant_id = $2`,
        [input.channelId, rc.tenantId],
      )
      const channelRow = channel.rows[0]
      if (!channelRow) throw new Error('not_found')

      if (input.evidenceSnapshotId !== null) {
        const snapshot = await db.query<{ id: string }>(
          `SELECT id FROM prospect_snapshots WHERE id = $1 AND tenant_id = $2`,
          [input.evidenceSnapshotId, rc.tenantId],
        )
        if (!snapshot.rows[0]) throw new Error('not_found')
      }

      const effectiveChannel = draftChannelFor(channelRow.platform)
      if (input.channel !== effectiveChannel) throw new Error('channel_mismatch')

      // Stages are ordered: a follow-up may only follow a send that actually
      // happened for this prospect.
      if (input.stage !== 'first_touch') {
        const sent = await db.query<{ id: string }>(
          `SELECT d.id FROM outreach_drafts d
            WHERE d.prospect_id = $1 AND d.tenant_id = $2 AND d.status = 'sent'
            LIMIT 1`,
          [input.prospectId, rc.tenantId],
        )
        if (!sent.rows[0]) throw new Error('stage_order')
      }

      const violations = checkDraft({
        body: input.body,
        channel: effectiveChannel,
        stage: input.stage,
        evidenceSnapshotId: input.evidenceSnapshotId,
      })
      if (violations.length > 0) {
        throw new Error(`draft rejected: ${violations.join(', ')}`)
      }

      const policy = loadPolicy()
      const assessment = scoreRisk(input, policy.risk, 'crm.draft_outreach')
      const gate = policy.gateFor('crm.draft_outreach', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'outreach_draft',
        operation: 'create',
        payload: {
          prospectId: input.prospectId,
          channelId: input.channelId,
          stage: input.stage,
          body: input.body,
          language: input.language,
          angle: input.angle,
          status: 'drafted',
          evidenceSnapshotId: input.evidenceSnapshotId,
          promptVersion: input.promptVersion,
          draftHash: input.draftHash,
        },
        riskScore: assessment.score,
        gate,
        requestedBy: rc.userId,
        idempotencyKey: input.draftHash,
      })

      return {
        pendingWriteId: draft.id,
        riskScore: assessment.score,
        gate: gate === 'refuse' ? ('approval' as const) : gate,
        message: `Draft staged (${draft.id}).`,
      }
    })
  },
})

export const sendOutreachTool = createTool({
  id: 'crm.send_outreach',
  title: 'Send Outreach',
  description:
    'Stage a send for an approved draft. Always requires human approval. DMs and LinkedIn are marked sent by hand, email only with recorded consent.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    draftId: z.string().uuid(),
    channel: z.enum(['instagram', 'linkedin', 'facebook', 'tiktok', 'shopee', 'email']),
    actionHash: z.string().min(1),
  }),
  outputSchema: ApprovalOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  beforeApproval: async (input, { toolCallId, requestContext }) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(input, policy.risk, 'crm.send_outreach')
    if (policy.gateFor('crm.send_outreach', assessment) === 'refuse') {
      await createHumanTask({
        tenantId: requestContext?.['tenantId'] as string,
        runId: toolCallId,
        toolName: 'crm.send_outreach',
        riskScore: assessment.score,
        title: `Policy refused send_outreach: ${input.draftId}`,
        requestedBy: requestContext?.['userId'] as string,
      }, 'refusal')
      return {
        proceed: false as const,
        output: {
          pendingWriteId: toolCallId,
          riskScore: assessment.score,
          gate: 'approval' as const,
          message: 'Policy refuses this send. A human task was created.',
        },
      }
    }
  },

  execute: async (input, context) => {
    return context.observe.span('crm.send_outreach', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }
      const db = getDbClient()

      // A send is authorised against the stored draft, not the payload. The
      // replay guard reads `status` from the same row the commit will update.
      const loaded = await db.query<{
        id: string
        prospect_id: string
        channel_id: string
        status: string
      }>(
        `SELECT id, prospect_id, channel_id, status FROM outreach_drafts WHERE id = $1 AND tenant_id = $2`,
        [input.draftId, rc.tenantId],
      )
      const draftRow = loaded.rows[0]
      if (!draftRow) throw new Error('draft_not_found')
      if (draftRow.status === 'sent') throw new Error('already_sent')

      const channel = await db.query<{ platform: string }>(
        `SELECT platform FROM prospect_channels WHERE id = $1 AND tenant_id = $2`,
        [draftRow.channel_id, rc.tenantId],
      )
      const channelRow = channel.rows[0]
      if (!channelRow) throw new Error('channel_not_found')

      // Consent is recorded per prospect, so its absence is what blocks an
      // email. The cap engine decides whether that absence matters.
      const consent = await db.query<{ present: number }>(
        `SELECT 1 FROM prospect_consents WHERE prospect_id = $1 AND tenant_id = $2`,
        [draftRow.prospect_id, rc.tenantId],
      )

      const ledgerResult = await db.query<{
        prospect_id: string
        platform: string
        sent_at: string | Date
      }>(
        `SELECT d.prospect_id, c.platform, d.sent_at
           FROM outreach_drafts d
           JOIN prospect_channels c ON c.id = d.channel_id
          WHERE d.tenant_id = $1 AND d.status = 'sent'`,
        [rc.tenantId],
      )
      const ledger: SendLedgerEntry[] = ledgerResult.rows.map((row) => ({
        prospectId: row.prospect_id,
        channel: row.platform as SendChannel,
        kind: sendKindFor(row.platform),
        sentAt: new Date(row.sent_at),
      }))

      const decision = checkSendCaps({
        prospectId: draftRow.prospect_id,
        channel: channelRow.platform as SendChannel,
        kind: sendKindFor(channelRow.platform),
        now: new Date(),
        timeZone: process.env.PROSPECT_TIMEZONE ?? 'Australia/Sydney',
        consented: consent.rows.length > 0,
        ledger,
      })

      const policy = loadPolicy()
      const assessment = scoreRisk(input, policy.risk, 'crm.send_outreach')

      if (!decision.allowed) {
        await createHumanTask({
          tenantId: rc.tenantId,
          runId: `send:${input.draftId}`,
          toolName: 'crm.send_outreach',
          riskScore: assessment.score,
          title: `Refused send_outreach: ${decision.reason}`,
          body: `Draft ${input.draftId} refused by send caps (${decision.reason}); nothing was staged.`,
          requestedBy: rc.userId,
        }, 'refusal')
        return {
          proceed: false as const,
          reason: decision.reason,
          pendingWriteId: input.draftId,
          riskScore: assessment.score,
          gate: 'approval' as const,
          message: `Send refused (${decision.reason}). A human task was created; nothing is staged.`,
        }
      }

      const gate = policy.gateFor('crm.send_outreach', assessment, {
        requestContext: { tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole },
      })

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'pending',
        objectType: 'outreach_send',
        operation: 'update',
        targetId: input.draftId,
        payload: { status: 'sent', sentAt: new Date().toISOString() },
        riskScore: assessment.score,
        gate,
        requestedBy: rc.userId,
        // Caller-supplied `actionHash` cannot key this: after the first send
        // commits, a replay would stage a second receipt and sent_at.
        idempotencyKey: `send:${input.draftId}`,
      })

      return {
        pendingWriteId: draft.id,
        riskScore: assessment.score,
        gate: gate === 'refuse' ? ('approval' as const) : gate,
        message: `Send staged for approval (${draft.id}).`,
      }
    })
  },
})

/**
 * A snapshot is append-only derived evidence, so it is not a staged write: it
 * commits directly, and the correlation id is folded into the row id so a
 * retried call cannot append the same evidence twice. Bypassing pending_writes
 * is deliberate — see the task-11 report.
 */
function snapshotIdFor(tenantId: string, prospectId: string, correlationId: string): string {
  const hex = createHash('sha256').update(`${tenantId}:${prospectId}:${correlationId}`).digest('hex')
  // RFC 9562 UUIDv8 layout: random bits, version nibble 8, RFC variant.
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

export const saveProspectSnapshotTool = createTool({
  id: 'crm.save_prospect_snapshot',
  title: 'Save Prospect Snapshot',
  description: 'Record enrichment evidence for one prospect. Evidence is append-only.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    prospectId: z.string().uuid(),
    whatTheySell: z.string().nullable(),
    priceMinMinor: z.number().int().nonnegative().nullable(),
    priceMaxMinor: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3).nullable(),
    priceVisible: z.boolean().default(false),
    hasWebsite: z.boolean().default(false),
    hasLeadMagnet: z.boolean().default(false),
    hasEmailCapture: z.boolean().default(false),
    hasFunnel: z.boolean().default(false),
    weaknessSignals: z
      .array(
        z.enum([
          'no_website',
          'no_lead_magnet',
          'no_email_capture',
          'no_funnel',
          'dm_only_sales',
          'pricing_hidden',
          'dead_social',
          'no_online_course',
        ]),
      )
      .default([]),
    sourceUrl: z.string().url().nullable(),
    extractorVersion: z.string().min(1),
    correlationId: z.string().min(1),
  }),
  outputSchema: SnapshotOutputSchema,
  execute: async (input, context) => {
    return context.observe.span('crm.save_prospect_snapshot', async () => {
      const rc = context.requestContext.all as {
        tenantId: string
        userId: string
        userRole: string
      }
      const db = getDbClient()
      const snapshotId = snapshotIdFor(rc.tenantId, input.prospectId, input.correlationId)

      const existing = await db.query<{ id: string }>(
        `SELECT id FROM prospect_snapshots
          WHERE id = $1 AND tenant_id = $2 AND prospect_id = $3`,
        [snapshotId, rc.tenantId, input.prospectId],
      )
      const already = existing.rows[0]
      if (already) return { snapshotId: already.id, deduped: true }

      // The SELECT source scopes the insert to a prospect this tenant can see,
      // rather than trusting the FK alone.
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO prospect_snapshots
           (id, tenant_id, prospect_id, what_they_sell, price_min_minor, price_max_minor,
            currency, price_visible, has_website, has_lead_magnet, has_email_capture,
            has_funnel, weakness_signals, source_url, extractor_version)
         SELECT $1, $2, p.id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
           FROM prospects p
          WHERE p.id = $3 AND p.tenant_id = $2
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          snapshotId,
          rc.tenantId,
          input.prospectId,
          input.whatTheySell,
          input.priceMinMinor,
          input.priceMaxMinor,
          input.currency,
          input.priceVisible,
          input.hasWebsite,
          input.hasLeadMagnet,
          input.hasEmailCapture,
          input.hasFunnel,
          input.weaknessSignals,
          input.sourceUrl,
          input.extractorVersion,
        ],
      )
      const created = inserted.rows[0]
      if (created) return { snapshotId: created.id, deduped: false }

      // No insert and no prior row: either the prospect is not visible to this
      // tenant, or a concurrent call won the same correlation id.
      const raced = await db.query<{ id: string }>(
        `SELECT id FROM prospect_snapshots
          WHERE id = $1 AND tenant_id = $2 AND prospect_id = $3`,
        [snapshotId, rc.tenantId, input.prospectId],
      )
      const winner = raced.rows[0]
      if (winner) return { snapshotId: winner.id, deduped: true }

      throw new Error(`prospect ${input.prospectId} is not visible to this tenant`)
    })
  },
})
