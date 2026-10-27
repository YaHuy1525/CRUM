import { describe, it, expect, beforeAll } from 'vitest'

// Set the API key before any classifier module is imported. The injection
// classifier calls crumDecisionModel() at module load time, which throws on
// the `model!` non-null assertion when no key is present.
beforeAll(() => {
  process.env.TYPESAFE_AI_API_KEY = 'test-key-for-injection-guard-' + 'a'.repeat(32)
})

describe('InjectionGuardProcessor', () => {
  // Dynamic import so the env var is set before module evaluation.
  const getProcessor = () =>
    import('../../src/mastra/processors/injection-guard').then(
      (m) => new m.InjectionGuardProcessor(),
    )

  /**
   * The base Processor config fields these tests read. They are protected on the
   * framework base class, so the probe declares the shape it expects rather than
   * reaching through `any`.
   */
  type ProcessorConfigProbe = {
    errorStrategy: string
    lastMessageOnly: boolean
    maxInputLength: number
  }
  const configOf = (proc: object): ProcessorConfigProbe => proc as ProcessorConfigProbe

  it('has the correct id', async () => {
    const proc = await getProcessor()
    expect(proc.id).toBe('crum-injection-guard')
  })

  it('uses errorStrategy warn (fail-open)', async () => {
    const proc = await getProcessor()
    expect(configOf(proc).errorStrategy).toBe('warn')
  })

  it('uses lastMessageOnly true', async () => {
    const proc = await getProcessor()
    expect(configOf(proc).lastMessageOnly).toBe(true)
  })

  it('uses maxInputLength 8000', async () => {
    const proc = await getProcessor()
    expect(configOf(proc).maxInputLength).toBe(8_000)
  })
})
