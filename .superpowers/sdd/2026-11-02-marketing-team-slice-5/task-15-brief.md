### Task 15: `stageCampaignStatusChange` writes uuids, and the cron names a user

**Files**

- Modify `src/mastra/tools/marketing-writes.ts`, the function at `:811-887`
- Modify `src/config/env.ts`, in the slice-4 settings block that ends at `:208`
- Modify `scripts/analyst-cron.ts`: `runAnalystCron` args `:190-197`, the recommendation loop `:303-327`, `main()` `:356-381`
- Test `tests/mastra/marketing-campaign-status-tool.test.ts`, `tests/config/env.test.ts`, `tests/integration/analyst-cron.test.ts`

**Interfaces this task produces:** `stageCampaignStatusChange({ tenantId, userId, bundleId, campaignExternalId, status, reason, userRole })`, `CrumEnv.CRUM_ANALYST_USER_ID?: string`, `runAnalystCron({ tenantId, ..., analystUserId })`.

**Why four changes and not two.** Spec section 9.2 names the two insert bugs: `targetId: args.campaignExternalId` (`:880`) goes into `pending_writes.target_id`, which is `uuid` (`migrations/0002_crum_spine.sql:149`), and `requestedBy: 'analyst-cron'` (`:884`) goes into `requested_by uuid NOT NULL` (`:158`). A Meta campaign id like `'23842653876'` and a label like `'analyst-cron'` are both `22P02 invalid input syntax for type uuid`, so the insert has failed on every call since slice 3 shipped. The other two changes fall out of reading the function while fixing it: `args.bundleId` is accepted and never used, so the existence check (`:823-833`) matches a campaign created under any bundle in the tenant, and the function is the only marketing staging path that does not ask `isExecutable`, the check `stagePromotion` (`:635`) and `stageRetry` (`:749`) both run before they stage. An action with no adapter in this process is not approvable, and the slice that makes this lane reachable is the moment to enforce that here.

- [ ] **Step 1: Prove the lane is dead before changing it**

Start the cluster (the Integration cluster section) and run the file that has always covered this path:

```bash
cd D:/Code/CRUM
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/analyst-cron.test.ts
```

Expect the `stages a draft for a "scale" recommendation` and `stages a draft for a "kill" recommendation` cases to fail, in one of the two places: the test's own `DELETE FROM pending_writes ... AND target_id = $2` with `'camp-ext-20-a'` errors on the cast, or `runAnalystCron` comes back with `stagedDrafts: []` because the insert inside `getOrCreateDraft` was rejected. Record which, in the report, as the evidence that R6 was unreachable rather than merely unloved. If both cases are green, stop and report that, because the premise of Task 15 and Task 16 is then wrong and nothing should be written on top of it.

Note in the report that these cases have been `describe.skipIf(!url)` for their whole life: an unset `CRUM_INTEGRATION_DATABASE_URL` skips silently, which is how a broken insert survived a slice that reported green.

- [ ] **Step 2: Actor first**

`src/mastra/tools/marketing-writes.ts`, the signature at `:811` gains `userId`, and the function opens with the guard before it reads anything:

```ts
export async function stageCampaignStatusChange(args: {
  tenantId: string
  userId: string
  bundleId: string
  campaignExternalId: string
  status: 'ACTIVE' | 'PAUSED'
  reason: string
  userRole: string
}): Promise<string> {
  const db = getDbClient()

  // requested_by is `uuid NOT NULL` (migrations/0002_crum_spine.sql:158) and the
  // column means who asked. 'analyst-cron' is a label, not a person, and Postgres
  // refused it at the insert, so every draft this function staged since slice 3
  // failed to exist. A call that cannot name an owner refuses here, in words,
  // before it spends a query on 22P02.
  if (!args.userId) {
    throw new Error(
      `campaign_status_actor_required: no user id was supplied for the status change on ${args.campaignExternalId}`,
    )
  }

  // An action this process has no adapter for cannot be run by the drainer, so it
  // must not be approvable. stagePromotion (:635) and stageRetry (:749) both ask;
  // this function is the marketing staging path that never did, and reaching the
  // lane is the point of the residual.
  if (!isExecutable('set_campaign_status')) {
    throw new Error(
      'provider_not_configured: this process has no set_campaign_status adapter, so approving a status change would queue work nothing can run',
    )
  }
```

`isExecutable` is already imported (`:35`). The two guards go before the reads because they are the cheapest answers to ask.

- [ ] **Step 3: Make the bundle argument load-bearing**

The existence check at `:825` gains `AND bundle_id = $3`:

```ts
  const created = await db.query<{ id: string }>(
    `SELECT id FROM marketing_actions
      WHERE tenant_id = $1
        AND action = 'create_campaign'
        AND status = 'succeeded'
        AND result ->> 'externalId' = $2
        AND bundle_id = $3`,
    [args.tenantId, args.campaignExternalId, args.bundleId],
  )
  if (created.rows.length === 0) {
    throw new Error(
      `campaign_not_found: no succeeded create_campaign action for external id ${args.campaignExternalId} on bundle ${args.bundleId}`,
    )
  }
```

The analyst reads metrics per bundle and recommends against that bundle's campaign, so a campaign id created under a different bundle is not this bundle's campaign and its recommendation is not actionable. Until now `bundleId` was decorative, which is the kind of argument a caller can pass wrongly without anything noticing.

- [ ] **Step 4: The uuid target**

Extend the hash import at `:30` to `import { computeBundleHash, uuidFromSeed } from '../../marketing/hash'`, and change the two lines in the `getOrCreateDraft` call at `:880` and `:884`:

```ts
    // Meta's campaign id is not a uuid and target_id is one
    // (migrations/0002_crum_spine.sql:149), which is the second half of why this
    // insert has always failed. uuidFromSeed gives the same external identity the
    // same derived id every time, so a re-ask still lands on the existing draft
    // rather than a second approval, and the real id stays in the payload, which
    // is what applyDraft hands the adapter.
    targetId: uuidFromSeed(`campaign:${args.campaignExternalId}`),
    ...
    requestedBy: args.userId,
```

`runId` stays `'analyst-cron'`: it is a text column and the label is honest there. `payload` stays `{ campaignId, status }` (`:866`) with no prose, because `scoreRisk` stringifies the whole draft and the analyst's `reason` moving the score would make the gate depend on the model's phrasing. The `reason` argument is therefore still not persisted, which is the spec's decision (section 9.1) and stays true; Task 17 puts it in the message the owner reads in chat, and the cron puts it in its log.

- [ ] **Step 5: The setting**

`src/config/env.ts`, after `CRUM_IMAGE_COST_MINOR_PER_IMAGE` (`:204-208`):

```ts
  // Slice 5 spec section 9.2: a staged draft needs a uuid actor, and the analyst
  // cron is the only caller that has no human in the loop. Blank is unset, like
  // every other credential here, so an `CRUM_ANALYST_USER_ID=` placeholder line
  // cannot fail a boot. Unset means the cron reports its recommendations and
  // stages nothing, because inventing a synthetic person to satisfy a column that
  // means "who asked" would put a fiction in the audit trail.
  CRUM_ANALYST_USER_ID: z.preprocess(blankAsUnset, z.string().uuid().optional()),
```

`tests/config/env.test.ts` gets three cases beside the slice-4 ones (`:147` onward): a blank value parses as unset rather than failing the boot, a valid uuid parses through, and `'analyst-cron'` is rejected with an issue that names `CRUM_ANALYST_USER_ID` so the operator knows which line to fix.

Do not touch `.env.example`. It carries another effort's uncommitted edits, and the standing rule keeps it unstaged; the new setting gets recorded in the Task 19 report as a line the owner adds to their own env file.

- [ ] **Step 6: The cron stops staging fictions**

`scripts/analyst-cron.ts`. The args at `:190-197` gain `analystUserId?: string | null`. The loop at `:303-327` becomes:

```ts
    const status = rec.recommendation === 'scale' ? 'ACTIVE' : 'PAUSED'

    // An unattributed draft is not a smaller approval, it is no approval: the
    // insert fails on requested_by before anybody can review it. Report the
    // recommendation, say plainly that nothing was staged, and count it in errors
    // so the summary line cannot read "0 error(s)" over a run that staged nothing.
    if (!args.analystUserId) {
      errors.push(`not_staged_no_actor: ${rec.campaignId}`)
      console.log(
        `[analyst-cron] ${rec.recommendation} for ${rec.campaignId} was not staged (${rec.reason}): CRUM_ANALYST_USER_ID is unset, so no owner could be named as the requester`,
      )
      continue
    }
    try {
      const draftId = await stageStatus({
        tenantId: args.tenantId,
        userId: args.analystUserId,
        bundleId: rec.bundleId,
        campaignExternalId: rec.campaignId,
        status,
        reason: rec.reason,
        userRole: 'campaign-analyst',
      })
```

and `main()` (`:356-381`) reads and passes it:

```ts
  const analystUserId = env.CRUM_ANALYST_USER_ID ?? null
  if (!analystUserId) {
    console.warn(
      '[analyst-cron] CRUM_ANALYST_USER_ID is unset; recommendations will be reported but never staged',
    )
  }
  ...
    const result = await runAnalystCron({ tenantId, metricsReadback, analystUserId })
```

- [ ] **Step 7: Unit tests**

`tests/mastra/marketing-campaign-status-tool.test.ts`. Every existing call of `stageCampaignStatusChange` gains `userId: USER` with `const USER = '55555555-5555-4555-8555-555555555555'`. The two assertions that recorded the bugs become:

```ts
    expect(call.targetId).toBe(uuidFromSeed(`campaign:${CAMPAIGN_ID}`))
    expect(call.requestedBy).toBe(USER)
```

with `import { uuidFromSeed } from '../../src/marketing/hash'`. The existing `expect(call.runId).toBe('analyst-cron')` stays, because that column is text and the label is honest.

Because the function now asks `isExecutable`, and no unit test registers an adapter, the file needs the registry the way `tests/mastra/marketing-publish-tools.test.ts:71` does it. Add to the imports `import { registerActionAdapter } from '../../src/marketing/outbox'`, then:

```ts
let unregister: () => void

beforeEach(() => {
  // The staging function now refuses an action this process cannot run, so the
  // cases below that expect a draft need an adapter present. registerActionAdapter
  // hands back the unregister so the map goes back exactly as it was found
  // (src/marketing/outbox.ts:69), and afterEach means a failed assertion cannot
  // leak the registration into the refusal case below.
  unregister = registerActionAdapter({
    name: 'set_campaign_status',
    execute: () => Promise.resolve({ externalId: 'x' }),
  })
  ...existing mockReset and policy stub...
})

afterEach(() => {
  unregister()
})
```

Three new cases: a call with `userId: ''` rejects with `/campaign_status_actor_required/` and `mockQuery` was never called; a successful call's `create_campaign` existence query carries `args.bundleId` as its third parameter; and a case that calls `unregister()` first and then expects `/provider_not_configured/` with `mockGetOrCreateDraft` not called. The second case needs the recorded-call reader, because a fragment stub answers any parameters and therefore proves nothing about scoping. Add the same local helper `tests/db/marketing-commit.test.ts:76` uses:

```ts
function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}
```

and assert `calls("action = 'create_campaign'").at(-1)!.params` is `[TENANT, CAMPAIGN_ID, BUNDLE_ID]`.

- [ ] **Step 8: Integration tests**

`tests/integration/analyst-cron.test.ts` gains `const ANALYST = 'c4000000-0000-4000-8000-000000000020'`, and the two staging cases pass `analystUserId: ANALYST`. Their cleanup and their counting must address the derived id, not the external one:

```ts
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [
      TENANT,
      uuidFromSeed(`campaign:${CAMPAIGN_A}`),
    ])
    ...
    const draftCount = await countPendingWrites(uuidFromSeed(`campaign:${CAMPAIGN_A}`))
```

One new case, no `analystUserId`: `result.stagedDrafts` is empty, `result.errors` contains `not_staged_no_actor: camp-ext-20-a`, and the console log named the reason the analyst gave. The `hold` case at `:126` and the no-campaigns case at `:114` keep asserting `errors: []`, because the hold path returns before the actor check and an unconfigured install must not be reported as broken when it had nothing to stage.

- [ ] **Step 9: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/config/env.test.ts
npx vitest run --project integration tests/integration/analyst-cron.test.ts
npm run typecheck
npm run lint
```

Expected: the unit file green, the env cases green, and the two cron staging integration cases green, which is the first time they have run at all. Report the skip status honestly: if `CRUM_INTEGRATION_DATABASE_URL` was unset for you, say the file skipped and do not claim the fix is proven.

- [ ] **Step 10: Commit**

```bash
cd D:/Code/CRUM
git add src/mastra/tools/marketing-writes.ts src/config/env.ts scripts/analyst-cron.ts tests/mastra/marketing-campaign-status-tool.test.ts tests/config/env.test.ts tests/integration/analyst-cron.test.ts
git commit -m "fix(marketing): a campaign status draft carries uuids and names its requester"
```

---

