// tests/evals/load-env.probe.test.ts
//
// Guards the fix itself, cheaply: if `import './load-env'` ever stops running
// before src/mastra/models.ts is evaluated, the agent silently falls back to
// the `:free` defaults and the golden gate starts dying on OpenRouter's free
// daily cap again. This probe pins that contract without calling any model.
import './load-env'
import { describe, expect, it } from 'vitest'
import { CRUM_LIGHT_MODEL, CRUM_MAIN_MODEL } from '../../src/mastra/models'

const hasKey = Boolean(process.env.OPENROUTER_API_KEY)

describe('golden-gate env loading order', () => {
  it('bakes the model constants at import time', () => {
    // models.ts resolves process.env when this module is first evaluated —
    // which happens after './load-env' thanks to import declaration order.
    expect(CRUM_MAIN_MODEL).toBeTruthy()
    expect(CRUM_LIGHT_MODEL).toBeTruthy()
  })

  it.skipIf(!hasKey)('bakes the .env model lane, not the :free defaults', () => {
    // With .env loaded before models.ts, the constants must equal the env
    // values; if they show ':free' or 'openrouter/free', the order regressed.
    expect(CRUM_MAIN_MODEL).toBe(process.env.CRUM_MODEL_MAIN)
    expect(CRUM_LIGHT_MODEL).toBe(process.env.CRUM_MODEL_LIGHT)
  })
})
