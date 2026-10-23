import type { GovernanceContext } from './policy'
import type { RiskFile } from './schema'

/**
 * The outcome of scoring one draft.
 *
 * `score` drives the band thresholds. `sensitive` drives an independent floor,
 * because a draft touching personal data must never be auto-gated whatever its
 * computed score (§12.2). `reasons` is the audit trail shown in the approval
 * queue's diff view (§11.3), so it must be deterministic.
 */
export interface RiskAssessment {
  readonly score: number
  readonly sensitive: boolean
  readonly reasons: readonly string[]
}

/**
 * Tokens are lowercased alphanumeric runs that may contain internal hyphens.
 * Underscores and dots split, so `crm.delete_customer` yields crm, delete,
 * customer, while `team-wide` stays one token.
 *
 * The `g` flag is safe here only because the sole consumer is
 * `String.prototype.match`, which resets `lastIndex` before scanning.
 * Switching that call site to `.test()` or `.exec()` would leak `lastIndex`
 * between `scoreRisk` calls and silently break the determinism guarantee.
 */
const TOKEN_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+)*/g

/** crm.<verb>_<object> where the verb implies an object domain. */
const CRM_DOMAIN_PATTERN = /^crm\.(?:create|update|delete|list|get|find|transfer|log)_(.+)$/

/** Tool-name prefixes that are themselves the policy domain. */
const HEAD_DOMAINS = new Set(['mail', 'knowledge'])

/**
 * Resolve the policy domain for a tool. An explicit `objectType` on the request
 * context wins, which is how `run.side-effect` reaches a domain at all.
 *
 * Plural object names are singularised, so `crm.list_followups` resolves to the
 * `followup` domain. A name with no recognised shape yields undefined, and the
 * caller then applies no domain terms.
 */
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

/**
 * Serialize a draft for term matching. Never throws: a circular structure or a
 * BigInt falls back to String(), because a scorer that throws would turn a
 * governance decision into a request-time failure.
 */
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

/**
 * Does one policy term appear in this draft?
 *
 * A term containing a space is a phrase and matches as a substring. Any other
 * term matches by exact token equality, which is what stops the high-blast term
 * `all` from firing on `called`, `allow` and `wallet`.
 */
function termMatches(term: string, tokens: ReadonlySet<string>, haystack: string): boolean {
  const normalized = term.toLowerCase()
  if (normalized.includes(' ')) return haystack.includes(normalized)
  return tokens.has(normalized)
}

/**
 * Score one draft against the risk policy.
 *
 * Deterministic and side-effect free. The two-argument form `scoreRisk(draft, risk)`
 * is what §4.6.1 calls; passing `toolName` adds the tool's own name to the
 * haystack and enables the per-domain terms, so real call sites should pass it.
 */
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
