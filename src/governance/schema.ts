import { z } from 'zod'

export const TOOL_CLASSES = ['read-only', 'auto', 'approval', 'refuse'] as const
export type ToolClass = (typeof TOOL_CLASSES)[number]

export const GATES = ['auto', 'approval', 'refuse'] as const
export type Gate = (typeof GATES)[number]

export const IDEMPOTENCY_KEYS = ['correlationId', 'draftHash', 'actionHash'] as const
export type IdempotencyKey = (typeof IDEMPOTENCY_KEYS)[number]

const ScoreBound = z.number().int().min(0).max(100)

export const ToolPolicySchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*(-[a-z0-9_]+)*)+$/, {
      message: 'tool names are dot-separated lowercase identifiers, e.g. crm.list_customers',
    }),
    description: z.string().min(1),
    scope: z.string().min(1),
    class: z.enum(TOOL_CLASSES),
    idempotent: z.boolean().optional(),
    idempotency_key: z.enum(IDEMPOTENCY_KEYS).optional(),
  })
  .superRefine((tool, ctx) => {
    if (tool.class !== 'read-only' && tool.class !== 'refuse' && !tool.idempotent) {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotent'],
        message: `mutating tool ${tool.name} must declare idempotent: true`,
      })
    }
    if (tool.idempotent && !tool.idempotency_key) {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotency_key'],
        message: `tool ${tool.name} declares idempotent: true but no idempotency_key`,
      })
    }
  })

export type ToolPolicyEntry = z.infer<typeof ToolPolicySchema>

export const ConnectorPolicySchema = z.object({
  provider: z.string().min(1),
  description: z.string().min(1),
  scope: z.string().min(1),
  class: z.enum(TOOL_CLASSES),
})

export type ConnectorPolicyEntry = z.infer<typeof ConnectorPolicySchema>

export const ToolsFileSchema = z
  .object({
    version: z.literal(1),
    tools: z.array(ToolPolicySchema).min(1),
    connectors: z.array(ConnectorPolicySchema).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>()
    file.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `duplicate tool name in policy/tools.yaml: ${tool.name}`,
        })
        return
      }
      seen.add(tool.name)
    })
  })

export type ToolsFile = z.infer<typeof ToolsFileSchema>

export const RiskFileSchema = z
  .object({
    version: z.literal(1),
    preflight: z.object({
      irreversible_terms: z.array(z.string().min(1)).default([]),
      high_blast_terms: z.array(z.string().min(1)).default([]),
      scores: z.object({
        irreversible_high_blast: ScoreBound,
        single_risk: ScoreBound,
        benign: ScoreBound,
      }),
      gates: z.object({
        refuse_at: ScoreBound,
        approval_at: ScoreBound,
      }),
      domains: z
        .record(
          z.string(),
          z.object({ require_approval_terms: z.array(z.string().min(1)).default([]) }),
        )
        .default({}),
    }),
    sensitive: z.object({
      clause: z.string().min(1),
      markers: z.array(z.string().min(1)).min(1),
      required_gate: z.enum(GATES),
    }),
  })
  .superRefine((file, ctx) => {
    const { refuse_at, approval_at } = file.preflight.gates
    if (refuse_at <= approval_at) {
      ctx.addIssue({
        code: 'custom',
        path: ['preflight', 'gates', 'refuse_at'],
        message: `refuse_at (${refuse_at}) must be strictly greater than approval_at (${approval_at})`,
      })
    }
    const { irreversible_high_blast, single_risk, benign } = file.preflight.scores
    if (!(irreversible_high_blast > single_risk && single_risk > benign)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preflight', 'scores'],
        message:
          'scores must be strictly ordered: irreversible_high_blast > single_risk > benign',
      })
    }
  })

export type RiskFile = z.infer<typeof RiskFileSchema>
