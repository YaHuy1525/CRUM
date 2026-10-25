import type {
  Processor,
  ProcessOutputStepArgs,
  ProcessToolResultArgs,
} from '@mastra/core/processors'
import type { MastraDBMessage } from '@mastra/core/agent'
import { providerToolName } from '../active-tools'

const CITATION_PATTERN = /\[[\w-]+:\d+\]/
/**
 * The registry id, and the name the hook actually reports. `processToolResult`
 * receives `toolName` after Agent#formatTools rewrote the dotted registry key
 * (verified against the shipped 1.79.0 bundle), so the dotted id alone could
 * never match and this guard would never fire. §6.3.6.
 */
const RETRIEVAL_TOOL_ID = 'knowledge.retrieve'
const RETRIEVAL_TOOL_NAME = providerToolName(RETRIEVAL_TOOL_ID)
const SOURCES_STATE_KEY = 'crumRetrievalHasSources'

function returnedSources(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('sources' in result)) {
    return false
  }
  return Array.isArray(result.sources) && result.sources.length > 0
}

/**
 * Enforces the citation contract. §6.3.6.
 *
 * If a step invoked knowledge.retrieve and returned non-empty sources but the
 * final text carries no [sourceId:span] marker, abort with a retry so the model
 * restates with citations. First occurrence: abort with retry (correction appended
 * as system reminder). Second occurrence: abort with tripwire (stop looping).
 * Same pattern as WriteClaimGuardProcessor. §4.3.3.
 *
 * processOutputStep runs before tool execution, so it cannot see the retrieval
 * output; processToolResult records it in the per-request state both hooks share.
 *
 * The offline twin is the faithfulness scorer gate in §7.5, which catches the
 * same failure without depending on a runtime processor firing.
 */
export class CitationGuardProcessor implements Processor<'crum-citation-guard'> {
  readonly id = 'crum-citation-guard' as const
  readonly name = 'Citation Guard Processor'

  // Both hooks are synchronous: the Processor contract accepts a plain return
  // (`ProcessorMessageResult` is `Promise<…> | …`), and nothing here awaits, so
  // promising a Promise would be a claim this body does not keep.
  processToolResult(args: ProcessToolResultArgs): void {
    // Accept either spelling: the registry id is the vocabulary CRUM authors,
    // the rewritten key is what the framework actually reports.
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

    // A step that still calls tools has not produced the final answer yet.
    if ((args.toolCalls?.length ?? 0) > 0) return args.messages

    const text = args.text ?? ''
    if (text === '') return args.messages

    if (CITATION_PATTERN.test(text)) {
      delete args.state[SOURCES_STATE_KEY]
      return args.messages
    }

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

    return args.messages
  }
}
