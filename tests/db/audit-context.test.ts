import { describe, it, expect, vi } from 'vitest'
import { setAuditContext } from '../../src/db/audit-context.js'

function client() {
  const query = vi.fn().mockResolvedValue({ rows: [{}] })
  return { query, calls: query.mock.calls }
}

describe('setAuditContext', () => {
  it('sets both settings transaction-locally on the caller connection', async () => {
    const c = client()
    await setAuditContext(c as never, { userId: 'u-1', changeSource: 'manual_correction' })
    expect(c.calls).toEqual([
      ['SELECT set_config($1, $2, true)', ['app.current_user_id', 'u-1']],
      ['SELECT set_config($1, $2, true)', ['app.change_source', 'manual_correction']],
    ])
  })

  it('omits the user setting when the actor is unknown but always sets the source', async () => {
    const c = client()
    await setAuditContext(c as never, { userId: null, changeSource: 'extraction' })
    expect(c.calls).toEqual([
      ['SELECT set_config($1, $2, true)', ['app.change_source', 'extraction']],
    ])
  })

  it('accepts only the spellings the shipped CHECK constraint allows', async () => {
    const c = client()
    const sources = ['extraction', 'manual_correction', 're-parse', 'import', 'system'] as const
    for (const source of sources) {
      await setAuditContext(c as never, { userId: null, changeSource: source })
    }
    expect(c.calls.map((call) => (call[1] as string[])[1])).toEqual(sources)
  })
})
