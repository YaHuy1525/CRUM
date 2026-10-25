import type {
  Processor,
  ProcessOutputStepArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'
import { providerToolName } from '../active-tools'

/**
 * All tool ids that mutate data, in registry form (the governance vocabulary
 * used by policy/tools.yaml and the tests).
 */
export const MUTATING_TOOL_IDS = [
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
]

/**
 * The same ids in the form the stream actually reports. `processOutputStep`
 * receives `toolCalls[].toolName` AFTER Agent#formatTools rewrote the registry
 * keys (verified against the shipped bundle: a tool keyed `crm.probe_read` is
 * reported to processors as `crm_probe_read`), so comparing dotted registry ids
 * here matched nothing — and because `mutated` then stayed false forever, the
 * guard aborted with a retry and finally a tripwire on turns where the model had
 * legitimately staged a write. §4.3.3.
 */
export const MUTATING_TOOLS = new Set(MUTATING_TOOL_IDS.map(providerToolName))

const WRITE_VERBS = /\b(created|updated|deleted|added|removed|logged|scheduled|sent)\b/i

/** The same prose the offline `writeClaim` scorer reads — one definition of a
 *  claimed write, shared by the runtime guard and the eval gate. §7.4. */
export function claimsWrite(text: string): boolean {
  return WRITE_VERBS.test(text)
}

/** Shared by the guard and the offline `writeClaim` scorer: is this reported
 *  tool name one of CRUM's mutating tools? */
export function isMutatingToolName(name: unknown): boolean {
  return typeof name === 'string' && MUTATING_TOOLS.has(name)
}

/**
 * Did a mutating tool run anywhere in this turn? `processOutputStep` fires
 * before tool execution, so the step that answers the user carries no tool calls
 * of its own — the write happened in an earlier step. `args.steps` is every
 * completed step of the run, and a tool call that is paused for approval still
 * appears there, which is the right answer for this guard: the user asked for a
 * change, a staging tool ran, and the draft is queued.
 */
function ranMutatingTool(args: ProcessOutputStepArgs): boolean {
  if ((args.toolCalls ?? []).some((tc) => isMutatingToolName(tc.toolName))) return true
  const steps = args.steps as ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: unknown }> }>
  return (steps ?? []).some((step) => (step.toolCalls ?? []).some((tc) => isMutatingToolName(tc.toolName)))
}

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
