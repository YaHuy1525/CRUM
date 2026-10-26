import type {
  Processor,
  ProcessOutputStepArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'

export class EnsureFinalResponseProcessor implements Processor<'ensure-final-response'> {
  readonly id = 'ensure-final-response' as const
  readonly name = 'Ensure Final Response Processor'

  private readonly maxSteps: number

  constructor(maxSteps: number) {
    this.maxSteps = maxSteps
  }

  processOutputStep(
    args: ProcessOutputStepArgs,
  ): MastraDBMessage[] {
    return args.messages
  }
}
