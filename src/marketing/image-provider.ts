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
 * The adapter also carries the five numbers that bound a run — the daily
 * ceiling, the per-bundle lifetime ceiling, the per-image estimate used for
 * admission, and the byte ceiling — so the tool never reads `process.env`
 * itself. `src/marketing/replicate.ts`'s file comment says the same thing
 * about its own config for the same reason.
 */
import { DEFAULT_REPLICATE_MODEL, generateImage as generateImageReplicate } from './replicate'
import type { ImageOutcome, ImageRequest } from './replicate'
import { DEFAULT_SUNRA_MODEL, generateImage as generateImageSunra, resolveSunraCli } from './sunra'
import type { SunraConfig } from './sunra'
import { REPLICATE_PROVIDER, SUNRA_PROVIDER } from './image-spend'

export interface ImageAdapter {
  provider: string
  model: string
  ceilingMinor: number
  // Lifetime per bundle, checked before the day ceiling. Spec section 7.2: the
  // bundle ceiling tells the owner to revise the creative, and the day ceiling
  // tells them to wait for midnight; the first is the more actionable answer
  // when both are true.
  bundleCeilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  generate(request: ImageRequest): Promise<ImageOutcome>
}

export interface ReplicateAdapterParams {
  apiToken: string
  model?: string
  ceilingMinor: number
  bundleCeilingMinor: number
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
    bundleCeilingMinor: params.bundleCeilingMinor,
    costMinorPerImage: params.costMinorPerImage,
    maxBytes: params.maxBytes,
    generate: (request) =>
      generateImageReplicate(request, {
        apiToken: params.apiToken,
        model,
        maxBytes: params.maxBytes,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      }),
  }
}

export interface SunraAdapterParams {
  model?: string
  ceilingMinor: number
  bundleCeilingMinor: number
  costMinorPerImage: number
  maxBytes: number
  timeoutMs?: number
  execImpl?: SunraConfig['execImpl']
  fetchImpl?: typeof fetch
}

export function makeSunraAdapter(params: SunraAdapterParams): ImageAdapter {
  const model = params.model ?? DEFAULT_SUNRA_MODEL

  // Fail fast: check CLI presence at adapter creation, not at first call.
  // If the CLI isn't on PATH, log a warning but still register — the generate
  // call will return a clear "sunra CLI is not installed" error.
  const cliPath = resolveSunraCli()
  if (!cliPath) {
    console.warn(
      `[CRUM] sunra CLI not found on PATH. The Sunra image adapter is registered but will fail at call time. Install sunra and run 'sunra login'.`,
    )
  }

  return {
    provider: SUNRA_PROVIDER,
    model,
    ceilingMinor: params.ceilingMinor,
    bundleCeilingMinor: params.bundleCeilingMinor,
    costMinorPerImage: params.costMinorPerImage,
    maxBytes: params.maxBytes,
    generate: (request) =>
      generateImageSunra(request, {
        model,
        maxBytes: params.maxBytes,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.execImpl ? { execImpl: params.execImpl } : {}),
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      }),
  }
}

/**
 * Providers by name, and exactly one of them selected.
 *
 * `createCrumMastra` runs per request in the Hono lane, so a registration is a
 * `Map.set` and re-setting the same name is expected rather than an error; that is
 * the property the single-slot `setImageAdapter` this replaced also had, and
 * `tests/marketing/image-provider.test.ts` keeps it tested rather than assumed.
 *
 * There is no fallback, and that is a requirement rather than a preference. A
 * provider that fails gets its own error, its own spend row, and no second provider
 * charged: CRUM does not make a purchase decision on the owner's behalf at runtime,
 * the same rule that makes `pageHostConfigFromEnv` refuse a half-configured host and
 * `blockedActions` refuse an action with no adapter. A retry chain would also make
 * the ceiling arithmetic a lie, because two providers failing one image would bill
 * one image twice.
 */
export const __imageProviderRegistry = new Map<string, ImageAdapter>()

export function registerImageAdapter(adapter: ImageAdapter): () => void {
  __imageProviderRegistry.set(adapter.provider, adapter)
  return () => {
    if (__imageProviderRegistry.get(adapter.provider) === adapter) __imageProviderRegistry.delete(adapter.provider)
  }
}

export function listImageProviders(): string[] {
  return [...__imageProviderRegistry.keys()]
}

// The selection lives here, not in the tool: `marketing.generate_assets` reads no
// `process.env` for run bounds (this file's header comment), and which provider this
// deployment pays is a run bound. `src/mastra/index.ts` sets it from `parseEnv` at
// boot, the same moment it registers the adapters.
let selection = 'replicate'

export function setSelectedImageProvider(name: string): void {
  selection = name
}

export function selectedImageProviderName(): string {
  return selection
}

/**
 * The selected adapter, or null when nothing answers that name. Null means two
 * different refusals, and the caller tells them apart with `listImageProviders()`:
 * an empty registry is an install with no credential, and a non-empty one is a
 * credential configured for a provider this build does not know.
 */
export function selectImageAdapter(): ImageAdapter | null {
  return __imageProviderRegistry.get(selection) ?? null
}
