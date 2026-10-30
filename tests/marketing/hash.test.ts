import { describe, expect, it } from 'vitest'
import {
  artifactIdFor,
  canonicalJson,
  computeBundleHash,
  uuidFromSeed,
  type BundleHashInput,
} from '@/marketing/hash'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function columns(over: Partial<BundleHashInput> = {}): BundleHashInput {
  return {
    brief: 'Book more physio assessments in Melbourne',
    objective: 'outreach_support',
    audienceNote: 'owner-led clinics, 2-8 staff',
    strategy: { position: 'the only clinic that answers within an hour' },
    copy: { hooks: ['Your next patient is already searching'], dm: 'Hi' },
    mediaPlan: null,
    funnelPlan: null,
    analysis: null,
    promptVersion: 'marketing-v1',
    ...over,
  }
}

describe('canonicalJson', () => {
  it('sorts object keys so an equal value hashes the same', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('keeps array order, because copy order is meaning', () => {
    expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']))
  })

  it('drops undefined members instead of printing null for them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('computeBundleHash', () => {
  it('is stable across key order in a role column', () => {
    const a = computeBundleHash(columns({ strategy: { x: 1, y: 2 } }))
    const b = computeBundleHash(columns({ strategy: { y: 2, x: 1 } }))
    expect(a).toBe(b)
  })

  it('changes when one word of copy changes', () => {
    const before = computeBundleHash(columns())
    const after = computeBundleHash(
      columns({ copy: { hooks: ['Your next patient is already Googling'], dm: 'Hi' } }),
    )
    expect(before).not.toBe(after)
  })

  it('ignores a status change, which is lifecycle not content', () => {
    expect(computeBundleHash(columns())).toHaveLength(64)
  })
})

describe('uuidFromSeed', () => {
  it('produces a version 8 UUID with the RFC variant', () => {
    expect(uuidFromSeed('a:b:c')).toMatch(UUID_SHAPE)
  })

  it('is deterministic', () => {
    expect(uuidFromSeed('tenant/bundle/role/kind/body')).toBe(
      uuidFromSeed('tenant/bundle/role/kind/body'),
    )
  })
})

describe('artifactIdFor', () => {
  it('gives the same content the same id', () => {
    const base = { tenantId: 't', bundleId: 'b', role: 'marketer-copywriter', kind: 'script' }
    expect(artifactIdFor({ ...base, content: 'Say the price out loud' })).toBe(
      artifactIdFor({ ...base, content: 'Say the price out loud' }),
    )
  })

  it('gives different bundles different ids for the same content', () => {
    const base = { tenantId: 't', role: 'marketer-copywriter', kind: 'script', content: 'x' }
    expect(artifactIdFor({ ...base, bundleId: 'b1' })).not.toBe(artifactIdFor({ ...base, bundleId: 'b2' }))
  })
})
