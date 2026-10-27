import { describe, expect, it, vi } from 'vitest'

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect }))

import ApprovalsRedirect from '@/app/approvals/page'
import CustomerRedirect from '@/app/customer/[id]/page'
import NewRedirect from '@/app/new/page'
import TodayRedirect from '@/app/today/page'

describe('retired routes', () => {
  it.each([
    ['/approvals', '/governance', ApprovalsRedirect, {}],
    ['/today', '/', TodayRedirect, {}],
    ['/new', '/records/new', NewRedirect, {}],
  ])('%s forwards to %s', (_from, to, Page, props) => {
    redirect.mockReset()
    render(Page, props)
    expect(redirect).toHaveBeenCalledWith(to)
  })

  it('/customer/[id] forwards to the records detail route, carrying the id', async () => {
    redirect.mockReset()
    await CustomerRedirect({ params: Promise.resolve({ id: 'c1c1c1c1-1111-4111-8111-111111111111' }) })
    expect(redirect).toHaveBeenCalledWith(
      '/records/customers/c1c1c1c1-1111-4111-8111-111111111111',
    )
  })
})

function render(Page: () => unknown, props?: unknown) {
  return (Page as (props?: unknown) => unknown)(props)
}
