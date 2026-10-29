import { describe, expect, it } from 'vitest'
import { classifyMatch } from '../../../src/prospects/merge'

const au = (name: string) => ({ name, country: 'AU' as const })
const vn = (name: string) => ({ name, country: 'VN' as const })

describe('classifyMatch', () => {
  it('ignores parenthetical owner names so the two tradie coaches collide', () => {
    const verdict = classifyMatch(au('Tradie Coach (Paul Rogers)'), au('Tech and Tradie Coach (Joel Hayward)'))
    expect(verdict.kind).toBe('candidate')
    expect(verdict.kind === 'candidate' && verdict.reason).toBe('substring')
  })

  it('matches a name against the longer name that contains it', () => {
    expect(classifyMatch(au('Rask'), au('Rask Media Group')).kind).toBe('candidate')
    expect(classifyMatch(au('Jo'), au('Jo Green')).kind).toBe('candidate')
  })

  it('treats identical normalised names as a candidate not a duplicate', () => {
    const verdict = classifyMatch(au('Kate Toon'), au('kate  toon'))
    expect(verdict.kind).toBe('candidate')
    expect(verdict.kind === 'candidate' && verdict.reason).toBe('exact')
    expect(verdict.similarity).toBe(1)
  })

  it('keeps people who only share a first name apart', () => {
    expect(classifyMatch(au('Kate Toon'), au('Kate Smith')).kind).toBe('distinct')
  })

  it('keeps businesses that only share a city apart', () => {
    expect(classifyMatch(au('Sydney Coach'), au('Sydney Studio')).kind).toBe('distinct')
  })

  it('keeps names that only share the family name tokens apart', () => {
    expect(classifyMatch(vn('Nguyen Van A'), vn('Nguyen Van B')).kind).toBe('distinct')
  })

  it('keeps same names in different countries apart', () => {
    expect(classifyMatch(au('Kate Toon'), vn('Kate Toon')).kind).toBe('distinct')
  })

  it('keeps unrelated names apart', () => {
    expect(classifyMatch(au('Jo Green Coaching'), au('BusinessSight')).kind).toBe('distinct')
  })
})
