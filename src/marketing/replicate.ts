// src/marketing/replicate.ts
// Slice 4's only provider. Two calls per image, create then poll, then a third
// to fetch the bytes before the delivery URL expires (spec section 5.2). Hand-
// written fetch like every other adapter in this repo: the official SDK is a
// browser library and this runs on a server.
//
// fetchImpl and sleep are injected on both lanes, which is what makes every test
// in this slice a mock. No automated test reaches Replicate.

export const REPLICATE_API_BASE = 'https://api.replicate.com/v1'
export const DEFAULT_REPLICATE_MODEL = 'black-forest-labs/flux-1.1-pro'

// The set FLUX 1.1 Pro actually takes, held as a constant rather than re-derived,
// and named in the designer's instructions so a plan written for a vertical story
// ad and an asset pass that refuses to render it cannot coexist (spec 5.1).
export const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

export const MAX_PROMPT_CHARS = 2000

// 20 attempts at 2 seconds is a 40 second ceiling per image. A hung request is
// not an option inside an agent turn.
const DEFAULT_POLL_ATTEMPTS = 20
const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_RATE_LIMIT_RETRY_MS = 5000

export type ImageFailureCode =
  | 'prompt_too_long'
  | 'unsupported_aspect_ratio'
  | 'image_generation_failed'
  | 'image_generation_timeout'
  | 'asset_too_large'

export interface ImageRequest {
  prompt: string
  aspectRatio: string
  seed: number
  // Accepted and never sent: FLUX 1.1 Pro has no negative prompt input, and an
  // unknown field is how an adapter starts returning 400s nobody predicted. The
  // caller stores it in documents.raw_extract for a future model that takes one.
  negativePrompt?: string | null
}

export interface ImageCharge {
  predictionId: string
  costUsd: string
  costMinor: number
}

export interface GeneratedImage extends ImageCharge {
  model: string
  aspectRatio: string
  mime: 'image/png'
  bytes: Uint8Array
  sizeBytes: number
}

export type ImageOutcome =
  | { ok: true; image: GeneratedImage }
  | {
      ok: false
      code: ImageFailureCode
      detail: string
      // Money already spent on a prediction that produced nothing usable. The
      // ledger records it; only a run that never asked for a prediction is null.
      charge: ImageCharge | null
      // True on a 401: the caller stops the whole loop rather than making forty
      // more calls against a dead token (spec section 9).
      deadToken: boolean
    }

export interface ReplicateConfig {
  apiToken: string
  model?: string
  // MAX_DOCUMENT_BYTES, passed in by the caller so this module does not import a
  // Mastra workflow file to learn how big a stored document may be.
  maxBytes: number
  fetchImpl?: typeof fetch
  pollAttempts?: number
  pollIntervalMs?: number
  rateLimitRetryMs?: number
  sleep?: (ms: number) => Promise<void>
}

export function isAspectRatio(value: string): boolean {
  return (ASPECT_RATIOS as readonly string[]).includes(value)
}

/**
 * Replicate reports `cost` as a decimal USD string. Minor units here are cents,
 * the same unit CRUM_IMAGE_SPEND_CEILING_MINOR is written in, so the ledger and
 * the ceiling are one number line. Rounded, not floored: a systematic floor
 * under-reads every image and the ceiling then quietly means less than it says.
 */
export function costUsdToMinor(costUsd: string): number {
  // `parseFloat` stops at a second dot, so "0.0.1" parses as 0 and would
  // otherwise enter the ledger as a free image. Shape first, then value.
  if (!/^\d+(\.\d+)?$/.test(costUsd)) {
    throw new Error(`cost: "${costUsd}" is not a dollar amount Replicate should have reported`)
  }
  const dollars = Number.parseFloat(costUsd)
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(`cost: "${costUsd}" is not a dollar amount Replicate should have reported`)
  }
  return Math.round(dollars * 100)
}

interface PredictionResponse {
  id?: string
  status?: string
  model?: string
  output?: string | string[] | null
  error?: string | null
  logs?: string
  cost?: string | number | null
  urls?: { get?: string }
}

function failure(
  code: ImageFailureCode,
  detail: string,
  charge: ImageCharge | null = null,
  deadToken = false,
): ImageOutcome {
  return { ok: false, code, detail, charge, deadToken }
}

function firstUrl(prediction: PredictionResponse): string | null {
  const output = prediction.output
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const first = output.find((entry) => typeof entry === 'string')
    return typeof first === 'string' ? first : null
  }
  return null
}

export async function generateImage(request: ImageRequest, config: ReplicateConfig): Promise<ImageOutcome> {
  const fetchImpl = config.fetchImpl ?? fetch
  const model = config.model ?? DEFAULT_REPLICATE_MODEL
  const attempts = config.pollAttempts ?? DEFAULT_POLL_ATTEMPTS
  const intervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const retryMs = config.rateLimitRetryMs ?? DEFAULT_RATE_LIMIT_RETRY_MS
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const headers = {
    Authorization: `Token ${config.apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  if (request.prompt.length > MAX_PROMPT_CHARS) {
    return failure(
      'prompt_too_long',
      `prompt is ${request.prompt.length} characters; Replicate truncates silently above ${MAX_PROMPT_CHARS} and a truncated prompt is a different image`,
    )
  }
  if (!isAspectRatio(request.aspectRatio)) {
    return failure('unsupported_aspect_ratio', `aspect ratio "${request.aspectRatio}" is not one of ${ASPECT_RATIOS.join(', ')}`)
  }

  // 1. Create. A 429 is retried once here and nowhere else, because the create
  // call is the only one that spends money; a retry on a poll is a free question.
  let created: Response
  try {
    created = await fetchImpl(`${REPLICATE_API_BASE}/predictions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: {
          prompt: request.prompt,
          aspect_ratio: request.aspectRatio,
          output_format: 'png',
          seed: request.seed,
        },
      }),
    })
  } catch (err) {
    return failure('image_generation_failed', `could not reach Replicate: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (created.status === 401) return failure('image_generation_failed', 'replicate rejected the api token (401)', null, true)
  if (created.status === 429) {
    await sleep(retryMs)
    created = await fetchImpl(`${REPLICATE_API_BASE}/predictions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: { prompt: request.prompt, aspect_ratio: request.aspectRatio, output_format: 'png', seed: request.seed },
      }),
    })
    if (created.status === 429) {
      return failure('image_generation_failed', 'replicate rate limited this asset after one retry (429)')
    }
  }
  if (!created.ok) {
    const text = await created.text().catch(() => '')
    return failure('image_generation_failed', `replicate refused the prediction (${created.status}) ${text.slice(0, 200)}`)
  }

  const start = (await created.json().catch(() => null)) as PredictionResponse | null
  const predictionId = start?.id
  if (!predictionId) return failure('image_generation_failed', 'replicate answered without a prediction id')

  // 2. Poll until succeeded, failed, or the budget runs out.
  let prediction: PredictionResponse | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const polled = await fetchImpl(`${REPLICATE_API_BASE}/predictions/${encodeURIComponent(predictionId)}`, {
      method: 'GET',
      headers,
    })
    if (polled.status === 401) {
      return failure('image_generation_failed', 'replicate revoked the token mid-run (401)', null, true)
    }
    prediction = polled.ok ? ((await polled.json().catch(() => null)) as PredictionResponse | null) : null
    if (prediction?.status === 'succeeded' || prediction?.status === 'failed') break
    if (attempt < attempts - 1) await sleep(intervalMs)
  }

  if (prediction?.status === 'failed') {
    return failure('image_generation_failed', prediction.error ? String(prediction.error) : 'replicate reported a failure with no error text')
  }
  if (prediction?.status !== 'succeeded') {
    return failure('image_generation_timeout', `prediction ${predictionId} was still ${prediction?.status ?? 'unreadable'} after ${attempts} polls`)
  }

  // 3. Cost first, then bytes. A response with no cost is refused rather than
  // estimated, because an estimated ledger is how a ceiling drifts from reality
  // without anyone noticing (spec section 5.4).
  const costUsd = typeof prediction.cost === 'string' || typeof prediction.cost === 'number' ? String(prediction.cost) : ''
  if (costUsd === '') {
    return failure('image_generation_failed', `prediction ${predictionId} reported no cost, and an unreported cost cannot go in the ledger`)
  }
  let costMinor: number
  try {
    costMinor = costUsdToMinor(costUsd)
  } catch (err) {
    return failure('image_generation_failed', err instanceof Error ? err.message : String(err))
  }
  const charge: ImageCharge = { predictionId, costUsd, costMinor }

  const url = firstUrl(prediction)
  if (url === null) {
    return failure('image_generation_failed', `prediction ${predictionId} succeeded with no output url`, charge)
  }

  let downloaded: Response
  try {
    downloaded = await fetchImpl(url)
  } catch (err) {
    return failure('image_generation_failed', `download of ${predictionId} output failed: ${err instanceof Error ? err.message : String(err)}`, charge)
  }
  if (!downloaded.ok) {
    return failure('image_generation_failed', `download of prediction ${predictionId} output failed (http ${downloaded.status})`, charge)
  }

  const buffer = await downloaded.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength > config.maxBytes) {
    return failure('asset_too_large', `${bytes.byteLength} bytes exceeds the ${config.maxBytes} byte document ceiling`, charge)
  }
  if (bytes.byteLength === 0) {
    return failure('image_generation_failed', `prediction ${predictionId} delivered zero bytes`, charge)
  }

  return {
    ok: true,
    image: {
      predictionId,
      costUsd,
      costMinor,
      model: prediction.model ?? model,
      aspectRatio: request.aspectRatio,
      mime: 'image/png',
      bytes,
      sizeBytes: bytes.byteLength,
    },
  }
}
