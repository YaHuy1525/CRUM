import { ClassifierProcessor } from '@mastra/core/processors'
import { injectionClassifier } from '../classifiers/injection'

/**
 * §6.5.6 — Injection guard as a ClassifierProcessor.
 *
 * `errorStrategy: 'warn'` is fail-open: if the classifier errors, the message
 * passes through with a warning logged. This looks like the wrong side of the
 * argument until the structural controls are counted: §4.3.3's write-claim
 * guard and the §11.3 approval queue mean no injection that survives the
 * classifier can commit a write without a human. Fail-closed here would turn
 * an outage of a package marked experimental into an outage of the product.
 *
 * `lastMessageOnly: true` — only the latest user message is classified, not
 * the full conversation history.
 *
 * `maxInputLength: 8_000` — truncates before classification to bound cost.
 *
 * Abort reason is CRUM's own string, never provider-generated text (§6.5.6).
 */
export class InjectionGuardProcessor extends ClassifierProcessor<{
  injection: { type: 'boolean' }
}> {
  constructor() {
    super({
      id: 'crum-injection-guard',
      classifier: injectionClassifier,
      errorStrategy: 'warn',
      lastMessageOnly: true,
      maxInputLength: 8_000,
      onResult: (answers, { abort }) => {
        if ((answers.injection.probability ?? 1) > 0.85) {
          abort('Rejected by CRUM content policy')
        }
      },
    })
  }
}
