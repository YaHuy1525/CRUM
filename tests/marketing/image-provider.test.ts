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
