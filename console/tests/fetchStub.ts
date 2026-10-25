import { vi } from 'vitest'

/**
 * A URL-dispatching `fetch` stub for the panels that talk to more than one route.
 *
 * Why stub `fetch` rather than mock `../lib/api`: `lib/api.ts` is where the
 * decisions about failure live (a 401 keeps its `reason`, a dead port becomes
 * `network_unreachable`, a 409 body becomes a `code` the queue branches on), and a
 * mocked module would let a component pass while the layer beneath it had changed
 * the vocabulary. `console/tests/api.test.ts` covers that layer directly, so
 * mocking it here would be duplicating a contract check.
 *
 * Unmatched URLs answer 599 rather than throwing, because a panel that asks for
 * something the test never routed is a real finding — and it should show up as a
 * message on screen, not as an unexplained rejection.
 */

export interface RecordedCall {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

export type Reply = { status: number; body?: unknown }
export type Rule = (call: RecordedCall) => Reply | null

export interface FetchStub {
  calls: RecordedCall[]
  /** Last call whose URL matches, or undefined. */
  last(urlContains: string): RecordedCall | undefined
  count(urlContains: string): number
}

/**
 * Route a call by URL substring, replying with a fixed status and body. `ofMethod`
 * narrows it to one verb, which matters where a collection route and an item route
 * share a prefix - a document list read and a document delete look the same to a
 * substring match.
 */
export function route(
  urlContains: string,
  reply: Reply | ((call: RecordedCall) => Reply),
  ofMethod?: string,
): Rule {
  return (call) =>
    call.url.includes(urlContains) && (!ofMethod || call.method === ofMethod)
      ? typeof reply === 'function'
        ? reply(call)
        : reply
      : null
}

export function stubFetch(rules: Rule[]): FetchStub {
  const calls: RecordedCall[] = []
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).filter(([, v]) => v !== undefined),
      ),
    }
    calls.push(call)

    // Later rules win, so a test can install a default and override one route.
    // Each rule is consulted exactly once: a stateful rule ("the first read sees a
    // draft, the next sees none") double-counts if the lookup and the reply are two
    // separate calls, and the panel then starts out with the post-decision list.
    let matched: Reply | undefined
    for (const rule of rules) {
      const reply = rule(call)
      if (reply) matched = reply
    }
    const reply =
      matched ??
      ({ status: 599, body: { error: 'unrouted', detail: `${call.method} ${url} is not routed by this test` } } satisfies Reply)

    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status })
  })
  vi.stubGlobal('fetch', mock)

  return {
    calls,
    last: (urlContains) => [...calls].reverse().find((c) => c.url.includes(urlContains)),
    count: (urlContains) => calls.filter((c) => c.url.includes(urlContains)).length,
  }
}
