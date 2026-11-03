// tests/scripts/analyst-cron-config.test.ts
//
// The analyst cron registers the Meta status adapter in its own process so that
// stageCampaignStatusChange's executability guard can tell the truth here (a
// per-process registry is how the drainer works too, so a cron that registered
// nothing would refuse every recommendation on any host). The config read is the
// part with decisions in it, so it is the part under test. No provider call, no
// database, no credential: these are strings in and a shape out.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { statusAdapterConfigFromEnv } from '../../scripts/analyst-cron'

const TOKEN = 'meta-token-not-a-real-one'
const ACCOUNTS = '["act_111","act_222"]'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The cases that care about what the read says out loud spy on console.warn and
 * read the first argument back as a string; the helper keeps the stringification
 * honest, because a warning line is only evidence if it is compared as text.
 */
function warnedLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => (typeof call[0] === 'string' ? call[0] : ''))
}

describe('statusAdapterConfigFromEnv', () => {
  it('reads a configured lane as a token and the accounts it names', () => {
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: ACCOUNTS })).toEqual({
      accessToken: TOKEN,
      adAccounts: ['act_111', 'act_222'],
    })
  })

  it('answers null when either half is missing, because boot does', () => {
    // src/mastra/index.ts:158 requires both. A token with no accounts would
    // register an adapter that refuses every campaign, which is a worse answer
    // than not registering one.
    expect(statusAdapterConfigFromEnv({ CRUM_META_AD_ACCOUNTS: ACCOUNTS })).toBeNull()
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN })).toBeNull()
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '' })).toBeNull()
  })

  it('answers null for an empty account list without warning', () => {
    // `[]` parses, so it is a configured install that admits no account.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '[]' })).toBeNull()
    expect(warnSpy.mock.calls.length).toBe(0)
  })

  it('warns and answers null for an unparseable list, naming the key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: 'not-json' })).toBeNull()
    expect(warnedLines(warnSpy).some((line) => line.includes('CRUM_META_AD_ACCOUNTS'))).toBe(true)
  })

  it('rejects a JSON array of non-strings rather than passing it to the adapter', () => {
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '[1,2]' })).toBeNull()
    expect(statusAdapterConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '{"a":1}' })).toBeNull()
  })
})
