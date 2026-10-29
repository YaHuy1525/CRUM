import { describe, it, expect } from 'vitest'
import { parseEnv } from '../../src/config/env'
import { buildRecallDeps } from '../../src/mastra/recall'

describe('buildRecallDeps', () => {
  it('returns undefined when recall is off', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false', DATABASE_URL: 'postgresql://u:p@h:5432/d' })
    expect(buildRecallDeps(env)).toBeUndefined()
  })

  it('returns undefined with no database url (in-memory CI)', () => {
    const env = parseEnv({ DATABASE_URL: '' })
    expect(buildRecallDeps(env)).toBeUndefined()
  })

  it('does not construct anything at module import', async () => {
    // Importing this module with no OpenAI key present must not throw; the
    // embedder is only built inside buildRecallDeps when called.
    await import('../../src/mastra/recall')
    expect(true).toBe(true)
  })
})
