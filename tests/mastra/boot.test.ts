import { describe, expect, it } from 'vitest'
import { Mastra } from '@mastra/core/mastra'
import { InMemoryStore } from '@mastra/core/storage'
import {
  MastraStorageExporter,
  Observability,
  SamplingStrategyType,
} from '@mastra/observability'
import { PostgresStoreVNext } from '@mastra/pg'
import type { MastraStorageExporterConfig } from '@mastra/observability'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import { EnvParseError } from '../../src/config/env'
import { createCrumMastra } from '../../src/mastra'
import {
  buildObservability,
  buildObservabilityConfig,
  crumObservabilityInstanceConfig,
  OBSERVABILITY_INSTANCE,
  OBSERVABILITY_SERVICE_NAME,
  samplingFor,
} from '../../src/mastra/observability'
import {
  assertMcpRequestStateKey,
  McpConfigError,
  resolveMcpRequestState,
} from '../../src/mastra/mcp-guard'

const REMOTE = 'postgresql://crum:secret@db.abcdefgh.supabase.co:5432/postgres'

/** The six secrets §13.8 requires in production. Placeholders, not credentials. */
const PRODUCTION_BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: REMOTE,
  OPENROUTER_API_KEY: 'sk-or-v1-placeholder',
  APPROVAL_HMAC_SECRET: 'a'.repeat(32),
  MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
}

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

/**
 * Most constructions here inject an in-memory store; the remote-DATABASE_URL
 * test below builds the real PostgresStoreVNext instead. Its pools are lazy
 * (§14.4), so nothing in this file opens a socket. Exercising storage.init()
 * against a live database is what tests/integration/ and
 * scripts/db-migrate.ts's main() already do.
 */
function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'boot-test' })
}

describe('createCrumMastra', () => {
  it('constructs with no DATABASE_URL and in-memory storage', () => {
    const mastra = createCrumMastra(envWith(), { storage: testStore() })
    expect(mastra).toBeInstanceOf(Mastra)
    expect(mastra.getStorage()).toBeInstanceOf(InMemoryStore)
  })

  it('constructs when a remote DATABASE_URL is configured', () => {
    const mastra = createCrumMastra(envWith({ DATABASE_URL: REMOTE }), { storage: testStore() })
    expect(mastra).toBeInstanceOf(Mastra)
  })

  it('builds its own storage when none is injected', () => {
    const mastra = createCrumMastra(envWith())
    expect(mastra.getStorage()).toBeInstanceOf(InMemoryStore)
  })

  it('builds its own Postgres store when a remote DATABASE_URL is configured', () => {
    // Pools are lazy, so constructing against a remote-but-unconnected URL is
    // offline-safe. This is the §16 "boots both ways" half the injected-store
    // tests above cannot demonstrate.
    expect(
      createCrumMastra(envWith({ DATABASE_URL: REMOTE })).getStorage(),
    ).toBeInstanceOf(PostgresStoreVNext)
  })

  it('carries the store id so logs and schema isolation agree', () => {
    const mastra = createCrumMastra(envWith())
    expect(mastra.getStorage()?.id ?? '').not.toBe('')
  })

  it('propagates an invalid environment rather than booting on defaults', () => {
    expect(() =>
      createCrumMastra(parseEnv({ MASTRA_PG_POOL_MAX: '9' })),
    ).toThrowError(EnvParseError)
  })

  it('refuses to boot in production without MCP_REQUEST_STATE_KEY', () => {
    const { MCP_REQUEST_STATE_KEY: _omitted, ...rest } = PRODUCTION_BASE
    expect(() => createCrumMastra(parseEnv(rest))).toThrowError(McpConfigError)
  })

  it('names the missing variable in the production boot failure', () => {
    const { MCP_REQUEST_STATE_KEY: _omitted, ...rest } = PRODUCTION_BASE
    try {
      createCrumMastra(parseEnv(rest))
      expect.unreachable('production without MCP_REQUEST_STATE_KEY must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError)
      expect((error as McpConfigError).variables).toEqual(['MCP_REQUEST_STATE_KEY'])
      expect((error as McpConfigError).message).toContain('MCP_REQUEST_STATE_KEY')
    }
  })

  it('boots in production with the full secret set', () => {
    const mastra = createCrumMastra(parseEnv(PRODUCTION_BASE), {
      storage: testStore(),
    })
    expect(mastra).toBeInstanceOf(Mastra)
  })

  it('registers the crmAssistant agent', () => {
    const mastra = createCrumMastra(envWith())
    expect(Object.keys(mastra.listAgents())).toContain('crm-assistant')
  })

  it('registers Phase 5 agents (parser, email-drafter)', () => {
    const mastra = createCrumMastra(envWith())
    const agentKeys = Object.keys(mastra.listAgents()).sort()
    expect(agentKeys).toEqual(['crm-assistant', 'digest', 'email-drafter', 'parser'])
  })

  it('registers Phase 5 classifiers (intent, injection)', () => {
    const mastra = createCrumMastra(envWith())
    const classifiers = mastra.listClassifiers?.() ?? {}
    const classifierKeys = Object.keys(classifiers).sort()
    expect(classifierKeys).toEqual(['crum-injection', 'crum-intent'])
  })

  it('registers the intent triage workflow', () => {
    const mastra = createCrumMastra(envWith())
    const workflows = mastra.listWorkflows?.() ?? {}
    expect(workflows).toHaveProperty('crum-intent-triage')
    expect(workflows).toHaveProperty('knowledge-ingest')
  })

  it('registers the MCP server', () => {
    const mastra = createCrumMastra(envWith())
    const mcpServers = mastra.listMCPServers?.() ?? {}
    expect(mcpServers).toHaveProperty('crum-crm')
  })
})

describe('samplingFor', () => {
  it('samples everything at probability 1', () => {
    expect(samplingFor(envWith({ MASTRA_TRACE_PROBABILITY: '1' }))).toEqual({
      type: SamplingStrategyType.ALWAYS,
    })
  })

  it('samples nothing at probability 0', () => {
    expect(samplingFor(envWith({ MASTRA_TRACE_PROBABILITY: '0' }))).toEqual({
      type: SamplingStrategyType.NEVER,
    })
  })

  it('uses ratio sampling in between', () => {
    expect(samplingFor(envWith({ MASTRA_TRACE_PROBABILITY: '0.25' }))).toEqual({
      type: SamplingStrategyType.RATIO,
      probability: 0.25,
    })
  })

  it('defaults to sampling everything, so a missing variable is loud rather than blind', () => {
    expect(samplingFor(envWith())).toEqual({ type: SamplingStrategyType.ALWAYS })
  })
})

describe('crumObservabilityInstanceConfig', () => {
  it('names the service and the instance', () => {
    const config = crumObservabilityInstanceConfig(envWith())
    expect(config.serviceName).toBe(OBSERVABILITY_SERVICE_NAME)
    expect(OBSERVABILITY_INSTANCE).toBe('crum')
  })

  it('passes no storage to the exporter, because storage arrives through init()', () => {
    const config = crumObservabilityInstanceConfig(envWith())
    expect(config.exporters).toHaveLength(1)
    expect(config.exporters[0]).toBeInstanceOf(MastraStorageExporter)

    /**
     * The trap this guards. MastraStorageExporterConfig extends
     * BaseExporterConfig and neither declares `storage`; the exporter receives it
     * in init(InitExporterOptions), which Observability.setMastraContext calls
     * with the Mastra instance's own store. If this directive ever becomes
     * unused, the constructor grew a storage option and the comment above is
     * stale, so typecheck fails and somebody reads this before deleting it.
     */
    // @ts-expect-error MastraStorageExporterConfig has no storage field
    const withStorage: MastraStorageExporterConfig = { storage: {} }
    expect(withStorage).toBeDefined()
  })

  it('adds no span output processor, so the registry-level sensitive data filter still applies', () => {
    const config = crumObservabilityInstanceConfig(envWith())
    expect(config).not.toHaveProperty('spanOutputProcessors')
  })
})

describe('buildObservabilityConfig', () => {
  it('registers one instance under the crum key', () => {
    const registry = buildObservabilityConfig(envWith({ MASTRA_TRACE_PROBABILITY: '0.5' }))
    expect(Object.keys(registry.configs ?? {})).toEqual([OBSERVABILITY_INSTANCE])
  })

  it('states the sensitive data filter explicitly rather than relying on a default', () => {
    const filter = buildObservabilityConfig(envWith()).sensitiveDataFilter
    expect(filter).toBeDefined()
    expect(typeof filter).toBe('object')
    expect(filter).not.toBe(true)
  })

  it('does not use the deprecated `default` registry key', () => {
    expect(buildObservabilityConfig(envWith()).default).toBeUndefined()
  })
})

describe('buildObservability', () => {
  it('returns undefined when MASTRA_OBSERVABILITY is not true', () => {
    expect(buildObservability(envWith())).toBeUndefined()
    expect(buildObservability(envWith({ MASTRA_OBSERVABILITY: 'false' }))).toBeUndefined()
  })

  it('returns an Observability entrypoint when enabled', async () => {
    const observability = buildObservability(envWith({ MASTRA_OBSERVABILITY: 'true' }))
    expect(observability).toBeInstanceOf(Observability)
    expect(observability?.flush.bind(observability)).toBeTypeOf('function')
    await observability?.shutdown()
  })

  it('can be handed straight to Mastra', async () => {
    const env = envWith({ MASTRA_OBSERVABILITY: 'true' })
    const observability = buildObservability(env)
    const mastra = new Mastra({ storage: testStore(), observability })
    expect(mastra).toBeInstanceOf(Mastra)
    await observability?.shutdown()
  })
})

describe('resolveMcpRequestState', () => {
  it('uses the configured key when one is present', () => {
    const decision = resolveMcpRequestState(envWith({ MCP_REQUEST_STATE_KEY: 'c'.repeat(32) }))
    expect(decision).toEqual({
      mount: true,
      key: 'c'.repeat(32),
      ephemeral: false,
      warning: undefined,
    })
  })

  it('generates a per-process key outside production and says so', () => {
    const decision = resolveMcpRequestState(envWith())
    expect(decision.mount).toBe(true)
    expect(decision.ephemeral).toBe(true)
    expect(decision.key.length).toBeGreaterThanOrEqual(32)
    expect(decision.warning).toMatch(/will not survive a restart or a second replica/)
  })

  it('generates a different key per call, proving it is not a constant', () => {
    const first = resolveMcpRequestState(envWith())
    const second = resolveMcpRequestState(envWith())
    expect(first.key).not.toBe(second.key)
  })

  it('throws in production', () => {
    const { MCP_REQUEST_STATE_KEY: _omitted, ...rest } = PRODUCTION_BASE
    expect(() => resolveMcpRequestState(parseEnv(rest))).toThrowError(
      McpConfigError,
    )
  })

  it('accepts a valid key without throwing', () => {
    const key = 'd'.repeat(32)
    try {
      assertMcpRequestStateKey(
        parseEnv({ NODE_ENV: 'production', MCP_REQUEST_STATE_KEY: 'short' }),
      )
    } catch {
      // A too-short key is rejected by EnvSchema before the guard sees it, so
      // this path only proves the guard does not leak whatever reached it.
    }
    expect(() =>
      assertMcpRequestStateKey(envWith({ MCP_REQUEST_STATE_KEY: key })),
    ).not.toThrow()
  })
})

describe('assertMcpRequestStateKey', () => {
  it('passes outside production with no key', () => {
    expect(() => assertMcpRequestStateKey(envWith())).not.toThrow()
  })

  it('passes in production with a key', () => {
    expect(() => assertMcpRequestStateKey(parseEnv(PRODUCTION_BASE))).not.toThrow()
  })
})
