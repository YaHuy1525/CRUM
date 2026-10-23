import type { ObservabilityExporter } from '@mastra/core/observability'
import {
  MastraStorageExporter,
  Observability,
  SamplingStrategyType,
} from '@mastra/observability'
import type { ObservabilityRegistryConfig, SamplingStrategy } from '@mastra/observability'
import type { CrumEnv } from '../config/env'

/** Registry key. Also the name Mastra prints in span metadata. */
export const OBSERVABILITY_INSTANCE = 'crum'

/** Service name on every emitted span. One service, one product. */
export const OBSERVABILITY_SERVICE_NAME = 'crum'

export interface CrumObservabilityInstanceConfig {
  serviceName: string
  sampling: SamplingStrategy
  exporters: ObservabilityExporter[]
}

/**
 * Turns MASTRA_TRACE_PROBABILITY into a SamplingStrategy.
 *
 * The endpoints use the dedicated enum members rather than RATIO with 0 or 1,
 * because ALWAYS and NEVER let the registry skip span construction entirely
 * while RATIO still builds the span and discards it. At probability 0 that
 * difference is the whole cost of tracing.
 *
 * The default is 1, so a missing variable traces everything. For a governance
 * product the expensive default is the correct one: an untraced approval is
 * unauditable, and a surprising bill is a config change away.
 */
export function samplingFor(env: CrumEnv): SamplingStrategy {
  const probability = env.MASTRA_TRACE_PROBABILITY
  if (probability >= 1) return { type: SamplingStrategyType.ALWAYS }
  if (probability <= 0) return { type: SamplingStrategyType.NEVER }
  return { type: SamplingStrategyType.RATIO, probability }
}

/**
 * The instance config CRUM registers.
 *
 * `spanOutputProcessors` is deliberately absent. The registry-level
 * `sensitiveDataFilter` is skipped for a config that already carries a processor
 * of its own, so adding one here would switch off the automatic filter that
 * redacts customer names, phone numbers and email addresses from span
 * attributes. If CRUM ever needs a custom processor it must compose the
 * sensitive-data filter explicitly rather than replace it.
 */
export function crumObservabilityInstanceConfig(env: CrumEnv): CrumObservabilityInstanceConfig {
  return {
    serviceName: OBSERVABILITY_SERVICE_NAME,
    sampling: samplingFor(env),
    // No arguments. MastraStorageExporterConfig extends BaseExporterConfig and
    // neither declares `storage`; the exporter receives storage in
    // init(InitExporterOptions), which Observability.setMastraContext({ mastra })
    // calls with this Mastra instance's own store. Passing storage here would be
    // a type error, and inventing a second store would double the pool budget
    // Task 10 just constrained.
    exporters: [new MastraStorageExporter()],
  }
}

export function buildObservabilityConfig(env: CrumEnv): ObservabilityRegistryConfig {
  return {
    configs: {
      [OBSERVABILITY_INSTANCE]: crumObservabilityInstanceConfig(env),
    },
    // Stated explicitly even though true is the documented default. This is a
    // privacy control over CRM data, and a control that depends on a library
    // default is one minor-version bump away from being off.
    sensitiveDataFilter: true,
  }
}

/**
 * Returns undefined when tracing is disabled, so `new Mastra({ observability })`
 * receives no entrypoint and emits nothing. §13.3 keeps this off by default:
 * PostgresStoreVNext is documented as low-volume only, and its own JSDoc puts
 * the ceiling near 1,500 calls/sec on a single primary.
 */
export function buildObservability(env: CrumEnv): Observability | undefined {
  if (env.MASTRA_OBSERVABILITY !== true) return undefined
  return new Observability(buildObservabilityConfig(env))
}
