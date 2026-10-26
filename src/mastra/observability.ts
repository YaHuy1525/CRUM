import type { ObservabilityExporter } from '@mastra/core/observability'
import { SpanType } from '@mastra/core/observability'
import {
  MastraStorageExporter,
  Observability,
  SamplingStrategyType,
} from '@mastra/observability'
import type { ObservabilityRegistryConfig, SamplingStrategy } from '@mastra/observability'
import type { CrumEnv } from '../config/env'

export const OBSERVABILITY_INSTANCE = 'crum'

export const OBSERVABILITY_SERVICE_NAME = 'crum'

export const OBSERVABILITY_CRM_SENSITIVE_FIELDS: readonly string[] = [
  'customerName',
  'phone',
  'email',
  'address',
]

export const OBSERVABILITY_REQUEST_CONTEXT_KEYS: readonly string[] = [
  'resourceId',
  'threadId',
]

export interface CrumObservabilityInstanceConfig {
  serviceName: string
  sampling: SamplingStrategy
  exporters: ObservabilityExporter[]
  excludeSpanTypes: SpanType[]
  requestContextKeys: string[]
}

export function samplingFor(env: CrumEnv): SamplingStrategy {
  const probability = env.MASTRA_TRACE_PROBABILITY
  if (probability >= 1) return { type: SamplingStrategyType.ALWAYS }
  if (probability <= 0) return { type: SamplingStrategyType.NEVER }
  return { type: SamplingStrategyType.RATIO, probability }
}

export function crumObservabilityInstanceConfig(env: CrumEnv): CrumObservabilityInstanceConfig {
  return {
    serviceName: OBSERVABILITY_SERVICE_NAME,
    sampling: samplingFor(env),
    exporters: [new MastraStorageExporter()],
    excludeSpanTypes: [SpanType.MODEL_CHUNK],
    requestContextKeys: [...OBSERVABILITY_REQUEST_CONTEXT_KEYS],
  }
}

export function buildObservabilityConfig(env: CrumEnv): ObservabilityRegistryConfig {
  return {
    configs: {
      [OBSERVABILITY_INSTANCE]: crumObservabilityInstanceConfig(env),
    },
    sensitiveDataFilter: {
      sensitiveFields: [
        'password',
        'token',
        'secret',
        'key',
        'apikey',
        'auth',
        'authorization',
        'bearer',
        'bearertoken',
        'jwt',
        'credential',
        'clientsecret',
        'privatekey',
        'refresh',
        'ssn',
        ...OBSERVABILITY_CRM_SENSITIVE_FIELDS,
      ],
    },
  }
}

export function buildObservability(env: CrumEnv): Observability | undefined {
  if (env.MASTRA_OBSERVABILITY !== true) return undefined
  return new Observability(buildObservabilityConfig(env))
}
