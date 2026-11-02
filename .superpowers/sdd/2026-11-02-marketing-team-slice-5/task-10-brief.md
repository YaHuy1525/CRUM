### Task 10: A named image-provider registry, selected by config, with no fallback

Ruling A. One slot that the boot overwrites becomes a keyed registry, and nothing about a failure ever causes a second provider to be charged. The registry's job in this slice is to make adding a provider a registration and an env default instead of a refactor, which is spec section 8.2's stated non-goal of shipping a second one.

**Files:**
- Modify: `src/marketing/image-provider.ts:70-86` (the slot becomes the registry; note: plan cited `:62-78` but Task 9 pushed it down)
- Modify: `src/config/env.ts:204` (after `CRUM_REPLICATE_MODEL`; note: plan cited `:195` but earlier tasks pushed it down)
- Modify: `src/mastra/index.ts:42` (import), `:184-207` (registration block; note: plan cited `:186-207`)
- Modify: `src/mastra/tools/marketing-writes.ts:50` (import), `:1099` (the doc comment; note: plan cited `:1068`), `:1231` (the pick; note: plan cited `:1200-1207`)
- Test: `tests/marketing/image-provider.test.ts` (new), `tests/marketing/generate-assets-tool.test.ts:4-17` (harness) and `:46` (provider mock; note: plan cited `:14` and `:45`), `tests/mastra/marketing-boot.test.ts:122-142`, `tests/integration/marketing-generate-assets.test.ts:8,170,174,251,283,288` (note: plan cited `:169-173,250,282`)

**Interfaces:**
- Consumes: Task 9's `ImageAdapter` shape, unchanged by this task apart from the module that hands it out.
- Produces: `registerImageAdapter(adapter: ImageAdapter): () => void`, `selectImageAdapter(): ImageAdapter | null`, `listImageProviders(): string[]`, `selectedImageProviderName(): string`, `setSelectedImageProvider(name: string): void`, `__imageProviderRegistry`, and refusal token `image_provider_unknown`.

- [ ] **Step 1: Write the failing registry tests**

`tests/marketing/image-provider.test.ts`, new file:

```ts
// tests/marketing/image-provider.test.ts
// The registry is the answer to "which provider does this deployment pay, and what
// happens when it fails". Selection by name and no fallback are the two rules, so
// this file tests exactly those and leaves the Replicate HTTP half to
// tests/marketing/replicate.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import {
  __imageProviderRegistry,
  listImageProviders,
  registerImageAdapter,
  selectImageAdapter,
  selectedImageProviderName,
  setSelectedImageProvider,
  type ImageAdapter,
} from '@/marketing/image-provider'

function fake(provider: string): ImageAdapter {
  return {
    provider,
    model: `${provider}/test`,
    ceilingMinor: 2000,
    bundleCeilingMinor: 200,
    costMinorPerImage: 4,
    maxBytes: 1024,
    generate: () => Promise.reject(new Error('never called: this file tests selection, not generation')),
  }
}

afterEach(() => {
  __imageProviderRegistry.clear()
  setSelectedImageProvider('replicate')
})

describe('the image provider registry', () => {
  it('keys by the adapter name it registers, and hands back an unregister', () => {
    const off = registerImageAdapter(fake('replicate'))
    expect(listImageProviders()).toEqual(['replicate'])
    off()
    expect(listImageProviders()).toEqual([])
  })

  it('selects the one the config names, from among several', () => {
    registerImageAdapter(fake('replicate'))
    registerImageAdapter(fake('openai'))
    setSelectedImageProvider('openai')
    expect(selectImageAdapter()?.provider).toBe('openai')
    expect(listImageProviders()).toEqual(['replicate', 'openai'])
  })

  it('answers null for a name nothing registers, and keeps the other adapter in the registry', () => {
    registerImageAdapter(fake('replicate'))
    setSelectedImageProvider('stability')
    expect(selectImageAdapter()).toBeNull()
    expect(listImageProviders()).toEqual(['replicate'])
  })

  it('defaults to replicate when nothing chose', () => {
    expect(selectedImageProviderName()).toBe('replicate')
  })

  it('overwrites one provider with a second adapter of the same name, because boot runs per request', () => {
    registerImageAdapter(fake('replicate'))
    registerImageAdapter({ ...fake('replicate'), model: 'replicate/second' })
    expect(listImageProviders()).toEqual(['replicate'])
    expect(selectImageAdapter()?.model).toBe('replicate/second')
  })
})
```

The last case is the slice-4 constraint the old comment at `:62-69` recorded (`createCrumMastra` runs per request, so a registration that refused a second write would throw on every request after the first). A `Map.set` keeps that property and the test keeps the comment honest.

- [ ] **Step 2: Write the failing tool tests**

In `tests/marketing/generate-assets-tool.test.ts`, swap the provider mock's shape (`:46`; note: plan cited `:45`) and the harness object (`:4-17`; note: plan cited `:14`), then add:

```ts
vi.mock('../../src/marketing/image-provider', () => ({
  selectImageAdapter: h.selectImageAdapter,
  listImageProviders: h.listImageProviders,
  selectedImageProviderName: h.selectedImageProviderName,
}))
```

```ts
  h.selectImageAdapter.mockReturnValue(null)
  h.listImageProviders.mockReturnValue([])
  h.selectedImageProviderName.mockReturnValue('replicate')
```

```ts
it('refuses with image_provider_not_configured when the registry is empty, which is an absent token', async () => {
  const result = await run({ bundleId: BUNDLE })
  expect(result.refused[0]!.code).toBe('image_provider_not_configured')
  expect(h.generate).not.toHaveBeenCalled()
})

it('refuses with image_provider_unknown when the config names something nothing registered', async () => {
  h.selectImageAdapter.mockReturnValue(null)
  h.listImageProviders.mockReturnValue(['replicate'])
  h.selectedImageProviderName.mockReturnValue('stability')
  const result = await run({ bundleId: BUNDLE })
  expect(result.refused[0]!.code).toBe('image_provider_unknown')
  expect(String(result.refused[0]!.detail)).toContain('stability')
  expect(String(result.refused[0]!.detail)).toContain('replicate')
  expect(h.generate).not.toHaveBeenCalled()
})

it('never charges a second provider for a picture the first one failed to make', async () => {
  // The ruling (option A) in test form: one adapter registered, one failure with a
  // charge, and the run reports the charge with no second attempt. A fallback would
  // make the ceiling arithmetic a lie, because two providers failing one image
  // bill one image twice.
  h.generate.mockResolvedValueOnce(chargedFailure('replicate_down', 4))
  const result = await run({ bundleId: BUNDLE })
  expect(h.generate).toHaveBeenCalledTimes(1)
  expect(h.recordImageSpend).toHaveBeenCalledTimes(1)
  expect(result.refused[0]!.code).toBe('replicate_down')
  expect(result.spentMinor).toBe(4)
})
```

`chargedFailure(code, costMinor)` builds the `ImageOutcome` shape `{ ok: false, code, detail, charge: { predictionId, costUsd, costMinor }, deadToken: false }`; the file already has a helper of that shape for the slice-4 failure cases, and if it is named differently, reuse it rather than adding a twin.

- [ ] **Step 3: Implement the registry**

Replace `src/marketing/image-provider.ts:70-86` (the `current` slot and the `setImageAdapter`/`getImageAdapter` functions):

```ts
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
```

`setImageAdapter` and `getImageAdapter` are deleted, not deprecated: the four call sites that exist (`src/mastra/index.ts`, `src/mastra/tools/marketing-writes.ts`, `tests/mastra/marketing-boot.test.ts`, `tests/integration/marketing-generate-assets.test.ts`) are all in this task, and a retained alias would be a second door to "last write wins whatever the config says".

- [ ] **Step 4: Config, boot, and the tool's pick**

`src/config/env.ts` after `CRUM_REPLICATE_MODEL` (`:201-204`; note: plan cited `:192-195`):

```ts
  // Which registered provider this deployment pays. One name, because a fallback
  // would make the ceiling arithmetic a lie (spec section 8.1). The value is not
  // validated against a list here: the registry is built at boot, and
  // marketing.generate_assets refuses an unknown name with `image_provider_unknown`
  // naming what *is* registered, which is a better message than a boot failure on a
  // spelling.
  CRUM_IMAGE_PROVIDER: z.preprocess(blankAsUnset, z.string().trim().min(1).default('replicate')),
```

`src/mastra/index.ts:184-207` keeps its condition and gains the selection, in this order (note: plan cited `:186-207`):

```ts
  const imageToken = env.CRUM_REPLICATE_API_TOKEN
  setSelectedImageProvider(env.CRUM_IMAGE_PROVIDER)
  if (imageToken) {
    registerImageAdapter(
      makeReplicateAdapter({
        apiToken: imageToken,
        model: env.CRUM_REPLICATE_MODEL,
        ceilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR,
        bundleCeilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE,
        costMinorPerImage: env.CRUM_IMAGE_COST_MINOR_PER_IMAGE,
        maxBytes: MAX_DOCUMENT_BYTES,
      }),
    )
    logImageLaneOnce(env.CRUM_IMAGE_PROVIDER)
  } else {
    // Nothing to unregister: an install without a credential has no adapter, and
    // selectImageAdapter() answers null for that reason rather than for a spelling.
    logImageLaneOnce('none')
  }
```

The `setImageAdapter(null)` line at `:205` disappears, and with it the comment block above it (`:184-188`) that explains why the null assignment exists. Replace that comment with one that says the registry starts empty and the selection is set whether or not a credential is present, because the refusal message names the selected provider.

`tests/mastra/marketing-boot.test.ts:122-142` moves from `getImageAdapter()` to `selectImageAdapter()` and its assertion at `:124` (`null` with no token) stays; `logImageLaneOnce` is the one line the file may also assert on. `tests/integration/marketing-generate-assets.test.ts:8,170,174,251,283,288` moves from `setImageAdapter(x)` / `setImageAdapter(null)` to `registerImageAdapter(x)` / `__imageProviderRegistry.clear()`.

`src/mastra/tools/marketing-writes.ts:1231` becomes (note: plan cited `:1200-1207`):

```ts
      const adapter = refused.length === 0 ? selectImageAdapter() : null
      if (refused.length === 0 && adapter === null) {
        const registered = listImageProviders()
        refused.push({
          name: '*',
          code: registered.length === 0 ? 'image_provider_not_configured' : 'image_provider_unknown',
          detail:
            registered.length === 0
              ? 'No image adapter is registered, so this install has no provider credential. Nothing was requested and nothing was spent.'
              : `CRUM_IMAGE_PROVIDER is "${selectedImageProviderName()}", which no adapter answers. Registered: ${registered.join(', ')}. Nothing was requested and nothing was spent.`,
        })
      }
```

The `image_provider_not_configured` sentence drops its reference to `CRUM_REPLICATE_API_TOKEN`, because with a registry that variable is one provider's credential rather than the whole question; name the file's own env key in the comment if the sentence needs a pointer. The doc comment at `:1099` that names `getImageAdapter()` is reworded to `selectImageAdapter()` (note: plan cited `:1068`).

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/image-provider.test.ts tests/marketing/generate-assets-tool.test.ts tests/mastra/marketing-boot.test.ts
npx vitest run tests/integration/marketing-generate-assets.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. Then prove to yourself that nothing still calls the deleted functions:

```bash
cd D:/Code/CRUM
grep -rn "getImageAdapter\|setImageAdapter" src tests scripts | grep -v "^src/marketing/image-provider.ts"
```

Expected: no output. Anything left is a fifth call site this task did not know about; convert it and say so in your report.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/marketing/image-provider.ts src/config/env.ts src/mastra/index.ts src/mastra/tools/marketing-writes.ts tests/marketing/image-provider.test.ts tests/marketing/generate-assets-tool.test.ts tests/mastra/marketing-boot.test.ts tests/integration/marketing-generate-assets.test.ts
git commit -m "feat(marketing): image providers become a named registry with no fallback"
```

---
