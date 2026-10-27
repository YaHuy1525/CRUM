import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import { loadPolicy } from '../../governance/policy'
import { scoreRisk } from '../../governance/risk'
import { getOrCreateDraft, commitAutoWrite } from '../../db/pending-writes'
import { parseEnv } from '../../config/env'
import { createGmailDraft, resolveGmailAccess } from '../../gmail/client'

const AutoWriteOutputSchema = z.object({
  pendingWriteId: z.string().uuid(),
  riskScore: z.number().int().min(0).max(100),
  gate: z.enum(['auto']),
  message: z.string(),
})

export const logFollowupTool = createTool({
  id: 'crm.log_followup',
  title: 'Log Followup',
  description:
    'Record a completed contact attempt (call, email, meeting, visit). Low blast radius, commits immediately.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid(),
    contactId: z.string().uuid().optional(),
    type: z.enum(['call', 'email', 'meeting', 'visit']),
    notes: z.string().optional(),
    scheduledAt: z.string().datetime(),
    correlationId: z.string().min(1),
  }),
  outputSchema: AutoWriteOutputSchema,
  outputValidation: 'warn',
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.log_followup', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.log_followup')

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'auto',
        objectType: 'followup',
        operation: 'create',
        payload: inputData,
        riskScore: assessment.score,
        gate: 'auto',
        requestedBy: rc.userId,
        idempotencyKey: inputData.correlationId,
      })

      const applied = await commitAutoWrite(draft)

      return {
        pendingWriteId: applied.id,
        riskScore: assessment.score,
        gate: 'auto' as const,
        message: `Followup logged (followup ${applied.committedRecordId}).`,
      }
    })
  },
})

export const createTaskTool = createTool({
  id: 'crm.create_task',
  title: 'Create Task',
  description:
    'Create a deadline-only task. No concrete start/end time — if the user gave a time range, use crm.create_schedule instead.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    deadline: z.string().datetime().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    assignedTo: z.string().uuid().optional(),
    correlationId: z.string().min(1),
  }),
  outputSchema: AutoWriteOutputSchema,
  outputValidation: 'warn',
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('crm.create_task', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'crm.create_task')

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'auto',
        objectType: 'task',
        operation: 'create',
        payload: inputData,
        riskScore: assessment.score,
        gate: 'auto',
        requestedBy: rc.userId,
        idempotencyKey: inputData.correlationId,
      })

      const applied = await commitAutoWrite(draft)

      return {
        pendingWriteId: applied.id,
        riskScore: assessment.score,
        gate: 'auto' as const,
        message: `Task created (task ${applied.committedRecordId}).`,
      }
    })
  },
})

export const draftMailTool = createTool({
  id: 'mail.draft',
  title: 'Draft Email',
  description:
    'Compose an email draft. Nothing is sent. Use mail.send to send after approval.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
    draftHash: z.string().min(1),
  }),
  outputSchema: AutoWriteOutputSchema,
  outputValidation: 'warn',
  execute: async (inputData, { requestContext, observe }) => {
    return observe.span('mail.draft', async () => {
      const rc = requestContext.all as { tenantId: string; userId: string; userRole: string }
      const policy = loadPolicy()
      const assessment = scoreRisk(inputData, policy.risk, 'mail.draft')

      const draft = await getOrCreateDraft({
        tenantId: rc.tenantId,
        runId: 'auto',
        objectType: 'email',
        operation: 'create',
        payload: inputData,
        riskScore: assessment.score,
        gate: 'auto',
        requestedBy: rc.userId,
        idempotencyKey: inputData.draftHash,
      })

      const applied = await commitAutoWrite(draft)

      let message = `Email draft saved (draft ${applied.id}).`
      try {
        const env = parseEnv()
        const access = await resolveGmailAccess(env, rc.tenantId, rc.userId)
        if (access.ok) {
          const gmailDraft = await createGmailDraft(access.accessToken, {
            to: inputData.to,
            subject: inputData.subject,
            body: inputData.body,
          })
          message += ` Gmail draft ${gmailDraft.id} created in ${access.email}.`
        } else {
          message += ` (${access.reason}: staged in CRUM only.)`
        }
      } catch {
        message += ' (Gmail mirror unavailable: staged in CRUM only.)'
      }

      return {
        pendingWriteId: draft.id,
        riskScore: assessment.score,
        gate: 'auto' as const,
        message,
      }
    })
  },
})
