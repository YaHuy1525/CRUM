// tests/marketing/sunra.test.ts
// Unit tests for the Sunra CLI adapter. These tests exercise the pure helpers
// (credit mapping, URL extraction, aspect ratio validation) and the full
// generateImage flow with injected CLI and fetch mocks — no real subprocess or
// network call reaches Sunra.
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SUNRA_ASPECT_RATIOS,
  createSunraProjectCache,
  creditsToCharge,
  extractCredits,
  extractNodeIds,
  extractUrls,
  generateImage,
  isSunraAspectRatio,
  resolveSunraCli,
} from '@/marketing/sunra'
import type { SunraCallResult } from '@/marketing/sunra'

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void

function makeExecMock(impl: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => void): typeof execFile {
  const fn = vi.fn<(cmd: string, args: string[], opts: unknown, cb: ExecCb) => void>()
  fn.mockImplementation(impl)
  return fn as unknown as typeof execFile
}

function makeFetchMock(impl: (url: string) => Promise<Response>): typeof fetch {
  const fn = vi.fn<(url: string) => Promise<Response>>()
  fn.mockImplementation(impl)
  return fn as unknown as typeof fetch
}

// ── creditsToCharge ──────────────────────────────────────────────────────────

describe('creditsToCharge', () => {
  it('maps 22 credits to 22 cents and $0.22', () => {
    const charge = creditsToCharge(22, 'pred-1')
    expect(charge.costMinor).toBe(22)
    expect(charge.costUsd).toBe('0.22')
    expect(charge.predictionId).toBe('pred-1')
  })

  it('maps zero credits to zero cost', () => {
    const charge = creditsToCharge(0, 'pred-2')
    expect(charge.costMinor).toBe(0)
    expect(charge.costUsd).toBe('0.00')
  })

  it('rounds large credits correctly', () => {
    const charge = creditsToCharge(10_000, 'pred-3')
    expect(charge.costMinor).toBe(10_000)
    expect(charge.costUsd).toBe('100.00')
  })
})

// ── isSunraAspectRatio ───────────────────────────────────────────────────────

describe('isSunraAspectRatio', () => {
  it('accepts all seven gpt-image-2 ratios', () => {
    for (const ratio of SUNRA_ASPECT_RATIOS) {
      expect(isSunraAspectRatio(ratio)).toBe(true)
    }
  })

  it('rejects "auto", which is a Replicate concept not a Sunra one', () => {
    expect(isSunraAspectRatio('auto')).toBe(false)
  })

  it('rejects unknown ratios', () => {
    expect(isSunraAspectRatio('5:4')).toBe(false)
    expect(isSunraAspectRatio('')).toBe(false)
    expect(isSunraAspectRatio('1:2')).toBe(false)
  })
})

// ── extractUrls ──────────────────────────────────────────────────────────────

describe('extractUrls', () => {
  it('finds image URLs in a flat object', () => {
    const data = { url: 'https://cdn.sunra.ai/gen/image.png', other: 'not-a-url' }
    expect(extractUrls(data)).toEqual(['https://cdn.sunra.ai/gen/image.png'])
  })

  it('finds URLs nested in arrays and objects, deduplicating', () => {
    const data = {
      nodes: [
        { urls: ['https://cdn.sunra.ai/a.png'], src: 'https://cdn.sunra.ai/a.png' },
        { out_image: 'https://cdn.sunra.ai/b.jpg' },
      ],
    }
    const urls = extractUrls(data)
    expect(urls).toContain('https://cdn.sunra.ai/a.png')
    expect(urls).toContain('https://cdn.sunra.ai/b.jpg')
    expect(urls.filter((u) => u.endsWith('a.png'))).toHaveLength(1)
  })

  it('returns empty for no URLs', () => {
    expect(extractUrls({})).toEqual([])
    expect(extractUrls(null)).toEqual([])
    expect(extractUrls('hello')).toEqual([])
  })

  it('ignores non-image HTTP URLs', () => {
    const data = { link: 'https://example.com/page', api: 'https://api.sunra.ai/v1/status' }
    expect(extractUrls(data)).toEqual([])
  })
})

// ── extractCredits ───────────────────────────────────────────────────────────

describe('extractCredits', () => {
  it('finds credits in structuredContent', () => {
    const data = { structuredContent: { estimated_credits: 22 } }
    expect(extractCredits(data)).toBe(22)
  })

  it('finds total_credits at the top level', () => {
    expect(extractCredits({ total_credits: 15 })).toBe(15)
  })

  it('returns 0 when no credits field exists', () => {
    expect(extractCredits({})).toBe(0)
    expect(extractCredits(null)).toBe(0)
  })

  it('prefers the first numeric match found in a deep walk', () => {
    const data = { a: { credits: 10 }, b: { credits: 20 } }
    expect(extractCredits(data)).toBe(10)
  })
})

// ── extractNodeIds ───────────────────────────────────────────────────────────

describe('extractNodeIds', () => {
  it('extracts node_ids from structuredContent', () => {
    const data: SunraCallResult = {
      structuredContent: { node_ids: ['node-1', 'node-2'] },
    }
    expect(extractNodeIds(data)).toEqual(['node-1', 'node-2'])
  })

  it('falls back to parsing the content array text', () => {
    const data: SunraCallResult = {
      content: [{ type: 'text', text: '{"node_ids":["node-x"]}' }],
    }
    expect(extractNodeIds(data)).toEqual(['node-x'])
  })

  it('returns empty when no node_ids exist', () => {
    expect(extractNodeIds({})).toEqual([])
    expect(extractNodeIds({ structuredContent: {} })).toEqual([])
  })

  it('filters out non-string entries', () => {
    const data: SunraCallResult = {
      structuredContent: { node_ids: ['valid', 42, null, 'also-valid'] },
    }
    expect(extractNodeIds(data)).toEqual(['valid', 'also-valid'])
  })
})

// ── createSunraProjectCache ──────────────────────────────────────────────────

describe('createSunraProjectCache', () => {
  it('starts with null projectId', () => {
    const cache = createSunraProjectCache()
    expect(cache.projectId).toBeNull()
  })

  it('returns independent instances', () => {
    const a = createSunraProjectCache()
    const b = createSunraProjectCache()
    a.projectId = 'test-id'
    expect(b.projectId).toBeNull()
  })
})

// ── resolveSunraCli ──────────────────────────────────────────────────────────

describe('resolveSunraCli', () => {
  it('returns a string path or null', () => {
    const result = resolveSunraCli()
    if (result !== null) {
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    }
  })
})

// ── generateImage: validation ────────────────────────────────────────────────

describe('generateImage validation', () => {
  const baseConfig = { maxBytes: 10_000_000, projectCache: createSunraProjectCache() }

  it('refuses a prompt over MAX_PROMPT_CHARS', async () => {
    const result = await generateImage(
      { prompt: 'x'.repeat(2001), aspectRatio: '1:1', seed: 42 },
      baseConfig,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('prompt_too_long')
    }
  })

  it('refuses an unsupported aspect ratio', async () => {
    const result = await generateImage(
      { prompt: 'test', aspectRatio: '5:4', seed: 42 },
      baseConfig,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unsupported_aspect_ratio')
      expect(result.detail).toContain('5:4')
    }
  })

  it('maps "auto" aspect ratio to "1:1" and accepts it', async () => {
    const mockExec = makeExecMock((_cmd, _args, _opts, cb) => {
      cb(new Error('mock'), '', 'mock error')
    })

    const result = await generateImage(
      { prompt: 'test', aspectRatio: 'auto', seed: 42 },
      { ...baseConfig, execImpl: mockExec },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).not.toBe('unsupported_aspect_ratio')
    }
  })
})

// ── generateImage: CLI error handling ────────────────────────────────────────

describe('generateImage CLI errors', () => {
  const baseConfig = { maxBytes: 10_000_000, projectCache: createSunraProjectCache() }

  it('returns image_generation_failed when create_project CLI call fails', async () => {
    const mockExec = makeExecMock((_cmd, _args, _opts, cb) => {
      cb({ code: 1 } as unknown as Error, '', 'sunra: command not found')
    })

    const result = await generateImage(
      { prompt: 'test prompt', aspectRatio: '1:1', seed: 42 },
      { ...baseConfig, execImpl: mockExec, timeoutMs: 5000 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('image_generation_failed')
      expect(result.detail).toContain('create_project')
    }
  })

  it('returns image_generation_failed on non-JSON CLI output', async () => {
    let callCount = 0
    const mockExec = makeExecMock((_cmd, _args, _opts, cb) => {
      callCount++
      if (callCount === 1) {
        cb(null, JSON.stringify({
          structuredContent: { project_id: 'proj-123' },
          isError: false,
        }), '')
      } else {
        cb(null, 'this is not json at all', '')
      }
    })

    const result = await generateImage(
      { prompt: 'test prompt', aspectRatio: '1:1', seed: 42 },
      { ...baseConfig, execImpl: mockExec, timeoutMs: 5000 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('image_generation_failed')
      expect(result.detail).toContain('not valid JSON')
    }
  })

  it('returns image_generation_failed when CLI reports auth error', async () => {
    const mockExec = makeExecMock((_cmd, _args, _opts, cb) => {
      cb({ code: 1 } as unknown as Error, '', 'Error: not signed in. Run sunra login.')
    })

    const result = await generateImage(
      { prompt: 'test prompt', aspectRatio: '1:1', seed: 42 },
      { ...baseConfig, execImpl: mockExec, timeoutMs: 5000 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('image_generation_failed')
      expect(result.deadToken).toBe(true)
      expect(result.detail).toContain('not authenticated')
    }
  })

  it('returns image_generation_timeout when CLI times out', async () => {
    const mockExec = makeExecMock((_cmd, _args, _opts, cb) => {
      const err = new Error('timeout') as Error & { killed: boolean }
      err.killed = true
      cb(err, '', '')
    })

    const result = await generateImage(
      { prompt: 'test prompt', aspectRatio: '1:1', seed: 42 },
      { ...baseConfig, execImpl: mockExec, timeoutMs: 1000 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('image_generation_timeout')
    }
  })
})

// ── generateImage: full flow with mocks ──────────────────────────────────────

describe('generateImage full flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates project, generates image, polls, downloads, and returns ok', async () => {
    const projectCache = createSunraProjectCache()
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    let callCount = 0
    const mockExec = makeExecMock((_cmd, args: string[], _opts, cb) => {
      callCount++
      const tool = args[1]

      if (tool === 'create_project') {
        cb(null, JSON.stringify({
          structuredContent: { project_id: 'proj-test-123' },
          isError: false,
        }), '')
      } else if (tool === 'create_image') {
        cb(null, JSON.stringify({
          structuredContent: {
            node_ids: ['node-abc'],
            estimated_credits: 22,
          },
          isError: false,
        }), '')
      } else if (tool === 'wait_for_nodes') {
        cb(null, JSON.stringify({
          structuredContent: {
            timed_out: false,
            failed: false,
            nodes: [{
              id: 'node-abc',
              status: 'completed',
              urls: ['https://cdn.sunra.ai/gen/result.png'],
            }],
          },
          isError: false,
        }), '')
      }
    })

    const mockFetch = makeFetchMock(() => Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(pngBytes.buffer),
    } as Response))

    const config = {
      maxBytes: 10_000_000,
      timeoutMs: 5000,
      execImpl: mockExec,
      fetchImpl: mockFetch,
      projectCache,
    }

    const promise = generateImage(
      { prompt: 'a red circle', aspectRatio: '1:1', seed: 42 },
      config,
    )

    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.model).toBe('gpt-image-2')
      expect(result.image.aspectRatio).toBe('1:1')
      expect(result.image.mime).toBe('image/png')
      expect(result.image.sizeBytes).toBe(8)
      expect(result.image.costMinor).toBe(22)
      expect(result.image.costUsd).toBe('0.22')
      expect(result.image.bytes).toBeInstanceOf(Uint8Array)
    }

    expect(projectCache.projectId).toBe('proj-test-123')
    expect(callCount).toBe(3)
    expect(mockFetch).toHaveBeenCalledWith('https://cdn.sunra.ai/gen/result.png')
  })

  it('reuses cached project id on second call', async () => {
    const projectCache = createSunraProjectCache()
    projectCache.projectId = 'proj-cached'

    const pngBytes = new Uint8Array([1, 2, 3])
    const mockExec = makeExecMock((_cmd, args: string[], _opts, cb) => {
      const tool = args[1]

      if (tool === 'create_project') {
        cb(new Error('should not be called'), '', '')
      } else if (tool === 'create_image') {
        cb(null, JSON.stringify({
          structuredContent: { node_ids: ['node-1'], estimated_credits: 5 },
          isError: false,
        }), '')
      } else if (tool === 'wait_for_nodes') {
        cb(null, JSON.stringify({
          structuredContent: {
            timed_out: false,
            failed: false,
            nodes: [{ id: 'node-1', status: 'completed', urls: ['https://cdn.sunra.ai/img.png'] }],
          },
          isError: false,
        }), '')
      }
    })

    const mockFetch = makeFetchMock(() => Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(pngBytes.buffer),
    } as Response))

    const result = await generateImage(
      { prompt: 'test', aspectRatio: '1:1', seed: 1 },
      { maxBytes: 10_000_000, timeoutMs: 5000, execImpl: mockExec, fetchImpl: mockFetch, projectCache },
    )

    expect(result.ok).toBe(true)
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('returns asset_too_large when downloaded bytes exceed maxBytes', async () => {
    const projectCache = createSunraProjectCache()
    const largeBytes = new Uint8Array(1000)

    const mockExec = makeExecMock((_cmd, args: string[], _opts, cb) => {
      const tool = args[1]
      if (tool === 'create_project') {
        cb(null, JSON.stringify({ structuredContent: { project_id: 'proj-1' }, isError: false }), '')
      } else if (tool === 'create_image') {
        cb(null, JSON.stringify({ structuredContent: { node_ids: ['n1'], estimated_credits: 5 }, isError: false }), '')
      } else {
        cb(null, JSON.stringify({
          structuredContent: {
            timed_out: false,
            failed: false,
            nodes: [{ id: 'n1', status: 'completed', urls: ['https://cdn.sunra.ai/big.png'] }],
          },
          isError: false,
        }), '')
      }
    })

    const mockFetch = makeFetchMock(() => Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(largeBytes.buffer),
    } as Response))

    const result = await generateImage(
      { prompt: 'test', aspectRatio: '1:1', seed: 1 },
      { maxBytes: 500, timeoutMs: 5000, execImpl: mockExec, fetchImpl: mockFetch, projectCache },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('asset_too_large')
      expect(result.charge).not.toBeNull()
    }
  })
})
