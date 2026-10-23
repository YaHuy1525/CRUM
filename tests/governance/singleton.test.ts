import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL = process.env['POLICY_DIR']

function restore(): void {
  if (ORIGINAL === undefined) delete process.env['POLICY_DIR']
  else process.env['POLICY_DIR'] = ORIGINAL
}

describe('the governance singleton reads the parsed environment', () => {
  afterEach(restore)

  it('treats POLICY_DIR="" as unset instead of resolving policy files against cwd', async () => {
    vi.resetModules()
    process.env['POLICY_DIR'] = ''
    const { policy } = await import('../../src/governance')
    expect(policy.toolByName.has('crm.get_customer')).toBe(true)
  })
})
