import { describe, expect, it, vi } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import { createCrumMastra } from '../../src/mastra'
import { isExecutable } from '../../src/marketing/outbox'

function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'marketing-boot-test' })
}

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

const META_ENV: Record<string, string> = {
  CRUM_META_ADS_ACCESS_TOKEN: 'test-token-at-least-one-char',
  CRUM_META_AD_ACCOUNTS: '["act_111","act_222"]',
}

describe('slice 3 Meta Ads adapter registration', () => {
  // These tests must run in order because the adapters map is module-level and
  // persists. The "not registered" cases must run before the "registered" case.
  // This mirrors the pattern in boot.test.ts for page adapters.

  it('registers neither adapter when token is missing, accounts missing, or JSON invalid', () => {
    // Start from a known state: no meta adapters registered.
    // (Previous tests may have left page adapters, but meta adapters are independent.)
    createCrumMastra(envWith(), { storage: testStore() })
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)

    // Token missing
    const { CRUM_META_ADS_ACCESS_TOKEN: _omitted, ...noToken } = META_ENV
    createCrumMastra(envWith(noToken), { storage: testStore() })
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)

    // Accounts missing
    const { CRUM_META_AD_ACCOUNTS: _omitted2, ...noAccounts } = META_ENV
    createCrumMastra(envWith(noAccounts), { storage: testStore() })
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)

    // Invalid JSON
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      createCrumMastra(envWith({
        CRUM_META_ADS_ACCESS_TOKEN: 'tok',
        CRUM_META_AD_ACCOUNTS: 'not-json',
      }), { storage: testStore() })
      expect(isExecutable('create_campaign')).toBe(false)
      expect(isExecutable('set_campaign_status')).toBe(false)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse CRUM_META_AD_ACCOUNTS'),
        expect.anything(),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('registers both adapters when token and accounts are present', () => {
    createCrumMastra(envWith(META_ENV), { storage: testStore() })
    expect(isExecutable('create_campaign')).toBe(true)
    expect(isExecutable('set_campaign_status')).toBe(true)
  })

  it('parses ad accounts correctly from JSON', () => {
    const accounts = '["act_abc123","act_def456","act_ghi789"]'
    createCrumMastra(envWith({
      CRUM_META_ADS_ACCESS_TOKEN: 'tok',
      CRUM_META_AD_ACCOUNTS: accounts,
    }), { storage: testStore() })
    // The adapters are registered, which means the accounts were parsed.
    expect(isExecutable('create_campaign')).toBe(true)
    expect(isExecutable('set_campaign_status')).toBe(true)
  })

  it('logs a warning when configuration is incomplete', () => {
    // First, register the adapters to set the lane to 'meta-ads'.
    createCrumMastra(envWith(META_ENV), { storage: testStore() })
    // Now spy on console.log and construct without meta config, which should
    // change the lane from 'meta-ads' to 'none' and log the warning.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createCrumMastra(envWith(), { storage: testStore() })
      const metaLines = log.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('Meta Ads API'))
      expect(metaLines).toContain(
        '[CRUM] Meta Ads API not configured; create_campaign and set_campaign_status actions will be refused at staging',
      )
    } finally {
      log.mockRestore()
    }
  })

  it('logs the meta lane once per change, not once per construction', () => {
    // Settle the module's remembered lane first.
    createCrumMastra(envWith(), { storage: testStore() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createCrumMastra(envWith(META_ENV), { storage: testStore() })
      createCrumMastra(envWith(META_ENV), { storage: testStore() })
      const metaLines = log.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('Meta Ads API adapters registered'))
      expect(metaLines).toEqual(['[CRUM] Meta Ads API adapters registered'])
    } finally {
      log.mockRestore()
    }
  })
})

describe('slice 4 image adapter registration', () => {
  const IMAGE_ENV: Record<string, string> = {
    CRUM_REPLICATE_API_TOKEN: 'r8_test_token_at_least_thirty_two_bytes_long',
  }

  it('leaves no adapter registered when the token is absent', async () => {
    const { selectImageAdapter, __imageProviderRegistry } = await import('../../src/marketing/image-provider')
    __imageProviderRegistry.clear()
    createCrumMastra(envWith(), { storage: testStore() })
    expect(selectImageAdapter()).toBeNull()
  })

  it('registers an adapter carrying the ceiling and estimate the env supplied', async () => {
    const { selectImageAdapter, __imageProviderRegistry } = await import('../../src/marketing/image-provider')
    __imageProviderRegistry.clear()
    createCrumMastra(
      envWith({ ...IMAGE_ENV, CRUM_IMAGE_SPEND_CEILING_MINOR: '5000', CRUM_IMAGE_COST_MINOR_PER_IMAGE: '9' }),
      { storage: testStore() },
    )
    const adapter = selectImageAdapter()
    expect(adapter).not.toBeNull()
    expect(adapter?.provider).toBe('replicate')
    expect(adapter?.model).toBe('black-forest-labs/flux-1.1-pro')
    expect(adapter?.ceilingMinor).toBe(5000)
    expect(adapter?.costMinorPerImage).toBe(9)
    // The byte ceiling comes from the document lane, not from a new number: an
    // asset that could not be stored must not be generatable.
    expect(adapter?.maxBytes).toBe(15 * 1024 * 1024)
  })

  it('logs the image lane once per change, not once per construction', () => {
    createCrumMastra(envWith(), { storage: testStore() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createCrumMastra(envWith(IMAGE_ENV), { storage: testStore() })
      createCrumMastra(envWith(IMAGE_ENV), { storage: testStore() })
      const lines = log.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('image adapter'))
      expect(lines).toEqual(['[CRUM] image adapter registered: replicate'])
    } finally {
      log.mockRestore()
    }
  })
})
