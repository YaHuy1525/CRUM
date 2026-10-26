import { ClassifierProcessor } from '@mastra/core/processors'
import { injectionClassifier } from '../classifiers/injection'

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
