import type {
  Processor,
  ProcessOutputStepArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'

const CITATION_PATTERN = /\[[\w-]+:\d+\]/

/**
 * Enforces the citation contract. §6.3.6.
 *
 * If a step invoked knowledge.retrieve and returned non-empty sources but the
 * final text carries no [sourceId:span] marker, abort with a retry so the model
 * restates with citations. First occurrence: abort with retry (correction appended
 * as system reminder). Second occurrence: abort with tripwire (stop looping).
 * Same pattern as WriteClaimGuardProcessor. §4.3.3.
 *
 * The offline twin is the faithfulness scorer gate in §7.5, which catches the
 * same failure without depending on a runtime processor firing.
 */
export class CitationGuardProcessor implements Processor<'crum-citation-guard'> {
  readonly id = 'crum-citation-guard' as const
  readonly name = 'Citation Guard Processor'

  async processOutputStep(
    args: ProcessOutputStepArgs,
  ): Promise<MastraDBMessage[]> {
    const text = args.text ?? ''
    const toolCalls = args.toolCalls ?? []

    // Only enforce when knowledge.retrieve was called.
    const knowledgeCall = toolCalls.find(
      (tc) => tc.toolName === 'knowledge.retrieve',
    )
    if (!knowledgeCall) return args.messages

    // Check if the tool returned any sources (non-empty retrieval).
    const toolResult = knowledgeCall.result as
      | { sources?: unknown[] }
      | undefined
    if (!toolResult?.sources || toolResult.sources.length === 0) {
      return args.messages
    }

    // The model produced text — check for citations.
    if (!CITATION_PATTERN.test(text)) {
      if ((args.retryCount ?? 0) >= 1) {
        // Second offense: tripwire — stop looping.
        args.abort('citation-missing-tripwire', {
          metadata: { text, missingCitations: true },
        })
        return args.messages
      }
      // First offense: abort with retry so the model restates with citations.
      args.abort(
        'CITATION_MISSING: knowledge.retrieve returned sources but the response ' +
          'has no [sourceId:span] citations. Restate with citations.',
        { retry: true, metadata: { reason: 'citation-missing' } },
      )
    }

    return args.messages
  }
}
