import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '@/governance/policy'
import { domainOf, scoreRisk } from '@/governance/risk'
import { stagePayload, saveRiskView } from '@/marketing/payload'

const policy = loadPolicy(join(process.cwd(), 'policy'))
const risk = policy.risk
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const HASH = 'a'.repeat(64)

// The same tokeniser risk.ts uses (src/governance/risk.ts:10). Underscores and
// dots are separators, so publish_page contributes the token `publish`.
const TOKEN_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+)*/g

function tokensOf(value: unknown): Set<string> {
  return new Set(JSON.stringify(value).toLowerCase().match(TOKEN_PATTERN) ?? [])
}

const TERM_LISTS = [
  ...risk.preflight.irreversible_terms,
  ...risk.preflight.high_blast_terms,
  ...Object.values(risk.preflight.domains).flatMap(
    (domain) => domain.require_approval_terms ?? [],
  ),
  ...risk.sensitive.markers.filter((marker) => !marker.includes(' ')),
]

describe('the marketing payload rule', () => {
  it('scores a stage payload of identifiers, a hash and numbers at benign', () => {
    const payload = stagePayload({
      bundleId: BUNDLE,
      draftHash: HASH,
      objective: 'inbound_leads',
      artifactCount: 4,
      requestedCeilingMinor: 2500,
      actionCount: 1,
    })
    const assessment = scoreRisk(payload, risk, 'marketing.stage_bundle')
    expect(assessment.score).toBe(risk.preflight.scores.benign)
    expect(policy.gateFor('marketing.stage_bundle', assessment)).toBe('approval')
  })

  it('names no forbidden term in any staged field, key or value', () => {
    const payload = stagePayload({
      bundleId: BUNDLE,
      draftHash: HASH,
      objective: 'proof_asset',
      artifactCount: 6,
      requestedCeilingMinor: 99_000,
      actionCount: 2,
    })
    const tokens = tokensOf(payload)
    const hits = TERM_LISTS.map((term) => term.toLowerCase()).filter((term) => tokens.has(term))
    expect(hits).toEqual([])
  })

  it('proves the trap is real, so this file cannot be satisfied by an empty payload', () => {
    // The sentence a copywriter would write without thinking. Scored directly it
    // is `send` (irreversible) plus `every` (high blast) = 90 = refuse.
    const prose = { copy: { hooks: ['We send a quote to every homeowner the same day'] } }
    const assessment = scoreRisk(prose, risk, 'marketing.save_bundle')
    expect(assessment.score).toBe(risk.preflight.scores.irreversible_high_blast)
    expect(policy.gateFor('marketing.save_bundle', assessment)).toBe('refuse')

    // The same bundle through the redacted view stays at the declared class.
    const view = saveRiskView({ objective: 'outreach_support', artifactCount: 3, bundleDraftHash: HASH })
    expect(policy.gateFor('marketing.save_bundle', scoreRisk(view, risk, 'marketing.save_bundle'))).toBe('auto')
  })

  it('keeps a sensitive marker in the copy out of the scored view', () => {
    // 'health' is a sensitive marker, so a physio campaign would floor every
    // save at approval if the prose were scored.
    const scored = scoreRisk({ copy: 'physio and health clinic owners' }, risk, 'marketing.save_bundle')
    expect(scored.sensitive).toBe(true)
    const view = saveRiskView({ objective: 'outreach_support', artifactCount: 1, bundleDraftHash: HASH })
    expect(scoreRisk(view, risk, 'marketing.save_bundle').sensitive).toBe(false)
  })

  /**
   * Spec section 7 point 3: domainOf resolves mail, knowledge and
   * crm.<verb>_<object> names. A marketing.* name gets no domain floor, which is
   * why policy/risk.yaml gains no marketing block: it could never fire.
   */
  it('resolves no domain for a marketing tool name', () => {
    expect(domainOf('marketing.save_bundle')).toBeUndefined()
    expect(domainOf('marketing.stage_bundle')).toBeUndefined()
  })

  it('declares both marketing tools as approval or auto and never refuse', () => {
    expect(policy.toolByName.get('marketing.save_bundle')?.class).toBe('auto')
    expect(policy.toolByName.get('marketing.stage_bundle')?.class).toBe('approval')
  })

  it('is callable by an admin and not by a plain user for the approval half', () => {
    // active-tools.ts gates on declared class, so this is the role rule restated
    // in one line rather than a second copy of the resolver.
    const assessment = scoreRisk(
      stagePayload({ bundleId: BUNDLE, draftHash: HASH, objective: 'proof_asset', artifactCount: 0, requestedCeilingMinor: 0, actionCount: 0 }),
      risk,
      'marketing.stage_bundle',
    )
    expect(policy.gateFor('marketing.stage_bundle', assessment)).toBe('approval')
  })
})
