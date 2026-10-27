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

export function buildScorers() {
  const judge = buildJudge()

  const judgeModel = judge?.model

  const judgeModelConfig = judgeModel as unknown as MastraModelConfig

  return {
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

    refusalCorrectness: createRefusalScorer(),
    tenantIsolation: createTenantIsolationScorer(),
    writeClaim: createWriteClaimScorer(),

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
      return 1 - results.generateScoreStepResult
    }),
  }
}

export type CrumScorers = ReturnType<typeof buildScorers>
