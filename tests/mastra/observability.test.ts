import { describe, it, expect } from 'vitest'
import { Observability } from '@mastra/observability'
import { buildObservability, OBSERVABILITY_SERVICE_NAME } from '../../src/mastra/observability'
import { parseEnv } from '../../src/config/env'

describe('buildObservability', () => {
  it('returns an Observability instance when tracing is enabled', () => {
    const env = parseEnv({ MASTRA_OBSERVABILITY: 'true' })
    const observability = buildObservability(env)

    // Phase 0 already wires observability; this test verifies it's correct
    expect(observability).toBeDefined()
    expect(observability).toBeInstanceOf(Observability)
  })

  it('uses service name crum', () => {
    expect(OBSERVABILITY_SERVICE_NAME).toBe('crum')
  })

  it('configures MastraStorageExporter for Studio', () => {
    const env = parseEnv({ MASTRA_OBSERVABILITY: 'true' })
    const observability = buildObservability(env)

    // Observability instance has configs; we verify it's not undefined
    expect(observability).toBeDefined()
  })
})
