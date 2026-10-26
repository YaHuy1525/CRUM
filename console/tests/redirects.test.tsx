import { describe, expect, it, vi } from 'vitest'

/**
 * The four redirects in §"Route map": `/approvals` to `/governance`, `/today` to
 * `/`, `/new` to `/records/new`, `/customer/[id]` to `/records/customers/[id]`.
 *
 * Each page is a five line forwarder, and that is exactly why it needs a test: a
 * redirect that quietly forwards to the wrong place keeps old links *working* —
 * they just land on a page that has nothing to do with what was bookmarked.
 *
 * `next/navigation` is mocked because the real `redirect()` throws a control-flow
 * signal only the App Router can catch; here the argument is the whole subject.
 */
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

/** Pages are plain functions; invoking them is all a redirect page needs. */
function render(Page: () => unknown, props?: unknown) {
  return (Page as (props?: unknown) => unknown)(props)
}
