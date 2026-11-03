import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Pool } from 'pg'
import { setAuditContext } from '../../src/db/audit-context.js'
import { getDbClient } from '../../src/db/client.js'

vi.mock('../../src/db/client.js', () => ({
  getDbClient: vi.fn(),
}))

describe('setAuditContext', () => {
  const mockQuery = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getDbClient).mockReturnValue({ query: mockQuery } as unknown as Pool)
  })

  it('sets both session variables when userId is provided', async () => {
    await setAuditContext({
      userId: '00000000-0000-4000-8000-000000000002',
      changeSource: 'manual_correction',
    })

    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(mockQuery).toHaveBeenCalledWith(
      'SET LOCAL app.current_user_id = $1',
      ['00000000-0000-4000-8000-000000000002'],
    )
    expect(mockQuery).toHaveBeenCalledWith(
      'SET LOCAL app.change_source = $1',
      ['manual_correction'],
    )
  })

  it('sets only change_source when userId is null', async () => {
    await setAuditContext({
      userId: null,
      changeSource: 'extraction',
    })

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery).toHaveBeenCalledWith(
      'SET LOCAL app.change_source = $1',
      ['extraction'],
    )
  })

  it('accepts all valid changeSource values', async () => {
    const sources = ['extraction', 'manual_correction', 're_parse', 'import', 'system'] as const

    for (const source of sources) {
      await setAuditContext({ userId: null, changeSource: source })
      expect(mockQuery).toHaveBeenCalledWith(
        'SET LOCAL app.change_source = $1',
        [source],
      )
    }
  })
})
