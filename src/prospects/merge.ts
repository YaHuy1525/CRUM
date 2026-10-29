import { normalizeName } from './normalize'

export type MatchVerdict =
  | { kind: 'candidate'; reason: 'exact' | 'substring'; similarity: number }
  | { kind: 'distinct'; reason: 'none'; similarity: number }

// Category words. Sharing one of these says nothing about identity, so they are
// dropped before the subset test.
const GENERIC_TOKENS = new Set([
  'coach',
  'coaching',
  'the',
  'academy',
  'consulting',
  'studio',
  'fitness',
  'online',
  'australia',
  'vietnam',
  'group',
  'services',
  'training',
])

// The parenthetical is usually the owner's name, and the token stream is what
// identifies the business. Dropping it also keeps "Tradie Coach (Paul Rogers)"
// and "Tech and Tradie Coach (Joel Hayward)" comparable on "Tradie Coach".
function tokensOf(name: string): string[] {
  return normalizeName(name.replace(/\([^)]*\)/g, ' '))
    .split(' ')
    .filter(Boolean)
    .filter((token) => !GENERIC_TOKENS.has(token))
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

function isSubsetOf(shorter: string[], longer: string[]): boolean {
  const longerSet = new Set(longer)
  return shorter.every((token) => longerSet.has(token))
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

  // A candidate needs every remaining token of the shorter name inside the
  // longer one. Sharing a first name or a city is not enough: "Kate Toon" and
  // "Kate Smith" stay distinct, as do "Nguyen Van A" and "Nguyen Van B".
  const leftCore = tokensOf(a.name)
  const rightCore = tokensOf(b.name)
  if (leftCore.length === 0 || rightCore.length === 0) {
    return { kind: 'distinct', reason: 'none', similarity }
  }

  const [shorter, longer] = leftCore.length <= rightCore.length
    ? [leftCore, rightCore]
    : [rightCore, leftCore]
  if (isSubsetOf(shorter, longer)) {
    return { kind: 'candidate', reason: 'substring', similarity }
  }
  return { kind: 'distinct', reason: 'none', similarity }
}
