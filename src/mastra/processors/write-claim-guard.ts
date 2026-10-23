import type {
  Processor,
  ProcessOutputStepArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'

/**
 * All tool ids that mutate data. Keyed by tool id (not name), because
 * toolName in stream responses IS the object key and CRUM registers
 * tools as { [tool.id]: tool }. §4.3.3.
 */
export const MUTATING_TOOLS = new Set([
  // auto class
  'crm.log_followup',
  'crm.create_task',
  'mail.draft',
  // approval class
  'crm.create_customer',
  'crm.update_customer',
  'crm.delete_customer',
  'crm.create_contact',
  'crm.create_schedule',
  'crm.transfer_owner',
  'mail.send',
])

const WRITE_VERBS = /\b(created|updated|deleted|added|removed|logged|scheduled|sent)\b/i

/**
 * Catches the model claiming a write happened without calling a mutating tool.
 * First occurrence: abort with retry (the correction is appended as a system reminder).
 * Second occurrence: abort with tripwire (stop looping).
 * §4.3.3.
 */
export class WriteClaimGuardProcessor implements Processor<'crum-write-claim-guard'> {
  readonly id = 'crum-write-claim-guard' as const
  readonly name = 'Write Claim Guard Processor'

  async processOutputStep(
    args: ProcessOutputStepArgs,
  ): Promise<MastraDBMessage[]> {
    const text = args.text ?? ''
    const claimsWrite = WRITE_VERBS.test(text)
    const mutated = (args.toolCalls ?? []).some((tc) => MUTATING_TOOLS.has(tc.toolName))

    if (claimsWrite && !mutated) {
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
