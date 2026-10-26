import type { GovernanceContext } from './policy'
import type { RiskFile } from './schema'

export interface RiskAssessment {
  readonly score: number
  readonly sensitive: boolean
  readonly reasons: readonly string[]
}

const TOKEN_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+)*/g

const CRM_DOMAIN_PATTERN = /^crm\.(?:create|update|delete|list|get|find|transfer|log)_(.+)$/

const HEAD_DOMAINS = new Set(['mail', 'knowledge'])

export function domainOf(
  toolName: string | undefined,
  context?: GovernanceContext,
): string | undefined {
  const explicit = context?.requestContext?.['objectType']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  if (!toolName) return undefined

  const head = toolName.split('.')[0]
  if (head !== undefined && HEAD_DOMAINS.has(head)) return head

  const objectName = CRM_DOMAIN_PATTERN.exec(toolName)?.[1]
  if (!objectName) return undefined
  return objectName.endsWith('s') ? objectName.slice(0, -1) : objectName
}

function stringify(draft: unknown): string {
  if (draft === null || draft === undefined) return ''
  if (typeof draft === 'string') return draft
  try {
    return JSON.stringify(draft) ?? ''
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberate lossy fallback
      return String(draft)
    } catch {
      return ''
    }
  }
}

function termMatches(term: string, tokens: ReadonlySet<string>, haystack: string): boolean {
  const normalized = term.toLowerCase()
  if (normalized.includes(' ')) return haystack.includes(normalized)
  return tokens.has(normalized)
}

export function scoreRisk(
  draft: unknown,
  risk: RiskFile,
  toolName?: string,
  context?: GovernanceContext,
): RiskAssessment {
  const haystack = `${toolName ?? ''} ${stringify(draft)}`.toLowerCase()
  const tokens = new Set(haystack.match(TOKEN_PATTERN) ?? [])
  const reasons: string[] = []

  const irreversible = risk.preflight.irreversible_terms.filter((term) =>
    termMatches(term, tokens, haystack),
  )
  if (irreversible.length > 0) reasons.push(`irreversible: ${irreversible.join(', ')}`)

  const highBlast = risk.preflight.high_blast_terms.filter((term) =>
    termMatches(term, tokens, haystack),
  )
  if (highBlast.length > 0) reasons.push(`high-blast: ${highBlast.join(', ')}`)

  const domain = domainOf(toolName, context)
  const domainTerms = domain ? (risk.preflight.domains[domain]?.require_approval_terms ?? []) : []
  const domainHits = domainTerms.filter((term) => termMatches(term, tokens, haystack))
  if (domain !== undefined && domainHits.length > 0) {
    reasons.push(`domain ${domain}: ${domainHits.join(', ')}`)
  }

  const markers = risk.sensitive.markers.filter((marker) =>
    termMatches(marker, tokens, haystack),
  )
  const sensitive = markers.length > 0
  if (sensitive) reasons.push(`sensitive (${risk.sensitive.clause}): ${markers.join(', ')}`)

  const { scores } = risk.preflight
  const score =
    irreversible.length > 0 && highBlast.length > 0
      ? scores.irreversible_high_blast
      : irreversible.length > 0 || highBlast.length > 0 || domainHits.length > 0
        ? scores.single_risk
        : scores.benign

  return { score, sensitive, reasons }
}
