import type {
  Processor,
  ProcessOutputStepArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'
import { providerToolName } from '../active-tools'

export const MUTATING_TOOL_IDS = [
  'crm.log_followup',
  'crm.create_task',
  'mail.draft',
  'crm.create_customer',
  'crm.update_customer',
  'crm.delete_customer',
  'crm.create_contact',
  'crm.create_schedule',
  'crm.transfer_owner',
  'mail.send',
]

export const MUTATING_TOOLS = new Set(MUTATING_TOOL_IDS.map(providerToolName))

const WRITE_VERBS = /\b(created|updated|deleted|added|removed|logged|scheduled|sent)\b/i

export function claimsWrite(text: string): boolean {
  return WRITE_VERBS.test(text)
}

export function isMutatingToolName(name: unknown): boolean {
  return typeof name === 'string' && MUTATING_TOOLS.has(name)
}

function ranMutatingTool(args: ProcessOutputStepArgs): boolean {
  if ((args.toolCalls ?? []).some((tc) => isMutatingToolName(tc.toolName))) return true
  const steps = args.steps as ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: unknown }> }>
  return (steps ?? []).some((step) => (step.toolCalls ?? []).some((tc) => isMutatingToolName(tc.toolName)))
}

export class WriteClaimGuardProcessor implements Processor<'crum-write-claim-guard'> {
  readonly id = 'crum-write-claim-guard' as const
  readonly name = 'Write Claim Guard Processor'

  processOutputStep(
    args: ProcessOutputStepArgs,
  ): MastraDBMessage[] {
    const text = args.text ?? ''
    const claimed = claimsWrite(text)
    const mutated = ranMutatingTool(args)

    if (claimed && !mutated) {
      if ((args.retryCount ?? 0) >= 1) {
        args.abort('write-claim-without-tool', {
          metadata: { text, claimedWrite: true },
        })
      }
      args.abort(
        'You described a data change but called no mutating tool, so nothing was written. ' +
          'Either call the correct tool now, or tell the user plainly that no change was made.',
        { retry: true, metadata: { reason: 'write-claim-without-tool' } },
      )
    }

    return args.messages
  }
}
