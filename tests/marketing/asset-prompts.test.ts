// tests/marketing/asset-prompts.test.ts
import { describe, expect, it } from 'vitest'
import { parseAssetPrompts } from '../../src/marketing/asset-prompts'

const HERO = {
  name: 'hero-image',
  prompt: 'a physio clinic reception at dawn, warm light, no text',
  aspectRatio: '16:9',
  negativePrompt: 'watermark',
}

describe('parseAssetPrompts', () => {
  it('reads the contract shape the designer instruction promises', () => {
    const parsed = parseAssetPrompts(JSON.stringify({ assets: [HERO] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.prompts).toEqual([
      { name: 'hero-image', prompt: HERO.prompt, aspectRatio: '16:9', negativePrompt: 'watermark' },
    ])
  })

  it('says no_asset_prompts when there is no stored text at all', () => {
    expect(parseAssetPrompts(null)).toMatchObject({ ok: false, reason: 'no_asset_prompts' })
    expect(parseAssetPrompts('')).toMatchObject({ ok: false, reason: 'no_asset_prompts' })
    expect(parseAssetPrompts('   ')).toMatchObject({ ok: false, reason: 'no_asset_prompts' })
  })

  it('says asset_prompts_unparsable for prose, which is the case spec 6 step 2 names', () => {
    const parsed = parseAssetPrompts('Make it look friendly and modern, maybe a reception desk.')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('asset_prompts_unparsable')
    expect(parsed.detail).toContain('not JSON')
  })

  it('says asset_prompts_unparsable for JSON with no assets array, or an empty one', () => {
    expect(parseAssetPrompts(JSON.stringify({ mood: 'calm' }))).toMatchObject({
      reason: 'asset_prompts_unparsable',
    })
    expect(parseAssetPrompts(JSON.stringify({ assets: [] }))).toMatchObject({
      reason: 'asset_prompts_unparsable',
    })
  })

  it('refuses the whole set when one entry has no prompt, rather than paying for the others', () => {
    const parsed = parseAssetPrompts(JSON.stringify({ assets: [HERO, { name: 'b-roll' }] }))
    expect(parsed).toMatchObject({ ok: false, reason: 'asset_prompts_unparsable' })
    if (parsed.ok) return
    expect(parsed.detail).toContain('b-roll')
  })

  it('defaults a missing aspect ratio to auto and a missing name to its position', () => {
    const parsed = parseAssetPrompts(JSON.stringify({ assets: [{ prompt: 'a clinic hallway' }] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.prompts[0]).toEqual({
      name: 'asset-1',
      prompt: 'a clinic hallway',
      aspectRatio: 'auto',
      negativePrompt: null,
    })
  })

  it('keeps the order the designer wrote, because the loop pays in that order', () => {
    const parsed = parseAssetPrompts(
      JSON.stringify({ assets: [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }] }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.prompts.map((p) => p.name)).toEqual(['asset-1', 'asset-2', 'asset-3'])
  })
})
