import { describe, it, expect } from 'vitest'
import { CRUM_WORKING_MEMORY_TEMPLATE as T } from '@/mastra/working-memory'

describe('working memory template v2', () => {
  it('has the five CRM blocks and no leftover placeholder values', () => {
    expect(T).toContain('## Current Focus')
    expect(T).toContain('## Active Filters')
    expect(T).toContain('## Relationship Tone')
    expect(T).toContain('## Open Commitments')
    expect(T).toContain('## Output Preferences')
    expect(T).not.toContain('No facts noted yet')
    expect(T).not.toContain('ISO 8601')
  })
})
