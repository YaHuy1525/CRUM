// src/marketing/sunra.ts
// Sunra CLI adapter for image generation. Shells out to `sunra call create_image`
// with --yes to spend credits, parses the JSON output, extracts the result URL,
// and downloads the bytes. The CLI handles authentication locally via `sunra login`.
//
// Unlike Replicate, Sunra reports cost in credits (integer), not USD. The ledger
// stores costMinor in cents, so 1 credit maps to 1 cent for accounting purposes.
// costUsd is derived as credits/100 to keep the ledger format consistent.
//
// Sunra requires a project_id for every generation. The adapter creates a project
// on first use (or when the cached id is missing) and reuses it for subsequent calls.

import { execFile, execSync } from 'node:child_process'
import { MAX_PROMPT_CHARS } from './replicate'
import type { ImageCharge, ImageFailureCode, ImageOutcome, ImageRequest } from './replicate'

export const DEFAULT_SUNRA_MODEL = 'gpt-image-2'

/**
 * Check whether the `sunra` CLI is on PATH. Returns the resolved path, or null
 * if not found. Used at adapter registration time to fail fast rather than
 * discovering a missing CLI on the first image generation call.
 */
export function resolveSunraCli(): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const result = execSync(`${which} sunra`, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
    const path = result.trim().split(/\r?\n/)[0]
    return path || null
  } catch {
    return null
  }
}

// Sunra's supported aspect ratios vary by model. gpt-image-2 supports these seven.
// The adapter validates against this set rather than Replicate's, since sending an
// unsupported ratio to Sunra would fail the generation and spend credits for nothing.
const SUNRA_ASPECT_RATIOS = ['3:2', '1:1', '2:3', '16:9', '9:16', '4:3', '3:4']

// 90 seconds per image generation. Sunra CLI handles the polling internally when
// auto_confirm is true, so this is a wall-clock timeout on the whole call.
const DEFAULT_TIMEOUT_MS = 90_000

// Project name used for all CRUM image generations. Sunra projects are lightweight
// containers; CRUM tracks bundles separately in its own database.
const CRUM_PROJECT_NAME = 'crum-marketing'

// Per-adapter project cache. Injected via SunraConfig so tests get a fresh instance
// and production shares one cache across calls within a process.
export interface SunraProjectCache {
  projectId: string | null
}

export function createSunraProjectCache(): SunraProjectCache {
  return { projectId: null }
}

// Default process-wide cache, used when no cache is injected.
const defaultProjectCache = createSunraProjectCache()

export interface SunraConfig {
  model?: string
  maxBytes: number
  timeoutMs?: number
  // Injected for testing. Defaults to node:child_process.execFile.
  execImpl?: typeof execFile
  fetchImpl?: typeof fetch
  // Project id cache. Defaults to a process-wide singleton. Inject a fresh cache
  // in tests to isolate project creation between cases.
  projectCache?: SunraProjectCache
}

export interface SunraCallResult {
  structuredContent?: Record<string, unknown>
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

function failure(
  code: ImageFailureCode,
  detail: string,
  charge: ImageCharge | null = null,
  deadToken = false,
): ImageOutcome {
  return { ok: false, code, detail, charge, deadToken }
}

export function isSunraAspectRatio(value: string): boolean {
  return SUNRA_ASPECT_RATIOS.includes(value)
}

export { SUNRA_ASPECT_RATIOS }

/**
 * Map Sunra's integer credits to the ledger's costMinor (cents) and costUsd string.
 * 1 credit = 1 cent. The ledger format requires both fields, so costUsd is derived.
 */
export function creditsToCharge(credits: number, predictionId: string): ImageCharge {
  const costMinor = credits
  const costUsd = (credits / 100).toFixed(2)
  return { predictionId, costUsd, costMinor }
}

export function extractUrls(data: unknown): string[] {
  const urls: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('http')) {
      const lower = value.toLowerCase()
      if (/\.(png|jpg|jpeg|webp)(\?|$)/.test(lower) || /image/.test(lower)) {
        urls.push(value)
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item)
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v)
    }
  }
  walk(data)
  // Deduplicate while preserving order
  return [...new Set(urls)]
}

export function extractCredits(data: unknown): number {
  const find = (value: unknown, names: Set<string>): unknown => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item, names)
        if (found !== undefined) return found
      }
    } else if (value && typeof value === 'object') {
      for (const [key, val] of Object.entries(value)) {
        if (names.has(key) && typeof val === 'number' && val >= 0) return val
        const found = find(val, names)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  const result = find(data, new Set(['credits', 'total_credits', 'estimated_credits', 'cost']))
  return typeof result === 'number' ? result : 0
}

function runSunraCli(
  args: string[],
  execImpl: typeof execFile,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execImpl('sunra', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && 'killed' in err && err.killed) {
        resolve({ stdout: stdout ?? '', stderr: 'sunra command timed out', code: -1 })
        return
      }
      const code = err && 'code' in err ? (err.code as number) ?? 1 : 0
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
    })
  })
}

function parseJsonOutput(text: string): SunraCallResult | null {
  try {
    const parsed = JSON.parse(text) as SunraCallResult
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch {
    // Not JSON, return null
  }
  return null
}

function extractProjectId(data: SunraCallResult): string | null {
  const structured = data.structuredContent
  if (structured && typeof structured.project_id === 'string') {
    return structured.project_id
  }
  // Fall back to parsing the content array text field
  if (Array.isArray(data.content)) {
    for (const item of data.content) {
      if (item.type === 'text' && item.text) {
        try {
          const inner = JSON.parse(item.text) as Record<string, unknown>
          if (typeof inner.project_id === 'string') {
            return inner.project_id
          }
        } catch {
          // Not JSON, continue
        }
      }
    }
  }
  return null
}

export function extractNodeIds(data: SunraCallResult): string[] {
  const structured = data.structuredContent
  if (structured && Array.isArray(structured.node_ids)) {
    return structured.node_ids.filter((id): id is string => typeof id === 'string')
  }
  if (Array.isArray(data.content)) {
    for (const item of data.content) {
      if (item.type === 'text' && item.text) {
        try {
          const inner = JSON.parse(item.text) as Record<string, unknown>
          if (Array.isArray(inner.node_ids)) {
            return inner.node_ids.filter((id): id is string => typeof id === 'string')
          }
        } catch {
          // Not JSON, continue
        }
      }
    }
  }
  return []
}

// Maximum number of poll attempts. The total timeout is divided across attempts,
// so each poll gets timeoutMs / MAX_POLL_ATTEMPTS. With the 90s default and 3
// attempts, each poll gets 30s — enough for the CLI's 55s server-side cap while
// keeping the total wall-clock bounded.
const MAX_POLL_ATTEMPTS = 3

async function pollForCompletion(
  projectId: string,
  nodeIds: string[],
  execImpl: typeof execFile,
  timeoutMs: number,
): Promise<{ urls: string[]; credits: number; error: string | null }> {
  let pendingNodeIds = [...nodeIds]
  const perPollTimeoutMs = Math.floor(timeoutMs / MAX_POLL_ATTEMPTS)
  // The CLI's server-side wait is capped at 55s; use the smaller of per-poll
  // budget and 55s so the process timeout and the server timeout agree.
  const perPollTimeoutSec = Math.min(Math.floor(perPollTimeoutMs / 1000), 55)

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const result = await runSunraCli(
      [
        'call',
        'wait_for_nodes',
        JSON.stringify({
          project_id: projectId,
          node_ids: pendingNodeIds,
          timeout_s: perPollTimeoutSec,
        }),
        '--json',
      ],
      execImpl,
      perPollTimeoutMs,
    )

    if (result.code !== 0) {
      return { urls: [], credits: 0, error: `sunra wait_for_nodes failed: ${result.stderr || result.stdout}`.slice(0, 400) }
    }

    const parsed = parseJsonOutput(result.stdout)
    if (!parsed) {
      return { urls: [], credits: 0, error: 'sunra wait_for_nodes output was not valid JSON' }
    }

    if (parsed.isError) {
      return { urls: [], credits: 0, error: `sunra wait_for_nodes returned error: ${JSON.stringify(parsed).slice(0, 400)}` }
    }

    const structured = parsed.structuredContent ?? {}
    const urls = extractUrls(parsed)
    const credits = extractCredits(parsed)

    if (urls.length > 0) {
      return { urls, credits, error: null }
    }

    // Check if still running or failed
    const stillRunning = structured.still_running === true
    const failed = structured.failed === true

    if (failed) {
      return { urls: [], credits, error: 'sunra generation failed' }
    }

    if (!stillRunning) {
      // Not running and no URLs — something unexpected
      return { urls: [], credits, error: 'sunra generation ended without producing URLs' }
    }

    // Still running — update pending nodes for next poll
    const stillPending = structured.pending_node_ids
    if (Array.isArray(stillPending)) {
      pendingNodeIds = stillPending.filter((id): id is string => typeof id === 'string')
    }

    if (pendingNodeIds.length === 0) {
      return { urls: [], credits, error: 'sunra reported no pending nodes but no URLs either' }
    }
  }

  return { urls: [], credits: 0, error: `sunra generation timed out after ${MAX_POLL_ATTEMPTS} poll attempts` }
}

async function ensureProjectId(
  execImpl: typeof execFile,
  timeoutMs: number,
  cache: SunraProjectCache,
): Promise<{ projectId: string | null; error: string | null }> {
  if (cache.projectId) {
    return { projectId: cache.projectId, error: null }
  }

  const result = await runSunraCli(
    ['call', 'create_project', JSON.stringify({ name: CRUM_PROJECT_NAME }), '--json'],
    execImpl,
    timeoutMs,
  )

  if (result.code !== 0) {
    return { projectId: null, error: `sunra create_project failed: ${result.stderr || result.stdout}`.slice(0, 400) }
  }

  const parsed = parseJsonOutput(result.stdout)
  if (!parsed) {
    return { projectId: null, error: 'sunra create_project output was not valid JSON' }
  }

  if (parsed.isError) {
    return { projectId: null, error: `sunra create_project returned error: ${JSON.stringify(parsed).slice(0, 400)}` }
  }

  const projectId = extractProjectId(parsed)
  if (!projectId) {
    return { projectId: null, error: 'sunra create_project returned no project_id' }
  }

  cache.projectId = projectId
  return { projectId, error: null }
}

export async function generateImage(request: ImageRequest, config: SunraConfig): Promise<ImageOutcome> {
  const execImpl = config.execImpl ?? execFile
  const fetchImpl = config.fetchImpl ?? fetch
  const model = config.model ?? DEFAULT_SUNRA_MODEL
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const projectCache = config.projectCache ?? defaultProjectCache

  if (request.prompt.length > MAX_PROMPT_CHARS) {
    return failure(
      'prompt_too_long',
      `prompt is ${request.prompt.length} characters; max is ${MAX_PROMPT_CHARS}`,
    )
  }

  // Sunra models have varying aspect ratio support. gpt-image-2 supports 7 ratios.
  // 'auto' is not a Sunra concept, so map it to 1:1 as a sensible default.
  let aspectRatio = request.aspectRatio
  if (aspectRatio === 'auto') {
    aspectRatio = '1:1'
  }
  if (!isSunraAspectRatio(aspectRatio)) {
    return failure(
      'unsupported_aspect_ratio',
      `aspect ratio "${request.aspectRatio}" is not supported by Sunra model ${model}. Supported: ${SUNRA_ASPECT_RATIOS.join(', ')}`,
    )
  }

  // Ensure we have a project id before calling create_image
  const project = await ensureProjectId(execImpl, timeoutMs, projectCache)
  if (project.error) {
    return failure('image_generation_failed', project.error)
  }
  const projectId = project.projectId!

  const callArgs = [
    'call',
    'create_image',
    JSON.stringify({
      project_id: projectId,
      prompt: request.prompt,
      model,
      aspect_ratio: aspectRatio,
      auto_confirm: true,
    }),
    '--json',
    '--yes',
  ]

  const result = await runSunraCli(callArgs, execImpl, timeoutMs)

  if (result.code === -1) {
    return failure('image_generation_timeout', `sunra command timed out after ${timeoutMs}ms`)
  }

  if (result.code !== 0) {
    // Exit code 5 means spend not confirmed, but we pass --yes, so this shouldn't happen.
    // Other codes indicate CLI errors.
    const detail = result.stderr || result.stdout || `exit code ${result.code}`
    // Check for auth errors
    if (/not signed in|authentication|login/i.test(detail)) {
      return failure('image_generation_failed', `Sunra CLI not authenticated. Run 'sunra login' first.`, null, true)
    }
    return failure('image_generation_failed', `sunra create_image failed: ${detail.slice(0, 400)}`)
  }

  const parsed = parseJsonOutput(result.stdout)
  if (!parsed) {
    return failure('image_generation_failed', 'sunra output was not valid JSON')
  }

  if (parsed.isError) {
    return failure('image_generation_failed', `sunra returned error: ${JSON.stringify(parsed).slice(0, 400)}`)
  }

  // Extract the structured content or fall back to parsing the content array
  const credits = extractCredits(parsed)

  // create_image returns immediately with node_ids. Poll wait_for_nodes until
  // the image is ready or we time out.
  const nodeIds = extractNodeIds(parsed)
  if (nodeIds.length === 0) {
    // No node_ids means either the image is already done (URLs inline) or something
    // unexpected happened. Check for inline URLs first.
    const urls = extractUrls(parsed)
    if (urls.length > 0) {
      return finalizeImage(urls, credits, fetchImpl, config.maxBytes, model, aspectRatio)
    }
    return failure('image_generation_failed', 'sunra returned no node_ids to poll')
  }

  const pollResult = await pollForCompletion(projectId, nodeIds, execImpl, timeoutMs)
  if (pollResult.error) {
    const charge = credits > 0 ? creditsToCharge(credits, `sunra-${Date.now()}`) : null
    return failure('image_generation_timeout', pollResult.error, charge)
  }

  const finalCredits = pollResult.credits > 0 ? pollResult.credits : credits
  return finalizeImage(pollResult.urls, finalCredits, fetchImpl, config.maxBytes, model, aspectRatio)
}

async function finalizeImage(
  urls: string[],
  credits: number,
  fetchImpl: typeof fetch,
  maxBytes: number,
  model: string,
  aspectRatio: string,
): Promise<ImageOutcome> {
  if (urls.length === 0) {
    return failure('image_generation_failed', 'sunra returned no image URL')
  }

  const imageUrl = urls[0]!
  const predictionId = `sunra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const charge = credits > 0 ? creditsToCharge(credits, predictionId) : null

  // Download the image bytes
  let downloaded: Response
  try {
    downloaded = await fetchImpl(imageUrl)
  } catch (err) {
    return failure(
      'image_generation_failed',
      `download of sunra image failed: ${err instanceof Error ? err.message : String(err)}`,
      charge,
    )
  }

  if (!downloaded.ok) {
    return failure(
      'image_generation_failed',
      `download of sunra image failed (http ${downloaded.status})`,
      charge,
    )
  }

  let buffer: ArrayBuffer
  try {
    buffer = await downloaded.arrayBuffer()
  } catch (err) {
    return failure(
      'image_generation_failed',
      `download of sunra image failed mid-body: ${err instanceof Error ? err.message : String(err)}`,
      charge,
    )
  }

  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength > maxBytes) {
    return failure(
      'asset_too_large',
      `${bytes.byteLength} bytes exceeds the ${maxBytes} byte document ceiling`,
      charge,
    )
  }
  if (bytes.byteLength === 0) {
    return failure('image_generation_failed', 'sunra delivered zero bytes', charge)
  }

  // If we had no credits from the response, use the admission estimate
  const finalCharge: ImageCharge = charge ?? { predictionId, costUsd: '0.00', costMinor: 0 }

  return {
    ok: true,
    image: {
      predictionId,
      costUsd: finalCharge.costUsd,
      costMinor: finalCharge.costMinor,
      model,
      aspectRatio,
      mime: 'image/png',
      bytes,
      sizeBytes: bytes.byteLength,
    },
  }
}
