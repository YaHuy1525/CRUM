import { normalizeName } from './normalize'

export type MatchVerdict =
  | { kind: 'candidate'; reason: 'exact' | 'substring'; similarity: number }
  | { kind: 'distinct'; reason: 'none'; similarity: number }

// The parenthetical is usually the owner's name and the words around it are what
// identify the business, so "Tradie Coach (Paul Rogers)" and "Tech and Tradie
// Coach (Joel Hayward)" are compared on "Tradie Coach".
function tokensOf(name: string): string[] {
  return normalizeName(name.replace(/\([^)]*\)/g, ' '))
    .split(' ')
    .filter(Boolean)
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

  const left = tokensOf(a.name)
  const right = tokensOf(b.name)
  const similarity = jaccard(left, right)

  // A name that is nothing but a parenthetical leaves no tokens to compare.
  if (left.length === 0 || right.length === 0) {
    return { kind: 'distinct', reason: 'none', similarity }
  }

  // Candidates are exactly the equal and the subset pairs. Callers review them
  // by hand, so a short name inside a longer one ("Jo" in "Jo Green") is
  // reported rather than guessed away.
  if (left.length === right.length && left.every((token, i) => token === right[i])) {
    return { kind: 'candidate', reason: 'exact', similarity }
  }

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (isSubsetOf(shorter, longer)) {
    return { kind: 'candidate', reason: 'substring', similarity }
  }
  return { kind: 'distinct', reason: 'none', similarity }
}
