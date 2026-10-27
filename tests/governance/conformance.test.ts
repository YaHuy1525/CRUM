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
  ['mail.search_threads', 'read-only', null],
  ['doc.list_documents', 'read-only', null],
  ['doc.get_invoice', 'read-only', null],
  ['doc.get_contract', 'read-only', null],
  ['doc.sum_invoices', 'read-only', null],
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

  it('has exactly the twenty-five spec tools plus run.side-effect', () => {
    expect(policy.tools.tools).toHaveLength(SPEC_TOOL_SURFACE.length + TEMPLATE_TOOLS.size)
  })
})

describe('class invariants', () => {
  it('gives every mutating tool an idempotency key', () => {
    // Walks SPEC_TOOL_SURFACE, not the loaded policy. The loader already
    // enforces this rule on policy/tools.yaml — src/governance/schema.ts:34
    // rejects a non-read-only, non-refuse tool with no `idempotent`, and :41
    // rejects `idempotent: true` with no key — so a tool that reaches this file
    // through `policy` cannot violate it, and asserting against the singleton
    // could never fail. The spec constant is the one copy no schema validates,
    // and this is the only assertion in the file that reads its key column:
    // nulling the key on an existing auto or approval row drops that row out of
    // the `gives %s idempotency key %s` walk above, so it is caught here alone.
    //
    // `refuse` is excluded per Ruling A4, recorded in
    // docs/verification/phase-0.md: §4.6.2 assigns crm.bulk_import `—` for the
    // idempotency key, because a tool that never executes has no duplicate
    // write to deduplicate. The same predicate now lives in three places —
    // schema.ts:34, tests/governance/policy.test.ts:137, and here — and an
    // editor who changes one must change all three.
    const offenders = SPEC_TOOL_SURFACE.filter(
      ([, klass, key]) => (klass === 'auto' || klass === 'approval') && key === null,
    ).map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('declares the workflow template at class approval with an actionHash key', () => {
    // run.side-effect is in TEMPLATE_TOOLS rather than SPEC_TOOL_SURFACE, so the
    // it.each walks above never reach it, and the scope-discipline loop skips it
    // because its scope is templated. Without this test it is the one entry in
    // policy/tools.yaml that nothing pins: downgrading it to `auto` would leave
    // the entire suite green.
    const template = policy.tools.tools.find((t) => t.name === 'run.side-effect')
    expect(template, 'run.side-effect is missing from policy/tools.yaml').toBeDefined()
    expect(template?.class).toBe('approval')
    expect(template?.scope).toBe('{workflow}:{step}')
    expect(template?.idempotency_key).toBe('actionHash')
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
    // schema.ts:22 enforces `z.string().min(1)`; the only marginal reach of this
    // test is a whitespace-only description, which min(1) accepts and .trim() catches.
    const offenders = policy.tools.tools.filter((t) => t.description.trim() === '').map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('has exactly fourteen read-only tools', () => {
    expect(policy.toolsByClass('read-only')).toHaveLength(14)
  })

  it('has exactly one refuse-class tool', () => {
    expect(policy.toolsByClass('refuse')).toEqual(['crm.bulk_import'])
  })

  it('never resolves a refuse tool to a gate below refuse', () => {
    // §12.2: the refuse class is never attached to a tool the agent can reach
    // without a human task being created. The gate is what enforces that.
    // Walks SPEC_TOOL_SURFACE's refuse rows rather than policy.toolsByClass('refuse'):
    // iterating the loaded policy goes silently quiet if the refuse class
    // disappears from tools.yaml, which is the exact drift this test names.
    const refuseNames = SPEC_TOOL_SURFACE.filter(([, klass]) => klass === 'refuse').map(([name]) => name)
    expect(refuseNames, 'the spec surface must keep at least one refuse-class tool').not.toHaveLength(0)
    for (const name of refuseNames) {
      expect(policy.gateFor(name, { score: 0, sensitive: false, reasons: [] }), name).toBe('refuse')
    }
  })
})

describe('scope discipline', () => {
  it('gives every tool a non-empty scope', () => {
    // schema.ts:23 enforces `z.string().min(1)`; the only marginal reach of this
    // test is a whitespace-only scope, which min(1) accepts and .trim() catches.
    const offenders = policy.tools.tools.filter((t) => t.scope.trim() === '').map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('contains exactly one templated scope', () => {
    const templated = policy.tools.tools.filter((t) => t.scope.includes('{')).map((t) => t.name)
    expect(templated).toEqual(['run.side-effect'])
  })

  it('uses distinct scopes for distinct permission boundaries', () => {
    // crm-read is shared by eight read tools, knowledge-domains by the ninth,
    // mail-read and doc-read by the rest, which is intended: each is a single
    // boundary, so each still yields exactly one class. What must not happen is
    // one scope carrying two classes at all —
    // a read grant covering a write, or the colon/hyphen pair crm:write
    // (approval) and crm-write (auto) being silently normalised into each other,
    // which policy/tools.yaml:13-28 warns about by name. Asserting exactly one
    // class per concrete scope catches every such merge; the weaker read-only-
    // only condition this replaced caught none of the auto/approval ones.
    const scopeToClasses = new Map<string, Set<string>>()
    for (const tool of policy.tools.tools) {
      if (tool.scope.includes('{')) continue
      const set = scopeToClasses.get(tool.scope) ?? new Set<string>()
      set.add(tool.class)
      scopeToClasses.set(tool.scope, set)
    }
    expect(scopeToClasses.size, 'policy/tools.yaml declares no concrete scopes').toBeGreaterThan(0)
    for (const [scope, classes] of scopeToClasses) {
      expect(classes.size, `scope ${scope} carries ${[...classes].join(' and ')}`).toBe(1)
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
  // The next two tests restate rules src/governance/schema.ts already enforces
  // at parse time: `refuse_at > approval_at` at :114, the strict score ordering
  // at :122, and the 0..100 bound at :15. A drift in policy/risk.yaml therefore
  // fails at import with a PolicyLoadError naming the file and the field, before
  // either test can report. They are kept as documentation of the contract at the
  // conformance layer, not as alarms. The live assertions in this block are
  // `approval_at > 0` — ScoreBound's min is 0, so no schema rule covers a zero
  // floor — and the whole of `puts single_risk in the approval band…`, which
  // cross-relates scores to gates and nothing in the schema does.
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
