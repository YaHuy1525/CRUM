import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '@/governance/policy'
import { domainOf, scoreRisk } from '@/governance/risk'
import { stagePayload, saveRiskView } from '@/marketing/payload'
import { MARKETING_OBJECTIVES } from '@/db/marketing'

const policy = loadPolicy(join(process.cwd(), 'policy'))
const risk = policy.risk
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const HASH = 'a'.repeat(64)

// The same tokeniser risk.ts uses (src/governance/risk.ts:10). Underscores and
// dots are separators, so publish_page contributes the token `publish`.
const TOKEN_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+)*/g

// Mirrors termMatches in src/governance/risk.ts:47-51 rather than paraphrasing it:
// a single word is a whole-token hit, a multi-word marker is a substring hit on
// the lowercased JSON. Copying only the token half is how 'bank account' slips
// through a sweep that reads as exhaustive.
const TERMS: readonly string[] = Array.from(
  new Set([
    ...risk.preflight.irreversible_terms,
    ...risk.preflight.high_blast_terms,
    ...Object.values(risk.preflight.domains).flatMap(
      (domain) => domain.require_approval_terms ?? [],
    ),
    ...risk.sensitive.markers,
  ]),
)

function forbiddenTermsIn(value: unknown): string[] {
  const haystack = JSON.stringify(value).toLowerCase()
  const tokens = new Set(haystack.match(TOKEN_PATTERN) ?? [])
  return TERMS.map((term) => term.toLowerCase()).filter((term) =>
    term.includes(' ') ? haystack.includes(term) : tokens.has(term),
  )
}

describe('the marketing payload rule', () => {
  it('scores a stage payload of identifiers, a hash and numbers at benign', () => {
    const payload = stagePayload({
      bundleId: BUNDLE,
      draftHash: HASH,
      objective: 'inbound_leads',
      artifactCount: 4,
      requestedCeilingMinor: 2500,
      actionCount: 1,
      siteHash: HASH,
    })
    const assessment = scoreRisk(payload, risk, 'marketing.stage_bundle')
    expect(assessment.score).toBe(risk.preflight.scores.benign)
    expect(policy.gateFor('marketing.stage_bundle', assessment)).toBe('approval')
  })

  it('names no forbidden term in a staged payload or a save view, key or value', () => {
    const payloads: unknown[] = [
      stagePayload({
        bundleId: BUNDLE,
        draftHash: HASH,
        objective: 'proof_asset',
        artifactCount: 6,
        requestedCeilingMinor: 99_000,
        actionCount: 2,
        siteHash: HASH,
      }),
      stagePayload({
        bundleId: BUNDLE,
        draftHash: HASH,
        objective: 'inbound_leads',
        artifactCount: 0,
        requestedCeilingMinor: 0,
        actionCount: 0,
        siteHash: HASH,
      }),
      // The save-side view is the one scored beside real copy, so it is swept for
      // every objective the bundle table will accept, read from the source of
      // truth so a fourth objective cannot join the enum unswept.
      ...MARKETING_OBJECTIVES.map((objective) =>
        saveRiskView({ objective, artifactCount: 3, bundleDraftHash: HASH }),
      ),
    ]

    for (const [index, payload] of payloads.entries()) {
      expect(forbiddenTermsIn(payload), `payload ${index}`).toEqual([])
    }
  })

  it('sweeps a non-empty term list, so an emptied yaml cannot make the rule vacuous', () => {
    expect(TERMS.length).toBeGreaterThan(0)
    expect(TERMS.filter((term) => term.includes(' ')).length).toBeGreaterThan(0)
  })

  it('catches a forbidden term in a prose value, so the sweep cannot pass by being deaf', () => {
    // Multi-word half. 'bank account' tokenises to `bank` and `account`, neither
    // of which is in any term list, so a matcher that only did whole-token hits
    // would report this payload as clean while scoreRisk refused it. This input
    // is type-legal: StagePayload.objective is `string`, not the
    // MARKETING_OBJECTIVES union (src/marketing/payload.ts:28). The tools close
    // that door with a zod enum upstream; this case proves that if it ever
    // opened, the sweep above would see it rather than shrugging.
    expect(forbiddenTermsIn({ objective: 'bank account reconciliation' })).toEqual([
      'bank account',
    ])

    // Single-word half, the same rule's other branch.
    expect(forbiddenTermsIn({ note: 'send' })).toEqual(['send'])

    // And the shape the real payloads have: five payloads, no hits, no accident.
    expect(forbiddenTermsIn(stagePayload({
      bundleId: BUNDLE,
      draftHash: HASH,
      objective: 'outreach_support',
      artifactCount: 1,
      requestedCeilingMinor: 100,
      actionCount: 1,
      siteHash: HASH,
    }))).toEqual([])
  })

  it('gives the scorer a fixed key set and no field that can hold a sentence', () => {
    const view = saveRiskView({
      objective: 'outreach_support',
      artifactCount: 3,
      bundleDraftHash: HASH,
    })
    // A fourth key carrying prose shows up here as a diff, which is the earliest
    // moment anyone can catch it. Spec §7 is about the shape, not about whether
    // today's three fields happen to be clean.
    expect(Object.keys(view).sort()).toEqual([
      'artifactCount',
      'bundleDraftHash',
      'objective',
    ])

    const payload = stagePayload({
      bundleId: BUNDLE,
      draftHash: HASH,
      objective: 'proof_asset',
      artifactCount: 0,
      requestedCeilingMinor: 0,
      actionCount: 0,
      siteHash: HASH,
    })
    expect(Object.keys(payload).sort()).toEqual([
      'actionCount',
      'artifactCount',
      'bundleId',
      'draftHash',
      'objective',
      'requestedCeilingMinor',
      'siteHash',
    ])

    // Every scored string is an identifier, a hash or a slug, so none of them can
    // contain a space — which is exactly what makes the multi-word branch of the
    // sweep unreachable on real payloads, stated as a fact rather than implied by
    // a passing loop. `Object.values` of the StagePayload interface (no index
    // signature) resolves to the `values(o: {}): any[]` overload, so the spread is
    // widened to `unknown[]` to keep the array element type safe; the assertion is
    // unchanged.
    for (const value of [...Object.values(view), ...(Object.values(payload) as unknown[])]) {
      if (typeof value === 'string') expect(value).not.toContain(' ')
    }
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

  it('keeps the stage gate at approval for a zero-count payload', () => {
    // The point is that an empty bundle is not a cheap one: nothing in the score
    // drops it below the declared class, so there is no way to stage a
    // zero-asset, zero-action, zero-ceiling bundle past a reviewer. Role
    // reachability is asserted by tests/mastra/active-tools.test.ts, not here —
    // this file is about payload contents.
    const assessment = scoreRisk(
      stagePayload({
        bundleId: BUNDLE,
        draftHash: HASH,
        objective: 'proof_asset',
        artifactCount: 0,
        requestedCeilingMinor: 0,
        actionCount: 0,
        siteHash: null,
      }),
      risk,
      'marketing.stage_bundle',
    )
    expect(assessment.score).toBe(risk.preflight.scores.benign)
    expect(policy.gateFor('marketing.stage_bundle', assessment)).toBe('approval')
  })
})
