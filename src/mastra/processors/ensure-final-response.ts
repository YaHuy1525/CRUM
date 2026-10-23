import type {
  Processor,
  ProcessOutputStepArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'

// §4.3.3 — ensures the agent produces a final user-visible response within
// MAX_STEPS. Phase 1 is a stub; Phase 2 will track step counts and abort
// with a synthesised closing message when the budget runs out.
export class EnsureFinalResponseProcessor implements Processor<'ensure-final-response'> {
  readonly id = 'ensure-final-response' as const
  readonly name = 'Ensure Final Response Processor'

  private readonly maxSteps: number

  constructor(maxSteps: number) {
    this.maxSteps = maxSteps
  }

  async processOutputStep(
    args: ProcessOutputStepArgs,
  ): Promise<MastraDBMessage[]> {
    // Phase 1 stub: pass through. Phase 2 will check step budget.
    return args.messages
  }
}
