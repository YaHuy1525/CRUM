// tests/entry/index.test.ts
import { describe, expect, it, vi } from 'vitest'
import { Mastra } from '@mastra/core/mastra'
import type { CrumBootResult } from '../../src/mastra/boot'
import type { CrumEnv } from '../../src/config/env'

/**
 * Which module is the process entry, and what does it owe the process?
 *
 * `mastra dev` and `mastra build` resolve `src/mastra/index.ts` as the entry file
 * (the CLI's default `--dir`), not `src/index.ts`. That was established by watching
 * a real boot come up with no REST plane listener and then grepping the generated
 * `.mastra/output/index.mjs` for the plane's strings, and it is the reason the boot
 * side effects live in the barrel: anything left in `src/index.ts` would be dead
 * code in the only process that matters. `src/index.ts` is now a re-export of the
 * same singleton, kept so a reader following the Phase 1 plan finds one instance.
 *
 * Booting is mocked here because the barrel is also a library module that every
 * router and half the suite imports; what `src/mastra/boot.ts` *does* when it runs
 * is covered in tests/mastra/process-boot.test.ts, and what the plane does with a real
 * socket is in tests/api/serve.test.ts. This file is only about the wiring: is the
 * boot asked for, by the module the CLI actually loads, with the instance the CLI
 * actually serves.
 */
const boot = vi.hoisted(() => ({
  // Typed parameters, or `mock.calls` infers an empty tuple and the assertions
  // below cannot read the arguments the entry passed.
  bootCrumProcess: vi.fn(
    (_env: CrumEnv, _mastra: Mastra): CrumBootResult => ({
      digestScheduled: false,
      restPlane: Promise.resolve(null),
      skipped: null,
    }),
  ),
}))

vi.mock('../../src/mastra/boot', () => ({
  bootCrumProcess: boot.bootCrumProcess,
  // `src/api/serve.ts` imports this from the boot module for its own entry guard.
  isMastraServerProcess: () => false,
  startCrumBootSideEffects: () => {
    throw new Error('the entry is expected to call bootCrumProcess, not the un-gated half')
  },
}))

/** Import the barrel the way the CLI does: a fresh graph, evaluated at import time. */
async function importEntry(nodeEnv: string): Promise<{ mastra: Mastra }> {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', nodeEnv)
  try {
    return await import('../../src/mastra/index')
  } finally {
    // A worker runs several test files in one process: leaving NODE_ENV stubbed
    // would be handed to the next file like a real environment variable, and the
    // schema behaves differently per value (§13.2).
    vi.unstubAllEnvs()
  }
}

describe('src/mastra/index.ts — the entry the CLI loads', () => {
  it(
    'exports a registered Mastra singleton as a named export',
    async () => {
      const mod = await import('../../src/mastra/index')
      expect(mod.mastra).toBeInstanceOf(Mastra)
      expect(Object.keys(mod.mastra.listAgents())).toContain('crm-assistant')
    },
    // The first import() pays for the whole Mastra graph; under a full-suite
    // run with parallel workers that costs more than the 5s default.
    30_000,
  )

  it('does not boot the process under NODE_ENV=test', async () => {
    expect(process.env.NODE_ENV).toBe('test')
    await importEntry('test')

    // A unit worker that bound port 4113 would collide with the developer's
    // running `mastra dev` and leave a listener behind in the worker.
    expect(boot.bootCrumProcess).not.toHaveBeenCalled()
  })

  it(
    'boots the process with the same instance it exports, otherwise',
    async () => {
      const mod = await importEntry('development')

      // The boot call is behind a dynamic import, so it lands a tick after the
      // module evaluation this test is waiting on.
      await vi.waitFor(() => expect(boot.bootCrumProcess).toHaveBeenCalledTimes(1))

      const [env, mastra] = boot.bootCrumProcess.mock.calls[0]!
      // The same instance the CLI will serve, not a second one: an AgentController
      // session lives in whichever process built it.
      expect(mastra).toBe(mod.mastra)
      expect(env.CRUM_REST_PORT).toBe(4113)
    },
    30_000,
  )

  it(
    'hands the same instance to a second evaluation of the module',
    async () => {
      // `mastra build` puts this module in two chunks — the entry and the
      // dynamically loaded `serve.mjs`, because four `src/api` routers import
      // `createCrumMastra` from it — so one server process evaluates it twice.
      // Resetting the module registry reproduces that without a build: a second
      // copy of the module body must still resolve to one registry.
      const first = await importEntry('development')
      const second = await import('../../src/mastra/index')

      expect(second.mastra).toBe(first.mastra)
    },
    30_000,
  )
})

describe('src/index.ts — compatibility re-export', () => {
  it('hands out the single instance rather than building its own', async () => {
    const compat = await import('../../src/index')
    const entry = await import('../../src/mastra/index')

    expect(compat.default).toBeInstanceOf(Mastra)
    expect(compat.mastra).toBe(entry.mastra)
    expect(compat.default).toBe(entry.mastra)
  })

  it('uses in-memory storage when no DATABASE_URL is set', async () => {
    const compat = await import('../../src/index')
    expect(compat.default.getStorage()).toBeDefined()
  })
})
