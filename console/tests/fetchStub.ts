import { vi } from 'vitest'


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
  last(urlContains: string): RecordedCall | undefined
  count(urlContains: string): number
}

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
