import {
  createFaithfulnessScorer,
  createAnswerRelevancyScorer,
  createHallucinationScorer,
  createContextPrecisionScorer,
  createToxicityScorer,
  createToolCallAccuracyScorerLLM,
  createTrajectoryAccuracyScorerCode,
} from '@mastra/evals/scorers/prebuilt'
import { createClassifierScorer } from '@mastra/core/evals'
import type { MastraModelConfig } from '@mastra/core/llm'
import { buildJudge } from './judge'
import {
  createRefusalScorer,
  createTenantIsolationScorer,
  createWriteClaimScorer,
} from './custom-scorers'
import { intentClassifier } from '../mastra/classifiers/intent'
import { injectionClassifier } from '../mastra/classifiers/injection'

/**
 * Build all 12 scorers for the CRUM eval gate.
 *
 * 7 native prebuilt scorers (faithfulness, answerRelevancy, hallucination,
 * contextPrecision, toxicity, toolCallAccuracy, trajectoryAccuracy)
 *
 * 3 custom scorers (refusalCorrectness, tenantIsolation, writeClaim)
 *
 * 2 classifier scorers (intentClassification, injectionDetection)
 *
 * Native scorers receive the judge model when available. When no judge key
 * is set, native scorers that require a judge are built without one — they
 * will return notScorable() at runtime, and the CI gate echoes which scorers
 * skipped (§7.6, §14.2).
 */
export function buildScorers() {
  const judge = buildJudge()

  // The model for LLM-as-judge native scorers. Undefined when no API key is
  // configured; those scorers will return notScorable() at runtime.
  const judgeModel = judge?.model

  // The factory signatures declare `model` as a required MastraModelConfig even
  // though an unconfigured judge genuinely is undefined here, and the runtime
  // behaviour the gate relies on (notScorable, then reported as skipped) depends
  // on that. The conversion is stated once, in the words that describe it, rather
  // than six times as `as any`.
  const judgeModelConfig = judgeModel as unknown as MastraModelConfig

  return {
    // 7 native
    faithfulness: createFaithfulnessScorer({ model: judgeModelConfig }),
    answerRelevancy: createAnswerRelevancyScorer({ model: judgeModelConfig }),
    hallucination: createHallucinationScorer({ model: judgeModelConfig }),
    contextPrecision: createContextPrecisionScorer({
      model: judgeModelConfig,
      options: {
        contextExtractor: () => ['__crum-context-placeholder__'],
      },
    }),
    toxicity: createToxicityScorer({ model: judgeModelConfig }),
    toolCallAccuracy: createToolCallAccuracyScorerLLM({
      model: judgeModelConfig,
      availableTools: [],
    }),
    trajectoryAccuracy: createTrajectoryAccuracyScorerCode({}),

    // 3 custom
    refusalCorrectness: createRefusalScorer(),
    tenantIsolation: createTenantIsolationScorer(),
    writeClaim: createWriteClaimScorer(),

    // 2 classifier scorers
    intentClassification: createClassifierScorer({
      id: 'intentClassification',
      name: 'Intent Classification',
      description: 'Evaluates intent classification accuracy',
      classifier: intentClassifier,
      question: 'intent',
      state: ({ run }) =>
        typeof run.input === 'string' ? run.input : JSON.stringify(run.input),
      scores: {
        schedule: 1,
        task: 0.7,
        other: 0,
      },
    }),
    injectionDetection: createClassifierScorer({
      id: 'injectionDetection',
      name: 'Injection Detection',
      description: 'Evaluates prompt injection detection',
      classifier: injectionClassifier,
      question: 'injection',
      state: ({ run }) =>
        typeof run.input === 'string' ? run.input : JSON.stringify(run.input),
    }).generateScore(({ results }) => {
      // Invert the default boolean scoring: the classifier maps true→1 (injection
      // detected) and false→0 (safe). For eval quality, injection detected is bad
      // (score 0) and safe content is good (score 1).
      return 1 - results.generateScoreStepResult
    }),
  }
}

export type CrumScorers = ReturnType<typeof buildScorers>
