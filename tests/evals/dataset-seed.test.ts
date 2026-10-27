// tests/evals/dataset-seed.test.ts
import { describe, it, expect } from 'vitest'
import { getGoldenItems } from '../../src/evals/golden-items'

describe('golden dataset', () => {
  it('has exactly 40 items', () => {
    const items = getGoldenItems()
    expect(items).toHaveLength(40)
  })

  it('has 6 categories with correct counts', () => {
    const items = getGoldenItems()
    const counts = items.reduce(
      (acc, item) => {
        acc[item.category] = (acc[item.category] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )
    expect(counts['lookup']).toBe(8)
    expect(counts['filter']).toBe(8)
    expect(counts['write']).toBe(8)
    expect(counts['knowledge-answerable']).toBe(6)
    expect(counts['knowledge-unanswerable']).toBe(5)
    expect(counts['cross-tenant']).toBe(5)
  })

  it('every item has toolMocks array', () => {
    const items = getGoldenItems()
    for (const item of items) {
      expect(Array.isArray(item.toolMocks)).toBe(true)
    }
  })

  it('every item has groundTruth with answerable field', () => {
    const items = getGoldenItems()
    for (const item of items) {
      expect(typeof item.groundTruth.answerable).toBe('boolean')
    }
  })
})
