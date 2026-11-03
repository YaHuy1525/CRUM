### Task 14: `toIsoString`: the timestamp a row mapper tells the truth about (RV1)

The whole-branch review found `src/db/reviewer-predictions.ts:26` declaring `createdAt: string` while node-pg hands back a `Date`, and named the same fiction at three more columns in `rowToPendingWrite`. It survives in production for one reason only: `JSON.stringify(new Date())` emits the ISO string everybody wanted, so the console prints the right thing past a type that says the wrong thing. The review offered two house patterns, a cast and a normalise, and chose the normalise because a cast keeps the lie. This task is that choice, in one new file and four call sites.

**Files:**
- Create: `src/db/timestamps.ts`
- Modify: `src/db/reviewer-predictions.ts:29-45` (`PredictionSqlRow.created_at`, `rowToPrediction`)
- Modify: `src/db/pending-writes.ts:86` (`rejectedAt`), `:91` (`createdAt`), `:92` (`expiresAt`), `:833` (the receipt's `createdAt`)
- Test: `tests/db/timestamps.test.ts` (new), `tests/db/reviewer-predictions.test.ts`, `tests/db/open-stage-draft.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `toIsoString(value: unknown, label: string): string` and `isoOrNull(value: unknown, label: string): string | null`, both from `../db/timestamps`. `ReviewerPrediction.createdAt` and `PendingWrite.createdAt` keep declaring `string` and now mean it.

- [ ] **Step 1: Write the failing helper tests**

New `tests/db/timestamps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isoOrNull, toIsoString } from '../../src/db/timestamps'

describe('toIsoString', () => {
  it('normalises the Date node-pg actually hands back', () => {
    expect(toIsoString(new Date('2026-11-02T04:00:00.000Z'), 'x.created_at')).toBe('2026-11-02T04:00:00.000Z')
  })

  it('passes a string through untouched, because a json aggregate can carry one', () => {
    expect(toIsoString('2026-11-02T04:00:00.000Z', 'x.created_at')).toBe('2026-11-02T04:00:00.000Z')
  })

  it('crashes on a value that is neither, naming the column', () => {
    expect(() => toIsoString(1730548800000, 'pending_writes.expires_at')).toThrow(
      'pending_writes.expires_at is neither a Date nor a string: number',
    )
  })

  it('crashes rather than stringifying an object', () => {
    expect(() => toIsoString({}, 'audit_receipts.created_at')).toThrow(/neither a Date nor a string/)
  })
})

describe('isoOrNull', () => {
  it('maps both nulls a nullable column can hand back', () => {
    expect(isoOrNull(null, 'pending_writes.rejected_at')).toBeNull()
    expect(isoOrNull(undefined, 'pending_writes.rejected_at')).toBeNull()
  })

  it('normalises a present value', () => {
    expect(isoOrNull(new Date('2026-11-02T04:00:00.000Z'), 'pending_writes.rejected_at')).toBe(
      '2026-11-02T04:00:00.000Z',
    )
  })
})
```

- [ ] **Step 2: Write the mapper tests that the current code fails**

`tests/db/reviewer-predictions.test.ts` already stubs the pool. Add one case whose row carries a real `Date`, which is what `pg` sends on a wire a `created_at: string` annotation never describes:

```ts
it('hands back an ISO string for the Date the driver returns', async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        id: PREDICTION,
        tenant_id: TENANT,
        pending_write_id: DRAFT,
        predicted_outcome: 'leads double',
        created_at: new Date('2026-11-02T04:00:00.000Z'),
      },
    ],
  })
  const { getPredictionForDraft } = await load()
  const prediction = await getPredictionForDraft(TENANT, DRAFT)
  expect(prediction?.createdAt).toBe('2026-11-02T04:00:00.000Z')
  expect(typeof prediction?.createdAt).toBe('string')
})
```

`tests/db/open-stage-draft.test.ts` gets the same shape for the three columns the prediction gate reads (`:86`, `:91`, `:92`), asserting a `Date` row yields three strings and that a `null` `rejected_at` stays `null` rather than becoming the string `"null"`. Use that file's existing row-builder and `load()` helper for the module import.

- [ ] **Step 3: Implement the helper**

New `src/db/timestamps.ts`:

```ts
// src/db/timestamps.ts
/**
 * The one normaliser for a `timestamptz` column read back through node-pg.
 *
 * A row mapper that writes `row.created_at as string` is not carrying a cosmetic
 * cast. The driver hands a `timestamptz` back as a `Date`, so the annotation says
 * one thing and the runtime gives another, and the pair only agrees by accident:
 * `JSON.stringify(new Date())` happens to emit the ISO string every reader wants.
 * The whole-branch review asked for the type to tell the truth, which is why the
 * fix here is a normaliser rather than the second house pattern, a cast that keeps
 * the fiction in place.
 *
 * A value that is neither shape is not coerced. `String({})` is "[object Object]",
 * and a timestamp like that in an approval receipt is worse than a 500: it survives
 * into a report as data. This is the same reasoning that deleted the silent
 * fallback from `getAssetBytes` (`src/db/marketing-assets.ts:119`), and it reaches
 * the same verdict. The `label` names the column so the crash says where.
 *
 * `isoOrNull` exists because the nullable half of this set (`pending_writes.rejected_at`)
 * would otherwise inline the same null test beside the normaliser, and one column's
 * shape is one idea. It keeps the null arm honest rather than letting
 * `toIsoString(null)` turn an un-rejected draft into a crash.
 */
export function toIsoString(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new Error(`${label} is neither a Date nor a string: ${typeof value}`)
}

export function isoOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return toIsoString(value, label)
}
```

- [ ] **Step 4: Move the four sites**

`src/db/reviewer-predictions.ts`: `PredictionSqlRow.created_at` becomes `unknown` (the interface is what the cast was hiding), and `rowToPrediction` ends with:

```ts
    createdAt: toIsoString(row.created_at, 'reviewer_predictions.created_at'),
```

`src/db/pending-writes.ts`, inside `rowToPendingWrite`:

```ts
    rejectedAt: isoOrNull(row.rejected_at, 'pending_writes.rejected_at'),
    createdAt: toIsoString(row.created_at, 'pending_writes.created_at'),
    expiresAt: toIsoString(row.expires_at, 'pending_writes.expires_at'),
```

and in `getReceipt` (`:833`):

```ts
    createdAt: toIsoString(row.created_at, 'audit_receipts.created_at'),
```

The receipt line is the fourth site, and it goes with the other three. The review named `:86`, `:91` and `:92`; leaving one column in the same file carrying the same false annotation is the drift this item exists to end, and it costs one line rather than a slice.

Both files import from `./timestamps`. `committedAt` and `committedRecordId` (`:89-90`) already use `?? null` on a nullable column and are not timestamps of a row the gate reads; leave them, and say in the report that you left them on purpose.

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/db/timestamps.test.ts tests/db/reviewer-predictions.test.ts tests/db/open-stage-draft.test.ts tests/db/pending-writes-commit.test.ts tests/api/marketing.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. The two existing files are named because they are the ones that consume these mappers, and a widened row type that breaks a route test is exactly what this step is for.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/db/timestamps.ts src/db/reviewer-predictions.ts src/db/pending-writes.ts tests/db/timestamps.test.ts tests/db/reviewer-predictions.test.ts tests/db/open-stage-draft.test.ts
git commit -m "fix(db): a row mapper's timestamps say what the driver actually returns"
```

---

