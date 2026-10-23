# Denial-Path Test Checklist

Owner: Phase 3 (write path with confirmation and receipts).
Referenced by: `tests/governance/conformance.test.ts`, the trailing `it.todo`.

A governance plane that has only been shown to approve things is untested. Each
tool below needs a test in which the call is denied, and each denial test must
assert all five of these, not just the first:

1. No record was created, updated or deleted. Assert against the database, not
   against the tool's return value.
2. An `audit_receipts` row exists with `decision = 'rejected'`.
3. The `pending_writes` row carries `rejected_at` and a `rejection_reason`, and
   has left the `idx_pending_queue` partial index.
4. The user-visible message names the reason. A denial that reads as a failure
   teaches people to retry; a denial that reads as a policy teaches them to
   rephrase or escalate.
5. A second identical call is denied identically. Determinism is the property
   that makes the risk scorer trustworthy, and it is only observable by calling
   twice.

## Tools to cover

The seven approval-class tools from `policy/tools.yaml`:

- [ ] `crm.create_customer`
- [ ] `crm.update_customer`
- [ ] `crm.delete_customer`
- [ ] `crm.create_contact`
- [ ] `crm.create_schedule`
- [ ] `crm.transfer_owner`
- [ ] `mail.send`

Plus the workflow-scoped entry, once Phase 3 wires it:

- [ ] `run.side-effect`

Plus the refuse-class tool, which has a different denial path and needs its own
test rather than a variant of the seven above:

- [ ] `crm.bulk_import` — asserts a `human_tasks` row with `kind = 'refusal'`
      exists, that no receipt is written (a refusal is not a decision on a
      draft), and that the refusal is visible in the conversation rather than
      silently dropped.

## Cross-cutting denial tests

- [ ] An unknown tool name resolves to `refuse` rather than `auto`. The
      resolver unit level is covered by `tests/governance/policy.test.ts`
      ("fails closed on an unknown tool name" gates `crm.nuke_everything` to
      `refuse`); Phase 3 must prove it end to end through the agent, and must
      keep it covered from the loader down.
- [ ] A second user cannot read the first user's records **through the agent**.
      §5.2 names this as the Phase 2 acceptance test. The denial-path suite
      should include the write-side equivalent: a staged write whose payload
      names a record in another tenant is denied at the tool execute layer.
- [ ] An approval token replayed against an already-receipted draft produces no
      second commit. `uq_receipts_draft` enforces this in the schema and
      `tests/integration/migrations.test.ts` proves the constraint fires; Phase 3
      must prove the tool surfaces it as a clean denial rather than a 500.
- [ ] An expired draft is denied. `pending_writes.expires_at` exists for this and
      nothing else, so a test that never exercises it leaves the column
      unproven.

## Definition of done for this file

Every box above is checked, the `it.todo` in
`tests/governance/conformance.test.ts` is replaced by a real assertion that the
denial-path tests exist, and a link to this file appears in the Phase 3 plan.
