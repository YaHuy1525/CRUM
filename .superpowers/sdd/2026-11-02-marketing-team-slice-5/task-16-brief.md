### Task 16: The `applyDraft` branch that makes an approval mean something

**Files**

- Modify `src/db/pending-writes.ts`, new branch immediately before `const target = requireTarget(draft.objectType)` at `:632`
- Test `tests/db/marketing-commit.test.ts` (five new cases), new `tests/integration/marketing-campaign-status.test.ts`

**Interfaces this task consumes:** the draft `stageCampaignStatusChange` now writes, `PendingWrite.payload` as `{ campaignId: string, status: 'ACTIVE' | 'PAUSED' }`, `commitWithReceipt(draft, { approvedBy, scope })`, `makeSetCampaignStatusAdapter` (`src/marketing/meta-ads.ts:134`), `drainOnce` (`scripts/publish-drain.ts:172`).

**Why it belongs here.** `marketing_set_campaign_status` is in the object-type CHECK (`src/db/pending-writes.ts:62`), in `policy/tools.yaml:281`, and in the guard list. It has never had a branch. Approving one today falls through every marketing branch, reaches `requireTarget`, and throws `unknown object type` out of the transaction that already signed nothing: the owner's click 500s, the campaign does not change, and the draft stays open. Task 15 makes the draft exist; Task 16 makes approving it do something.

- [ ] **Step 1: Write the refusal cases the branch has to answer**

In `tests/db/marketing-commit.test.ts`, beside the existing marketing cases, add a draft builder after `stageDraft` (`:48`):

```ts
function statusDraft(payload: Record<string, unknown>): PendingWrite {
  return {
    ...stageDraft(payload),
    objectType: 'marketing_set_campaign_status',
    operation: 'update',
    // The derived id Task 15 writes. The branch never reads target_id: the
    // campaign lives at Meta, and the payload names it.
    targetId: '77777777-7777-4777-8777-777777777777',
  }
}

const CAMPAIGN = '23842653876'
```

Five cases, all through `commitWithReceipt`, which is how the other marketing branches in this file are driven (`:129`):

```ts
  it('refuses a status draft that is not an update', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
    })
    const draft = { ...statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }), operation: 'create' as const }
    await expect(
      commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:status' }),
    ).rejects.toThrow(UnsupportedCommitError)
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })
```

and the same shape for: a payload status of `'ARCHIVED'` refuses naming the value it was given; a campaign with no succeeded `create_campaign` row refuses naming the campaign id; a draft asking `ACTIVE` when the latest succeeded status action already said `ACTIVE` refuses rather than queueing a no-op; the happy case, which is Step 3.

For the no-op case note what the stub is answering. `status = 'succeeded'` appears in both the existence query and the latest-status query, so key the stubs on the fragments that differ and list them in the order `stubQueries` matches (`tests/db/marketing-commit.test.ts:37`, first match wins): `"action = 'create_campaign'"` for the origin read, `"action = 'set_campaign_status'"` for the latest-status read, `'INSERT INTO marketing_actions'` last. This is the same fragment-collision hazard Task 4 hit, and the same fix applies.

- [ ] **Step 2: Read the shape the branch has to satisfy**

The payload the adapter reads is `{ campaignId, status }`: `makeSetCampaignStatusAdapter` builds `${META_API_BASE}/${payload.campaignId}` and posts `{ status: payload.status }` (`src/marketing/meta-ads.ts:145-157`). `listActiveCampaigns` reads `payload ->> 'status'` off the latest succeeded `set_campaign_status` row (`src/db/marketing.ts:506`), so the row this branch inserts must carry exactly those two keys, or the next analyst run will read the campaign as still paused after a successful activation. `marketing_actions.bundle_id` is `uuid NOT NULL REFERENCES marketing_bundles` (`migrations/0018_crum_marketing.sql:88`), so the branch has to source a real bundle id from the origin row, and the payload does not carry one.

- [ ] **Step 3: Write the branch**

Insert before `:632`, following `marketing_promote` (`:489-565`) step for step for the reason spec section 9.3 gives: it is the same kind of thing, one work order and no content change.

```ts
  // A campaign status change is a work order against an identity CRUM does not
  // own. Everything the payload asserts about another row is re-read under this
  // transaction, because the payload is a claim, and a receipt signed over a
  // campaign that has gone would attest to work the drainer can only fail.
  if (draft.objectType === 'marketing_set_campaign_status') {
    if (draft.operation !== 'update') {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status supports only the update operation, not ${draft.operation}`,
      )
    }
    const campaignId = payload['campaignId']
    const status = payload['status']
    if (typeof campaignId !== 'string' || campaignId.length === 0) {
      throw new UnsupportedCommitError(
        'marketing_set_campaign_status must name a campaign in its payload, so the adapter has an id to address',
      )
    }
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status carries status ${String(status)}, which is neither ACTIVE nor PAUSED, so approving it would send Meta a value its own API rejects`,
      )
    }
    // The campaign must still be the product of a succeeded create_campaign in
    // this tenant, and this read also supplies what the payload deliberately does
    // not carry: the bundle the action row belongs to. Prose in a scored payload
    // moves the gate (spec section 5), so the bundle travels by reference.
    const origin = await client.query<{ bundle_id: string }>(
      `SELECT bundle_id FROM marketing_actions
        WHERE tenant_id = $1
          AND action = 'create_campaign'
          AND status = 'succeeded'
          AND result ->> 'externalId' = $2`,
      [draft.tenantId, campaignId],
    )
    const created = origin.rows[0]
    if (!created) {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status names campaign ${campaignId}, which this tenant has no succeeded create_campaign action for, so there is no campaign here to change`,
      )
    }
    // The no-op rule was asked at staging time. A campaign's state lives at Meta,
    // so this is the last moment on the CRUM side that the question can still be
    // answered, and the answer here is the one the receipt is signed over.
    const latest = await client.query<{ status: string }>(
      `SELECT payload ->> 'status' AS status FROM marketing_actions
        WHERE tenant_id = $1
          AND action = 'set_campaign_status'
          AND payload ->> 'campaignId' = $2
          AND status = 'succeeded'
        ORDER BY created_at DESC
        LIMIT 1`,
      [draft.tenantId, campaignId],
    )
    if (latest.rows[0]?.status === status) {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status asks for ${status}, but campaign ${campaignId} was last set to ${status} by an action that succeeded, so approving it would queue nothing`,
      )
    }
    // receipt_id is NULL for the reason marketing_stage and marketing_promote
    // both give: commitWithReceipt signs its receipt after applyDraft returns, so
    // no receipt id exists to write yet, and the drainer back-fills it.
    const queued = await client.query<{ id: string }>(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, receipt_id)
       VALUES ($1, $2, 'set_campaign_status', $3, 'queued', NULL)
       RETURNING id`,
      [draft.tenantId, created.bundle_id, JSON.stringify({ campaignId, status })],
    )
    // The committed record is the work order, because the work order is what the
    // receipt covers. marketing_promote returns a bundle id instead, since its
    // receipt is a decision about a bundle.
    return queued.rows[0]!.id
  }
```

No `COMMIT_TARGETS` entry, for the reason `marketing_stage` and `marketing_promote` have none: these are not content rows in a CRM table.

- [ ] **Step 4: Finish the happy case in the unit file**

```ts
  it('queues the work order and returns the action row as the committed record', async () => {
    const { commitWithReceipt } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
      "action = 'create_campaign'": [{ bundle_id: BUNDLE }],
      "action = 'set_campaign_status'": [],
      'INSERT INTO marketing_actions': [{ id: ACTION }],
      'INSERT INTO audit_receipts': [{ id: RECEIPT }],
      'UPDATE pending_writes SET receipt_id': [],
    })
    const result = await commitWithReceipt(
      statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    expect(result.committedId).toBe(ACTION)
    const insert = calls('INSERT INTO marketing_actions').at(-1)!
    expect(insert.sql).toContain(`'set_campaign_status'`)
    // The bundle comes from the origin row, not the payload, and the params are
    // what proves it: a fragment stub answers any params, so read the call.
    expect(insert.params[0]).toBe(TENANT)
    expect(insert.params[1]).toBe(BUNDLE)
    expect(JSON.parse(insert.params[2] as string)).toEqual({ campaignId: CAMPAIGN, status: 'ACTIVE' })
    // NULL, not draft.receiptId: the receipt does not exist at this instant.
    expect(insert.sql).toMatch(/'queued', NULL\)/)
  })
```

with `const ACTION = '88888888-8888-4888-8888-888888888888'` and `const RECEIPT = '99999999-9999-4999-8999-999999999999'`, matching the id style already in the file. Also assert `calls('INSERT INTO audit_receipts').at(-1)!.params` carries `ACTION` as `committed_record_id` (position six in the statement at `src/db/pending-writes.ts:687-692`), because that link is what lets a reviewer trace a receipt to the work order it signed.

- [ ] **Step 5: Integration proof 4**

New `tests/integration/marketing-campaign-status.test.ts`, following `tests/integration/marketing-publish.test.ts` for the fixture shape (`migrate(pool)` in `beforeAll` at `:75`, `commitWithReceipt` at `:227`, `describe.skipIf(!url)`):

1. Unique ids in the file's `a5` band. A tenant, a bundle, and one succeeded `create_campaign` row with `result` `{"externalId": "<CAMPAIGN>"}` and `payload` `{"adAccountId": "act_123"}`.
2. `stageCampaignStatusChange({ tenantId, userId: ANALYST, bundleId: BUNDLE, campaignExternalId: CAMPAIGN, status: 'ACTIVE', reason: 'cost_per_lead_below_5', userRole: 'admin' })`, with `registerActionAdapter` in force so the executability guard passes.
3. `getPendingWrite(draftId, TENANT)`, then `commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:status' })`.
4. Assert exactly one `set_campaign_status` row for the bundle, `status = 'queued'`, `receipt_id IS NULL`, payload `{ campaignId, status }`, and `audit_receipts.committed_record_id` equal to that row's id. This is the spec's proof that an approval now produces the work order rather than a 500.
5. Register `makeSetCampaignStatusAdapter({ accessToken: 'test-token', adAccounts: ['act_123'], fetchImpl })` where `fetchImpl` is a local function that records its arguments and resolves `{ ok: true }` with `{ success: true }` JSON, then `await drainOnce({ pool, bundleId: BUNDLE })`. Assert the recorded URL ends with the campaign id and the recorded body is `{"status":"ACTIVE"}`, then assert the row is `succeeded`. Passing `bundleId` is not cosmetic: the integration database is shared across files, and Vitest runs them in parallel workers, so a drain without the scope would claim another file's queued rows.

- [ ] **Step 6: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/db/marketing-commit.test.ts tests/db/pending-writes-commit.test.ts
npx vitest run --project integration tests/integration/marketing-campaign-status.test.ts
npm run typecheck
npm run lint
```

Expected: unit green both times, integration green with the URL exported, and the report naming that file as run rather than skipped.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git add src/db/pending-writes.ts tests/db/marketing-commit.test.ts tests/integration/marketing-campaign-status.test.ts
git commit -m "feat(marketing): approving a campaign status draft queues the work order"
```

---


---

## Controller addenda (pre-flight at `45a0f75`, read before Step 1)

The text above is the plan verbatim. Everything below is the controller's ruling and overrides it where they differ.

### A1. Scope added: the drainer has to be able to run what this task queues (R-39)

`scripts/publish-drain.ts:191-206` claims any queued `marketing_actions` row, rebuilds the action from its `action` and `payload` columns, and asks `isExecutable`. `main()` registers only the two page adapters (`:309-316`, through `pageHostConfigFromEnv`). The Meta adapters are registered only inside `createCrumMastra` (`src/mastra/index.ts:155-181`), which the drainer process never imports. So Steps 1 to 5 as written produce a correct queued row that the documented deployment marks `no_adapter`, and the integration test will not catch it because Step 5 registers the adapter in its own process.

Do all four of these as part of this task:

1. New `src/marketing/meta-ads-config.ts` with two exports. `metaAdsConfigFromEnv(env, label)` reads `CRUM_META_ADS_ACCESS_TOKEN` and `CRUM_META_AD_ACCOUNTS` and returns `MetaAdsConfig | null`, both-or-nothing, warns with the caller's `label` prefix on an unparsable value, and answers null for `[]`; move the body of `statusAdapterConfigFromEnv` out of `scripts/analyst-cron.ts` into it. `registerMetaLane(env, label)` calls it, registers `makeCreateCampaignAdapter` and `makeSetCampaignStatusAdapter` when it answers, warns in the caller's voice when it does not, and returns the boolean. Precedent for a config helper living beside its adapter: `src/marketing/page-host.ts:188` and `src/marketing/meta-conversions.ts:140`.

2. `scripts/publish-drain.ts` `main()` calls `registerMetaLane(env, 'publish-drain')` right after the page lane, next to its existing warning block, so a queued Meta action is executable in the process the plan's own walkthrough tells the operator to run. Both adapters, not just the status one: `create_campaign` has had the same hole since slice 3, and a half-repaired lane reads as a whole one to the next person.
3. `scripts/analyst-cron.ts` calls `registerMetaLane(env, 'analyst-cron')` in `main()` instead of owning the read and the register, and `statusAdapterConfigFromEnv` stops being exported from the script. Move `tests/scripts/analyst-cron-config.test.ts` to `tests/marketing/meta-ads-config.test.ts` with `git mv` and retarget its five cases at `metaAdsConfigFromEnv`; add cases for `registerMetaLane` (both halves present registers two names and returns true, a missing half registers nothing and returns false, an unparsable list warns naming the key and registers nothing). Use `registerActionAdapter`'s returned unregister in `afterEach` so the process registry goes back as it was found. Do not try to unit-test either script's `main()`: it opens a pool and connects, which is out of bounds for a unit file, and the shared helper is where the decision lives.
4. Do not touch `src/mastra/index.ts`. Its inline parse stays, because `tests/mastra/marketing-boot.test.ts:50` pins its warning text and refactoring boot is not this task's subject. The duplication is a known cost, recorded in the ledger and parked for the whole-branch review.

`tests/marketing/publish-drain.test.ts` is safe: four cases, none calls `main()`, none pins the page-lane warning. Verified before this ruling was made.

### A2. Anchor corrections to the text above

| Brief says | Tree says |
| --- | --- |
| `requireTarget` at `src/db/pending-writes.ts:62`/`:632` | union member at `:63`, `requireTarget` at `:638`, so the branch lands before `:638` |
| `marketing_promote` at `:489-565` | `:495` to about `:575` |
| `audit_receipts` insert at `:687-692` | `:693`, and `committed_record_id` is sixth in the column list, as the brief claims |
| `tests/db/marketing-commit.test.ts:37` and `:48` | `stubQueries` at `:39`, `stageDraft` at `:49`, `calls()` at `:77` |
| `src/db/marketing.ts:506` | the `payload ->> 'status'` read is at `:500` |

Exact and not to be hunted for: `makeSetCampaignStatusAdapter` at `src/marketing/meta-ads.ts:134` with URL and body at `:145-157`, `drainOnce({ pool, bundleId })` at `scripts/publish-drain.ts:172`, `policy/tools.yaml:281`, `src/mastra/processors/write-claim-guard.ts:24`, `migrations/0018_crum_marketing.sql:88`, `tests/integration/marketing-publish.test.ts:75` and `:227`, `commitWithReceipt` at `src/db/pending-writes.ts:661`.

### A3. Three things already checked so you do not spend a cycle on them

`tests/db/marketing-commit.test.ts` defines `TENANT`, `APPROVER`, `BUNDLE`, `PAGE_TEXT` and `PAGE_HASH` and has no `ACTION` and no `RECEIPT`. Step 4 uses both, so add them in the file's id style.

`getPendingWrite(id, tenantId)` at `src/db/pending-writes.ts:753` returns `PendingWrite | null`. Step 5's third move must narrow the null before `commitWithReceipt`, not pass the union in.

Inside `applyDraft` the payload is already hoisted at `:406` as `(draft.payload ?? {}) as Record<string, unknown>`, so the branch reads `payload['campaignId']` like its siblings rather than touching `draft.payload` again.

### A4. Relation to Task 15's rulings

R-35: this task's insert is what finally makes `stageCampaignStatusChange`'s already-active read return rows in production, and its unit case stops being stub-only. The no-op rule in Step 3 and the staging-time rule ask the same question one transaction apart, and both stay tenant-wide, matching `src/db/marketing.ts:499-508`. Do not make one of them bundle-scoped.

R-36: `stageCampaignStatusChange` now refuses a `userId` that is not a uuid. The integration proof passes a real one, which is why Step 5's call carries `userId: ANALYST`.

### A5. Gates and commit shape

```bash
npx vitest run tests/db/marketing-commit.test.ts tests/db/pending-writes-commit.test.ts
npx vitest run tests/marketing/meta-ads-config.test.ts tests/marketing/publish-drain.test.ts tests/mastra/marketing-campaign-status-tool.test.ts
npm run typecheck
npm run lint
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/marketing-campaign-status.test.ts tests/integration/analyst-cron.test.ts
```

Both integration files, in one run, because this task changes what the analyst cron registers. Report collected counts, and a skip is not a pass. No test may call Meta, Replicate, a real domain or Cloudflare, the `fetchImpl` stand-in is a local function, and no real token value goes in any file, log or report.

Never run `npm run test`, `npm run verify`, a bare `npx vitest run`, `--project unit` without file paths, or anything under `tests/evals`. Another effort is editing this tree and its untracked files are red in `typecheck` and `lint`, so attribute every diagnostic by file and leave its work unstaged.

Commit by named paths, never `git add -A`, no amend, `-m` before `--`:

```bash
git add src/db/pending-writes.ts tests/db/marketing-commit.test.ts tests/integration/marketing-campaign-status.test.ts
git add src/marketing/meta-ads-config.ts scripts/publish-drain.ts scripts/analyst-cron.ts
git mv tests/scripts/analyst-cron-config.test.ts tests/marketing/meta-ads-config.test.ts
git commit -m "feat(marketing): approving a campaign status draft queues the work order" -- <named paths>
```

`.superpowers/` and `docs/` are gitignored but tracked: `git add -f`, and a plain `git add` there exits 1.
