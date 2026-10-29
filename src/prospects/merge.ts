import { normalizeName } from './normalize'

export type MatchVerdict =
  | { kind: 'candidate'; reason: 'exact' | 'substring'; similarity: number }
  | { kind: 'distinct'; reason: 'none'; similarity: number }

const MIN_TOKEN_LENGTH = 4
const GENERIC_TOKENS = new Set([
  'coach',
  'coaching',
  'consultant',
  'consulting',
  'agency',
  'media',
  'group',
  'services',
  'service',
  'academy',
  'school',
  'studio',
  'official',
  'the',
  'and',
])

function tokensOf(name: string): string[] {
  return normalizeName(name).split(' ').filter(Boolean)
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

function longestSharedRun(left: string[], right: string[]): number {
  let best = 0
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      let run = 0
      while (i + run < left.length && j + run < right.length && left[i + run] === right[j + run]) {
        run += 1
      }
      if (run > best) best = run
    }
  }
  return best
}

function sharesDistinctiveToken(left: string[], right: string[]): boolean {
  for (const token of new Set(left)) {
    if (token.length < MIN_TOKEN_LENGTH || GENERIC_TOKENS.has(token)) continue
    if (right.includes(token)) return true
  }
  return false
}

export function classifyMatch(
  a: { name: string; country: 'AU' | 'VN' },
  b: { name: string; country: 'AU' | 'VN' },
): MatchVerdict {
  if (a.country !== b.country) return { kind: 'distinct', reason: 'none', similarity: 0 }

  const left = normalizeName(a.name)
  const right = normalizeName(b.name)
  const leftTokens = left.split(' ').filter(Boolean)
  const rightTokens = right.split(' ').filter(Boolean)
  const similarity = jaccard(leftTokens, rightTokens)

  if (left === right) return { kind: 'candidate', reason: 'exact', similarity: 1 }
  if (longestSharedRun(leftTokens, rightTokens) >= 2 || sharesDistinctiveToken(leftTokens, rightTokens)) {
    return { kind: 'candidate', reason: 'substring', similarity }
  }
  return { kind: 'distinct', reason: 'none', similarity }
}
