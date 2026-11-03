// tests/marketing/meta-ads-config.test.ts
//
// The Meta Ads lane's config read and its registration, in one module, because
// more than one process has to answer the same question the same way. The adapter
// map is per process (src/marketing/outbox.ts:74, and `isExecutable` at :81 reads
// exactly that map), so a lane that parses its accounts in one process and gives up
// in the next produces refusals nobody can reproduce from the deployment. This file
// moved here from tests/scripts/analyst-cron-config.test.ts when the read stopped
// belonging to one script.
//
// Boot is deliberately not here. src/mastra/index.ts:158 keeps its own inline copy
// because tests/mastra/marketing-boot.test.ts pins the warning it emits and the
// once-per-change log around it, and the two do different jobs.
//
// No provider call, no database, no credential: strings in, a shape out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { isExecutable } from '../../src/marketing/outbox'
import { metaAdsConfigFromEnv, registerMetaLane } from '../../src/marketing/meta-ads-config'

const TOKEN = 'meta-token-not-a-real-one'
const ACCOUNTS = '["act_111","act_222"]'
// The label only prefixes the warning, so one helper can serve the cron, the
// publisher, and a test that wants its own name in the line it asserts on.
const LABEL = 'meta-config-test'

let warnSpy: MockInstance

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

/** The first argument of every console.warn the module emitted, as strings. */
function warnedLines(spy: MockInstance): string[] {
  return spy.mock.calls.map((call) => (typeof call[0] === 'string' ? call[0] : ''))
}

describe('metaAdsConfigFromEnv', () => {
  it('reads a configured lane as a token and the accounts it names', () => {
    expect(metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: ACCOUNTS }, LABEL)).toEqual({
      accessToken: TOKEN,
      adAccounts: ['act_111', 'act_222'],
    })
  })

  it('answers null when either half is missing, because both halves are needed', () => {
    // A token with no accounts would register an adapter that refuses every
    // campaign, which is a worse answer than not registering one at all.
    expect(metaAdsConfigFromEnv({ CRUM_META_AD_ACCOUNTS: ACCOUNTS }, LABEL)).toBeNull()
    expect(metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN }, LABEL)).toBeNull()
    expect(metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '' }, LABEL)).toBeNull()
  })

  it('says nothing when the accounts half is merely absent', () => {
    // This is the assertion that keeps the both-or-nothing guard honest rather than
    // accidentally satisfied. Delete `!raw` from it and the empty string below
    // reaches JSON.parse, which throws, and the module warns: the value is still
    // null, so every other case here stays green. Silence is the only observable
    // difference between "not configured" and "configured badly".
    expect(metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN }, LABEL)).toBeNull()
    expect(warnedLines(warnSpy)).toEqual([])
    expect(metaAdsConfigFromEnv({ CRUM_META_AD_ACCOUNTS: ACCOUNTS }, LABEL)).toBeNull()
    expect(warnedLines(warnSpy)).toEqual([])
  })

  it('answers null for an empty account list without warning', () => {
    // `[]` parses, so it is a configured install that admits no account.
    expect(metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '[]' }, LABEL)).toBeNull()
    expect(warnedLines(warnSpy)).toEqual([])
  })

  it('warns and answers null for an unparseable list, naming the key and the caller', () => {
    expect(
      metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: 'not-json' }, LABEL),
    ).toBeNull()
    const lines = warnedLines(warnSpy)
    expect(lines.some((line) => line.includes('CRUM_META_AD_ACCOUNTS'))).toBe(true)
    // The label is the whole reason the helper takes one: three processes share this
    // line, and an operator reading a log has to know which process wrote it.
    expect(lines.some((line) => line.includes(LABEL))).toBe(true)
  })

  it('rejects a JSON array of non-strings rather than passing it to the adapter', () => {
    expect(
      metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '[1,2]' }, LABEL),
    ).toBeNull()
    expect(
      metaAdsConfigFromEnv({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: '{"a":1}' }, LABEL),
    ).toBeNull()
  })
})

describe('registerMetaLane', () => {
  it('registers nothing when the lane is unconfigured, and says so by returning no handles', () => {
    // The state this file starts from, stated rather than assumed: Vitest gives each
    // test file its own module registry, so an empty map here is the real condition
    // a cron or publisher process is in before it reads its env.
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)
    expect(registerMetaLane({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN }, LABEL)).toEqual([])
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)
  })

  it('registers both Meta actions together, and hands back the way to undo exactly that', () => {
    // Both, not one. The analyst cron only stages status changes, but boot
    // (src/mastra/index.ts:174-175) maps the pair, and a publisher that can run one
    // Meta action and not the other would leave a create_campaign row queued behind
    // a status row it had already drained. The unregister closures come back because
    // registerActionAdapter exists so a caller can put the map back as it found it
    // (src/marketing/outbox.ts:74), and a test that leaks is a test that lies about
    // the next case.
    const unregister = registerMetaLane(
      { CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: ACCOUNTS },
      LABEL,
    )
    expect(unregister).toHaveLength(2)
    expect(isExecutable('create_campaign')).toBe(true)
    expect(isExecutable('set_campaign_status')).toBe(true)
    for (const off of unregister) off()
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)
  })

  it('warns once, not twice, when the accounts list is unreadable', () => {
    // The parse failure is reported by the read, and the caller reports the
    // consequence. A helper that warned in both places would make an operator look
    // for two problems.
    expect(registerMetaLane({ CRUM_META_ADS_ACCESS_TOKEN: TOKEN, CRUM_META_AD_ACCOUNTS: 'nope' }, LABEL)).toEqual([])
    expect(warnedLines(warnSpy).filter((line) => line.includes('CRUM_META_AD_ACCOUNTS'))).toHaveLength(1)
  })
})
