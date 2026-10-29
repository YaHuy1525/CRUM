import { describe, expect, it } from 'vitest'
import { classifyMatch } from '../../../src/prospects/merge'

const a = { name: 'Tradie Coach (Paul Rogers)', country: 'AU' as const }
const b = { name: 'Tech and Tradie Coach (Joel Hayward)', country: 'AU' as const }

describe('classifyMatch', () => {
  it('never merges the two different tradie coaches', () => {
    const verdict = classifyMatch(a, b)
    expect(verdict.kind).toBe('candidate')
    expect(verdict.kind === 'candidate' && verdict.reason).toBe('substring')
  })

  it('treats identical normalised names in the same country as a candidate not a duplicate', () => {
    const verdict = classifyMatch({ name: 'Kate Toon', country: 'AU' }, { name: 'kate  toon', country: 'AU' })
    expect(verdict.kind).toBe('candidate')
  })

  it('keeps same names in different countries apart', () => {
    expect(classifyMatch({ name: 'Kate Toon', country: 'AU' }, { name: 'Kate Toon', country: 'VN' }).kind).toBe('distinct')
  })

  it('keeps unrelated names apart', () => {
    expect(classifyMatch({ name: 'Jo Green Coaching', country: 'AU' }, { name: 'BusinessSight', country: 'AU' }).kind).toBe('distinct')
  })

  it('does not fire on a short token shared between names', () => {
    expect(classifyMatch({ name: 'Rask', country: 'AU' }, { name: 'Rask Media Group', country: 'AU' }).kind).toBe('candidate')
    expect(classifyMatch({ name: 'Coach', country: 'AU' }, { name: 'Coach Kate', country: 'AU' }).kind).toBe('distinct')
  })

  it('keeps people who only share a first name apart', () => {
    expect(classifyMatch({ name: 'Kate Toon', country: 'AU' }, { name: 'Kate Smith', country: 'AU' }).kind).toBe('distinct')
  })

  it('keeps names that only share the family name tokens apart', () => {
    expect(classifyMatch({ name: 'Nguyen Van A', country: 'VN' }, { name: 'Nguyen Van B', country: 'VN' }).kind).toBe('distinct')
  })
})
