import { describe, expect, it } from 'vitest'
import { policy } from '@/governance'

/**
 * The tool surface exactly as tabulated in TECHNICAL_PLAN.md §4.6.2.
 *
 * This is a copy on purpose. If the spec table and policy/tools.yaml disagree,
 * one of them is wrong, and the disagreement has to fail a build rather than
 * settle itself silently in whichever direction the next editor happened to
 * touch. When a later phase adds a tool, it updates §4.6.2, this constant, and
 * tools.yaml in the same commit.
 */
const SPEC_TOOL_SURFACE: ReadonlyArray<readonly [name: string, klass: string, idempotencyKey: string | null]> = [
  ['crm.list_customers', 'read-only', null],
  ['crm.get_customer', 'read-only', null],
  ['crm.find_contacts', 'read-only', null],
  ['crm.list_followups', 'read-only', null],
  ['crm.list_tasks', 'read-only', null],
  ['crm.list_schedules', 'read-only', null],
  ['crm.my_open_items', 'read-only', null],
  ['crm.search', 'read-only', null],
  ['knowledge.retrieve', 'read-only', null],
  ['crm.create_customer', 'approval', 'draftHash'],
  ['crm.update_customer', 'approval', 'draftHash'],
  ['crm.delete_customer', 'approval', 'draftHash'],
  ['crm.create_contact', 'approval', 'draftHash'],
  ['crm.log_followup', 'auto', 'correlationId'],
  ['crm.create_task', 'auto', 'correlationId'],
  ['crm.create_schedule', 'approval', 'draftHash'],
  ['crm.transfer_owner', 'approval', 'draftHash'],
  ['crm.bulk_import', 'refuse', null],
  ['mail.draft', 'auto', 'draftHash'],
  ['mail.send', 'approval', 'draftHash'],
]

/**
 * Declared in tools.yaml but not in §4.6.2, because it stands for a family of
 * workflow scopes rather than one registered tool. Its scope is a template.
 */
const TEMPLATE_TOOLS = new Set(['run.side-effect'])

const CONNECTOR_SCOPES: ReadonlyArray<readonly [provider: string, scope: string, klass: string]> = [
  ['smtp', 'mail:send', 'approval'],
  ['calendar', 'crm:schedule', 'approval'],
  ['slack', 'approver-notify', 'approval'],
]

describe('tools.yaml conforms to §4.6.2', () => {
  const declared = new Map(policy.tools.tools.map((t) => [t.name, t]))

  it.each(SPEC_TOOL_SURFACE.map(([name]) => [name]))(
    'declares %s',
    (name) => {
      expect(declared.has(name), `${name} is missing from policy/tools.yaml`).toBe(true)
    },
  )

  it.each(SPEC_TOOL_SURFACE)('declares %s as class %s', (name, klass) => {
    expect(declared.get(name)?.class, name).toBe(klass)
  })

  it.each(SPEC_TOOL_SURFACE.filter(([, , key]) => key !== null))('gives %s idempotency key %s', (name, _klass, key) => {
    expect(declared.get(name)?.idempotency_key, name).toBe(key)
  })

  it('declares nothing beyond the spec surface plus the workflow template', () => {
    const specNames = new Set(SPEC_TOOL_SURFACE.map(([name]) => name))
    const extra = [...declared.keys()].filter((n) => !specNames.has(n) && !TEMPLATE_TOOLS.has(n))
    expect(extra).toEqual([])
  })

  it('has exactly the twenty spec tools plus run.side-effect', () => {
    expect(policy.tools.tools).toHaveLength(SPEC_TOOL_SURFACE.length + TEMPLATE_TOOLS.size)
  })
})

describe('class invariants', () => {
  it('gives every mutating tool an idempotency key', () => {
    // Ruling A4: `refuse` is excluded because a refuse-class tool never
    // executes — §4.6.2 assigns crm.bulk_import `—` for the idempotency key,
    // and there is no duplicate write to deduplicate. This filter must stay in
    // step with the loader's own rule at src/governance/schema.ts:34; the same
    // predicate now lives in two places, and an editor who changes one must
    // change the other.
    const offenders = policy.tools.tools
      .filter((t) => t.class !== 'read-only' && t.class !== 'refuse' && t.idempotency_key === undefined)
      .map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('gives no read-only tool an idempotency key', () => {
    // A read-only tool has no side effect to deduplicate. Declaring one invites
    // a reader to believe the tool writes.
    const offenders = policy.tools.tools
      .filter((t) => t.class === 'read-only' && t.idempotency_key !== undefined)
      .map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('gives every tool a non-empty description', () => {
    const offenders = policy.tools.tools.filter((t) => t.description.trim() === '').map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('has exactly nine read-only tools', () => {
    expect(policy.toolsByClass('read-only')).toHaveLength(9)
  })

  it('has exactly one refuse-class tool', () => {
    expect(policy.toolsByClass('refuse')).toEqual(['crm.bulk_import'])
  })

  it('never resolves a refuse tool to a gate below refuse', () => {
    // §12.2: the refuse class is never attached to a tool the agent can reach
    // without a human task being created. The gate is what enforces that.
    for (const name of policy.toolsByClass('refuse')) {
      expect(policy.gateFor(name, { score: 0, sensitive: false, reasons: [] }), name).toBe('refuse')
    }
  })
})

describe('scope discipline', () => {
  it('gives every tool a non-empty scope', () => {
    const offenders = policy.tools.tools.filter((t) => t.scope.trim() === '').map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('contains exactly one templated scope', () => {
    const templated = policy.tools.tools.filter((t) => t.scope.includes('{')).map((t) => t.name)
    expect(templated).toEqual(['run.side-effect'])
  })

  it('uses distinct scopes for distinct permission boundaries', () => {
    // crm-read is shared by all nine read tools, which is intended: they are one
    // boundary. What must not happen is an approval tool sharing a scope with a
    // read-only one, which would let a read grant cover a write.
    const scopeToClasses = new Map<string, Set<string>>()
    for (const tool of policy.tools.tools) {
      if (tool.scope.includes('{')) continue
      const set = scopeToClasses.get(tool.scope) ?? new Set<string>()
      set.add(tool.class)
      scopeToClasses.set(tool.scope, set)
    }
    for (const [scope, classes] of scopeToClasses) {
      const mixesReadAndWrite = classes.has('read-only') && classes.size > 1
      expect(mixesReadAndWrite, `scope ${scope} mixes read-only with ${[...classes].join(',')}`).toBe(false)
    }
  })
})

describe('connectors', () => {
  it.each(CONNECTOR_SCOPES)('declares %s at scope %s class %s', (provider, scope, klass) => {
    const connector = policy.tools.connectors.find((c) => c.provider === provider)
    expect(connector, `${provider} missing from policy/tools.yaml`).toBeDefined()
    expect(connector?.scope).toBe(scope)
    expect(connector?.class).toBe(klass)
  })

  it('declares no connector at class auto or read-only', () => {
    // Every connector reaches an external system. None may run ungated.
    const offenders = policy.tools.connectors
      .filter((c) => c.class === 'auto' || c.class === 'read-only')
      .map((c) => c.provider)
    expect(offenders).toEqual([])
  })

  it('marks the notification connector as never a workflow action', () => {
    const slack = policy.tools.connectors.find((c) => c.provider === 'slack')
    expect(slack?.scope).toBe('approver-notify')
    expect(slack?.description.toLowerCase()).toContain('never a workflow action')
  })
})

describe('risk policy coherence', () => {
  it('orders the gate thresholds so both bands are reachable', () => {
    const { refuse_at, approval_at } = policy.risk.preflight.gates
    expect(approval_at).toBeGreaterThan(0)
    expect(refuse_at).toBeGreaterThan(approval_at)
    expect(refuse_at).toBeLessThanOrEqual(100)
  })

  it('orders the score levels strictly', () => {
    const { irreversible_high_blast, single_risk, benign } = policy.risk.preflight.scores
    expect(irreversible_high_blast).toBeGreaterThan(single_risk)
    expect(single_risk).toBeGreaterThan(benign)
  })

  it('puts single_risk in the approval band and irreversible_high_blast in the refuse band', () => {
    // If either drifts, the term lists stop meaning what their names say.
    const { gates, scores } = policy.risk.preflight
    expect(scores.single_risk).toBeGreaterThanOrEqual(gates.approval_at)
    expect(scores.single_risk).toBeLessThan(gates.refuse_at)
    expect(scores.irreversible_high_blast).toBeGreaterThanOrEqual(gates.refuse_at)
    expect(scores.benign).toBeLessThan(gates.approval_at)
  })

  it('has a sensitive floor that is a real gate', () => {
    expect(policy.risk.sensitive.required_gate).toBe('approval')
    expect(policy.risk.sensitive.markers.length).toBeGreaterThanOrEqual(8)
  })

  it('names a compliance clause for the sensitive floor', () => {
    expect(policy.risk.sensitive.clause).toBe('sensitive/personal-data')
  })
})

// §12.2 also requires that every approval-class tool has a denial-path test
// verifying the receipt rather than trusting the caller's claim. No tools are
// registered in Phase 0, so there is nothing to deny yet. This is tracked
// rather than skipped: Task 14 writes the checklist into
// docs/verification/denial-paths.md and Phase 3 must clear every line.
it.todo('Phase 3: every approval-class tool has a denial-path receipt test')
