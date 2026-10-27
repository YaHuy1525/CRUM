import type {
  Processor,
  ProcessOutputStepArgs,
  ProcessToolResultArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'
import { providerToolName } from '../active-tools'

const CITATION_PATTERN = /\[[\w-]+:\d+\]/
const RETRIEVAL_TOOL_ID = 'knowledge.retrieve'
const RETRIEVAL_TOOL_NAME = providerToolName(RETRIEVAL_TOOL_ID)
const SOURCES_STATE_KEY = 'crumRetrievalHasSources'

function returnedSources(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('sources' in result)) {
    return false
  }
  return Array.isArray(result.sources) && result.sources.length > 0
}

export class CitationGuardProcessor implements Processor<'crum-citation-guard'> {
  readonly id = 'crum-citation-guard' as const
  readonly name = 'Citation Guard Processor'

  processToolResult(args: ProcessToolResultArgs): void {
    if (
      (args.toolName === RETRIEVAL_TOOL_ID || args.toolName === RETRIEVAL_TOOL_NAME) &&
      returnedSources(args.result)
    ) {
      args.state[SOURCES_STATE_KEY] = true
    }
  }

  processOutputStep(
    args: ProcessOutputStepArgs,
  ): MastraDBMessage[] {
    if (args.state[SOURCES_STATE_KEY] !== true) return args.messages

    if ((args.toolCalls?.length ?? 0) > 0) return args.messages

    const text = args.text ?? ''
    if (text === '') return args.messages

    if (CITATION_PATTERN.test(text)) {
      delete args.state[SOURCES_STATE_KEY]
      return args.messages
    }

    if ((args.retryCount ?? 0) >= 1) {
      args.abort('citation-missing-tripwire', {
        metadata: { text, missingCitations: true },
      })
      return args.messages
    }
    args.abort(
      'CITATION_MISSING: knowledge.retrieve returned sources but the response ' +
        'has no [sourceId:span] citations. Restate with citations.',
      { retry: true, metadata: { reason: 'citation-missing' } },
    )

    return args.messages
  }
}
