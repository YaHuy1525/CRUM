// src/marketing/image-provider.ts
/**
 * The one place the marketing tools learn which image provider exists.
 *
 * `src/marketing/replicate.ts` knows how to talk to Replicate. It does not know
 * whether this deployment pays for one, and a tool that imported it directly
 * would make "no token configured" a module-load problem rather than a runtime
 * refusal. This module holds the registration slot, and `src/mastra/index.ts`
 * fills it at boot only when `CRUM_REPLICATE_API_TOKEN` is present, which is the
 * same conditional registration slice 2 built for the Cloudflare adapter and
 * slice 3 for the Meta adapters: an action cannot be taken until it can be
 * executed.
 *
 * The adapter also carries the four numbers that bound a run — the daily
 * ceiling, the per-image estimate used for admission, and the byte ceiling — so
 * the tool never reads `process.env` itself. `src/marketing/replicate.ts`'s file
 * comment says the same thing about its own config for the same reason.
 */
import { DEFAULT_REPLICATE_MODEL, generateImage } from './replicate'
import type { ImageOutcome, ImageRequest } from './replicate'
import { REPLICATE_PROVIDER } from './image-spend'

export interface ImageAdapter {
  provider: string
  model: string
  ceilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  generate(request: ImageRequest): Promise<ImageOutcome>
}

export interface ReplicateAdapterParams {
  apiToken: string
  model?: string
  ceilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  fetchImpl?: typeof fetch
}

export function makeReplicateAdapter(params: ReplicateAdapterParams): ImageAdapter {
  const model = params.model ?? DEFAULT_REPLICATE_MODEL
  return {
    // The constant, not a fresh literal: `src/marketing/image-spend.ts:9` already
    // spells this string and writes it into every ledger row, and two copies of a
    // provider name is how a report ends up counting one provider as two.
    provider: REPLICATE_PROVIDER,
    model,
    ceilingMinor: params.ceilingMinor,
    costMinorPerImage: params.costMinorPerImage,
    maxBytes: params.maxBytes,
    generate: (request) =>
      generateImage(request, {
        apiToken: params.apiToken,
        model,
        maxBytes: params.maxBytes,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      }),
  }
}

/**
 * One adapter per process, last write wins.
 *
 * `createCrumMastra` runs per request in the Hono lane (slice 2's conditional
 * adapter registration hit exactly this), so a registration that refused a
 * second write would throw on the second request of every day. An overwrite is
 * safe because the only inputs are the same environment variables.
 */
let current: ImageAdapter | null = null

export function setImageAdapter(adapter: ImageAdapter | null): void {
  current = adapter
}

export function getImageAdapter(): ImageAdapter | null {
  return current
}
