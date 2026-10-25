// tests/mastra/process-boot.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Mastra } from '@mastra/core/mastra'
import { parseEnv } from '../../src/config/env'
import {
  bootCrumProcess,
  isMastraServerProcess,
  startCrumBootSideEffects,
} from '../../src/mastra/boot'

/**
 * `src/mastra/boot.ts` holds the two things the process owes: the digest schedule
 * and the `/api` REST plane. The plane module is mocked, so this file is about the
 * decisions — when it is asked for, with what, and what a failure means — rather
 * than about sockets (tests/api/serve.test.ts binds real ones).
 *
 * Named `process-boot` to stay clear of tests/mastra/boot.test.ts, which is about
 * how the *registry* is constructed (agents, workflows, observability, MCP guard)
 * and says nothing about starting a process.
 */
const serve = vi.hoisted(() => ({
  startApiServer: vi.fn(),
}))

vi.mock('../../src/api/serve', () => ({
  startApiServer: serve.startApiServer,
}))

interface BootMarkerGlobal {
  __crumBootStarted?: boolean
}

function fakeMastra(create = vi.fn().mockResolvedValue({ id: 's', cron: 'x', timezone: null })): {
  mastra: Mastra
  create: typeof create
} {
  return { mastra: { schedules: { create } } as unknown as Mastra, create }
}

/** How a chunk of the built server names itself, whatever spawned the process. */
const SERVER_URL = 'file:///D:/Code/CRUM/.mastra/output/boot.mjs'
/** How the same module is named when `tsx` or `vitest` loads it from source. */
const SOURCE_URL = 'file:///D:/Code/CRUM/src/mastra/boot.ts'

describe('isMastraServerProcess', () => {
  it.each([
    ['a bundled chunk on Windows', 'file:///D:/Code/CRUM/.mastra/output/boot.mjs', true],
    ['a bundled chunk on POSIX', 'file:///home/dev/CRUM/.mastra/output/boot.mjs', true],
    ['the bundle entry itself', 'file:///D:/Code/CRUM/.mastra/output/index.mjs', true],
    ['a chunk in the dev staging directory', 'file:///D:/Code/CRUM/.mastra/.build/boot.mjs', true],
    ['a native path override', 'D:\\Code\\CRUM\\.mastra\\output\\index.mjs', true],
    ['a relative output path', '.mastra/output/index.mjs', true],
    ['the same module loaded from source', SOURCE_URL, false],
    ['a source file run by tsx', 'file:///D:/Code/CRUM/src/api/serve.ts', false],
    ['a directory named like the marker but not on a boundary', 'D:\\my.mastra\\output\\x.mjs', false],
  ])('recognises %s', (_label, url, expected) => {
    expect(isMastraServerProcess(url)).toBe(expected)
  })

  it('asks where this module came from, not what the process was started with', () => {
    // The gate has to hold however the CLI launches the bundle: `mastra start`
    // runs `node .mastra/output/index.mjs`, `mastra dev` spawns the same file
    // through execa, and this worker was started by vitest. Reading the module
    // URL instead of `process.argv` is what makes all three behave alike, so the
    // same process must judge itself differently depending on which URL it is
    // asked about.
    expect(isMastraServerProcess()).toBe(false)
    expect(isMastraServerProcess(SERVER_URL)).toBe(true)
  })
})

describe('bootCrumProcess gates', () => {
  it('refuses in the test environment without touching the plane', async () => {
    const { mastra, create } = fakeMastra()
    const result = bootCrumProcess(parseEnv({ NODE_ENV: 'test' }), mastra, SERVER_URL)

    expect(result.skipped).toBe('test')
    expect(await result.restPlane).toBeNull()
    expect(serve.startApiServer).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses in a process that is not the CLI server', async () => {
    // The barrel behind this function is imported by every router, so a migration
    // script run with tsx must not bind port 4113 as a side effect of an `import`.
    const { mastra, create } = fakeMastra()
    const result = bootCrumProcess(
      parseEnv({ CRUM_DIGEST_CRON: '0 7 * * *' }),
      mastra,
      'D:\\Code\\CRUM\\scripts\\db-migrate.ts',
    )

    expect(result.skipped).toBe('not-server-process')
    expect(await result.restPlane).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('boots when the module really is the built server', async () => {
    serve.startApiServer.mockResolvedValue({ port: 4113, close: vi.fn() })
    const { mastra, create } = fakeMastra()

    const result = bootCrumProcess(parseEnv({}), mastra, SERVER_URL)
    expect(result.skipped).toBeNull()
    expect((await result.restPlane)?.port).toBe(4113)
    expect(create).not.toHaveBeenCalled() // no CRUM_DIGEST_CRON in the default env
  })
})

describe('startCrumBootSideEffects', () => {
  beforeEach(() => {
    // The marker lives on globalThis so a hot reload inside one process cannot
    // double-bind; a suite has to clear it explicitly to test a fresh boot.
    delete (globalThis as unknown as BootMarkerGlobal).__crumBootStarted
    serve.startApiServer.mockReset().mockResolvedValue({ port: 4123, close: vi.fn() })
  })

  it('binds the plane beside the instance it was handed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const env = parseEnv({})
    const { mastra } = fakeMastra()

    try {
      const handle = await startCrumBootSideEffects(env, mastra).restPlane

      expect(serve.startApiServer).toHaveBeenCalledTimes(1)
      expect(serve.startApiServer.mock.calls[0]![0]).toEqual({ env, mastra })
      expect(handle?.port).toBe(4123)
      expect(log).toHaveBeenCalledWith('[CRUM] REST plane listening on http://127.0.0.1:4123')
    } finally {
      log.mockRestore()
    }
  })

  it('registers the digest schedule only when a cron is configured', async () => {
    const withoutCron = fakeMastra()
    const unset = startCrumBootSideEffects(parseEnv({}), withoutCron.mastra)
    await unset.restPlane
    expect(unset.digestScheduled).toBe(false)
    expect(withoutCron.create).not.toHaveBeenCalled()

    delete (globalThis as unknown as BootMarkerGlobal).__crumBootStarted

    const withCron = fakeMastra()
    const set = startCrumBootSideEffects(parseEnv({ CRUM_DIGEST_CRON: '0 7 * * *' }), withCron.mastra)
    await set.restPlane
    expect(set.digestScheduled).toBe(true)
    expect(withCron.create).toHaveBeenCalledWith({
      id: 'crum-digest-morning',
      workflowId: 'crum-digest',
      cron: '0 7 * * *',
      timezone: 'UTC',
    })
  })

  it('logs a schedule that fails to persist instead of failing the boot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { mastra, create } = fakeMastra(
      vi.fn().mockRejectedValue(new Error('storage unreachable')),
    )

    try {
      const result = startCrumBootSideEffects(
        parseEnv({ CRUM_DIGEST_CRON: '0 7 * * *' }),
        mastra,
      )
      // The plane is the part a caller may await; the schedule is fire-and-forget.
      await result.restPlane

      expect(create).toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(
        '[CRUM] Failed to create digest schedule: storage unreachable',
      )
    } finally {
      error.mockRestore()
    }
  })

  it('degrades a refused bind to null rather than an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    serve.startApiServer.mockRejectedValue(new Error('listen EADDRINUSE :::4113'))
    const { mastra } = fakeMastra()

    try {
      const result = startCrumBootSideEffects(
        parseEnv({ CRUM_REST_PORT: '4113', CRUM_API_PORT: '4111' }),
        mastra,
      )

      expect(await result.restPlane).toBeNull()
      expect(error).toHaveBeenCalledWith(
        '[CRUM] REST plane did not start on port 4113: listen EADDRINUSE :::4113. ' +
          'The Mastra server on 4111 is unaffected.',
      )
    } finally {
      error.mockRestore()
    }
  })

  it('is a no-op the second time, because a hot reload must not double-bind', async () => {
    const first = startCrumBootSideEffects(parseEnv({}), fakeMastra().mastra)
    await first.restPlane

    const second = startCrumBootSideEffects(parseEnv({}), fakeMastra().mastra)

    expect(second.skipped).toBe('already-started')
    expect(await second.restPlane).toBeNull()
    expect(serve.startApiServer).toHaveBeenCalledTimes(1)
  })
})
