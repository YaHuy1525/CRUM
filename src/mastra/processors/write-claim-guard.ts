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

/**
 * The verbs that would mean a write happened.
 */
const WRITE_VERB = String.raw`(?:created|updated|deleted|added|removed|logged|scheduled|sent|drafted|stored|recorded)`

/**
 * A claim that THIS assistant performed one of those verbs.
 *
 * Two shapes are matched, and only these two:
 *   1. the agent speaking about itself: "I created ...", "I've scheduled ...",
 *      "we have just logged a call ...";
 *   2. an auxiliary of completion about the record: "the task has been deleted",
 *      "the draft had been sent".
 *
 * A plain past passive is deliberately NOT matched ("those followups were
 * scheduled last week", "no tasks were created this week") because it is
 * indistinguishable from reporting stored records, and reporting records is what
 * a read-only turn does. The eval write-claim scorer in
 * `src/evals/custom-scorers.ts` shares this narrow definition, so an impersonal
 * "Customer created." is not counted as a claim there either. Measured on the
 * golden dataset: matching the bare verbs as well turned 1 flagged item into 8,
 * most of them read-only answers quoting a `status` or `tags` value, which is the
 * same false-positive class that killed the runtime guard.
 *
 * The guard used to be a bare `/\b(created|updated|...|scheduled|sent)\b/` over
 * the whole answer, and that is why read-only turns died. `scheduled` is a
 * `followups.status` value, `added` and `removed` appear in `customers.tags`, and
 * the assistant's job on "what should I work on today?" is to print exactly those
 * words in a table. The bare verb matched, no mutating tool had run, so the
 * processor aborted the step with `retry: true`, the retry tripped again, and the
 * stream closed with no finish event: the console showed an error over an empty
 * transcript and nothing was persisted. A state word in a table cell is not a
 * claim of authorship, so it must not be treated as one.
 */
const AGENT_WRITE_CLAIM = new RegExp(
  String.raw`\b(?:i|we)(?:\s*(?:'ve|'d)|\s+(?:have|had|just|now|previously|already|also|successfully))*\s+${WRITE_VERB}\b`,
  'i',
)
const COMPLETED_WRITE_CLAIM = new RegExp(
  String.raw`\b(?:has|have|had|was|were)\s+been\s+${WRITE_VERB}\b`,
  'i',
)

export function claimsWrite(text: string): boolean {
  return AGENT_WRITE_CLAIM.test(text) || COMPLETED_WRITE_CLAIM.test(text)
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
