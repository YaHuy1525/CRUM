# Phase 3: Cursor Paging and Extended Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace offset-based pagination with cursor-based keyset pagination for the review queue, and add three new analytics aggregates (byCustomer, byVendor, heatmap).

**Architecture:** Cursor paging uses the ORDER BY columns (`open_errors DESC, lowest_field_confidence ASC NULLS LAST, created_at ASC, id ASC`) as a composite key. The application layer builds the WHERE clause dynamically based on whether cursor values are null. Extended analytics adds three new SQL queries to the existing `reviewAnalytics` function, all respecting the same window and kind filters.

**Tech Stack:** PostgreSQL, TypeScript, React, Vitest, Testing Library

**Spec:** PHASE3_SPEC.md

## Global Constraints

- Windows + Git Bash environment: use `python` not `python3`, npm via `.cmd` full path
- No `git stash`/`git checkout --`/`git restore` in worktree (R63)
- All `<table>` elements must have `overflow-x-auto` wrapper (style contract)
- `onClick` for async handlers uses `() => { void fn() }` pattern
- ESLint `no-base-to-string` requires `'[unserialisable]'` not `String(value)`
- No identity headers in console client functions (R61)
- TDD: write tests first, then implementation, per task

---

## Task 1: Cursor Parsing and Generation Utilities

**Files:**
- Create: `src/db/cursor.ts`
- Test: `tests/db/cursor.test.ts`

**Interfaces:**
- Consumes: `ReviewQueueItem` shape from `console/lib/review.ts:39-50`
- Produces: `parseCursor(cursor: string): ParsedCursor | null`, `generateCursor(item: QueueRow): string`

- [ ] **Step 1: Write failing test for parseCursor with valid cursor**

```typescript
// tests/db/cursor.test.ts
import { describe, expect, it } from 'vitest'
import { parseCursor } from '../../src/db/cursor'

describe('parseCursor', () => {
  it('parses a valid cursor with non-null lowestConfidence', () => {
    const result = parseCursor('5|0.42|2026-11-03T09:00:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(result).toEqual({
      openErrors: 5,
      lowestConfidence: 0.42,
      createdAt: new Date('2026-11-03T09:00:00.000Z'),
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/cursor.test.ts`
Expected: FAIL with "Cannot find module '../../src/db/cursor'"

- [ ] **Step 3: Write failing test for parseCursor with null lowestConfidence**

```typescript
// Add to tests/db/cursor.test.ts
it('parses a cursor with null lowestConfidence', () => {
  const result = parseCursor('3|null|2026-11-03T10:00:00.000Z|b2c3d4e5-f6a7-8901-bcde-f12345678901')
  expect(result).toEqual({
    openErrors: 3,
    lowestConfidence: null,
    createdAt: new Date('2026-11-03T10:00:00.000Z'),
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
})
```

- [ ] **Step 4: Write failing test for parseCursor with malformed input**

```typescript
// Add to tests/db/cursor.test.ts
it('returns null for malformed cursor (wrong number of parts)', () => {
  expect(parseCursor('5|0.42|2026-11-03T09:00:00.000Z')).toBeNull()
})

it('returns null for malformed cursor (invalid number)', () => {
  expect(parseCursor('abc|0.42|2026-11-03T09:00:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull()
})

it('returns null for malformed cursor (invalid date)', () => {
  expect(parseCursor('5|0.42|not-a-date|a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull()
})
```

- [ ] **Step 5: Write failing test for generateCursor**

```typescript
// Add to tests/db/cursor.test.ts
import { generateCursor } from '../../src/db/cursor'

describe('generateCursor', () => {
  it('generates cursor from row with non-null lowestConfidence', () => {
    const row = {
      openErrors: 5,
      lowestFieldConfidence: 0.42,
      createdAt: '2026-11-03T09:00:00.000Z',
      documentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    }
    expect(generateCursor(row)).toBe('5|0.42|2026-11-03T09:00:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })

  it('generates cursor from row with null lowestConfidence', () => {
    const row = {
      openErrors: 3,
      lowestFieldConfidence: null,
      createdAt: '2026-11-03T10:00:00.000Z',
      documentId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    }
    expect(generateCursor(row)).toBe('3|null|2026-11-03T10:00:00.000Z|b2c3d4e5-f6a7-8901-bcde-f12345678901')
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/db/cursor.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 7: Implement parseCursor and generateCursor**

```typescript
// src/db/cursor.ts
export interface ParsedCursor {
  openErrors: number
  lowestConfidence: number | null
  createdAt: Date
  id: string
}

export interface QueueRow {
  openErrors: number
  lowestFieldConfidence: number | null
  createdAt: string
  documentId: string
}

export function parseCursor(cursor: string): ParsedCursor | null {
  const parts = cursor.split('|')
  if (parts.length !== 4) return null

  const openErrors = Number(parts[0])
  if (!Number.isInteger(openErrors) || openErrors < 0) return null

  const lowestConfidence = parts[1] === 'null' ? null : Number(parts[1])
  if (lowestConfidence !== null && (!Number.isFinite(lowestConfidence) or lowestConfidence < 0 || lowestConfidence > 1)) return null

  const createdAt = new Date(parts[2])
  if (Number.isNaN(createdAt.getTime())) return null

  const id = parts[3]
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null

  return { openErrors, lowestConfidence, createdAt, id }
}

export function generateCursor(item: QueueRow): string {
  return `${item.openErrors}|${item.lowestFieldConfidence ?? 'null'}|${item.createdAt}|${item.documentId}`
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/db/cursor.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/db/cursor.ts tests/db/cursor.test.ts
git commit -m "feat(phase3): add cursor parsing and generation utilities"
```

---

## Task 2: Build Cursor WHERE Clause Dynamically

**Files:**
- Modify: `src/db/cursor.ts`
- Test: `tests/db/cursor.test.ts`

**Interfaces:**
- Consumes: `ParsedCursor` from Task 1
- Produces: `buildCursorCondition(cursor: ParsedCursor | null): { sql: string; params: unknown[] }`

- [ ] **Step 1: Write failing test for first page (no cursor)**

```typescript
// Add to tests/db/cursor.test.ts
import { buildCursorCondition } from '../../src/db/cursor'

describe('buildCursorCondition', () => {
  it('returns empty condition for null cursor (first page)', () => {
    const result = buildCursorCondition(null)
    expect(result.sql).toBe('')
    expect(result.params).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/cursor.test.ts`
Expected: FAIL with "buildCursorCondition is not a function"

- [ ] **Step 3: Write failing test for cursor with non-null lowestConfidence**

```typescript
// Add to tests/db/cursor.test.ts
it('builds condition for cursor with non-null lowestConfidence', () => {
  const cursor: ParsedCursor = {
    openErrors: 5,
    lowestConfidence: 0.42,
    createdAt: new Date('2026-11-03T09:00:00.000Z'),
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  }
  const result = buildCursorCondition(cursor)
  expect(result.sql).toContain('open_errors < $1')
  expect(result.sql).toContain('lowest_field_confidence > $2')
  expect(result.sql).toContain('lowest_field_confidence IS NULL')
  expect(result.params).toEqual([
    5,
    0.42,
    '2026-11-03T09:00:00.000Z',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  ])
})
```

- [ ] **Step 4: Write failing test for cursor with null lowestConfidence**

```typescript
// Add to tests/db/cursor.test.ts
it('builds condition for cursor with null lowestConfidence', () => {
  const cursor: ParsedCursor = {
    openErrors: 3,
    lowestConfidence: null,
    createdAt: new Date('2026-11-03T10:00:00.000Z'),
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  }
  const result = buildCursorCondition(cursor)
  expect(result.sql).toContain('open_errors < $1')
  expect(result.sql).toContain('lowest_field_confidence IS NULL')
  expect(result.sql).not.toContain('lowest_field_confidence > $2')
  expect(result.params).toEqual([
    3,
    '2026-11-03T10:00:00.000Z',
    'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  ])
})
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run tests/db/cursor.test.ts`
Expected: FAIL

- [ ] **Step 6: Implement buildCursorCondition**

```typescript
// Add to src/db/cursor.ts
export function buildCursorCondition(cursor: ParsedCursor | null): { sql: string; params: unknown[] } {
  if (cursor === null) {
    return { sql: '', params: [] }
  }

  if (cursor.lowestConfidence === null) {
    // Cursor is at a NULL value; only rows with NULL come after (use created_at/id as tiebreaker)
    const sql = `AND (
      open_errors < $1
      OR (open_errors = $1 AND lowest_field_confidence IS NULL AND (
        created_at > $2
        OR (created_at = $2 AND id > $3)
      ))
    )`
    return {
      sql,
      params: [cursor.openErrors, cursor.createdAt.toISOString(), cursor.id],
    }
  } else {
    // Cursor is at a non-null value; rows after include higher values AND all nulls
    const sql = `AND (
      open_errors < $1
      OR (open_errors = $1 AND (
        lowest_field_confidence > $2
        OR lowest_field_confidence IS NULL
        OR (lowest_field_confidence = $2 AND (
          created_at > $3
          OR (created_at = $3 AND id > $4)
        ))
      ))
    )`
    return {
      sql,
      params: [cursor.openErrors, cursor.lowestConfidence, cursor.createdAt.toISOString(), cursor.id],
    }
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/db/cursor.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/db/cursor.ts tests/db/cursor.test.ts
git commit -m "feat(phase3): add dynamic cursor WHERE clause builder"
```

---

## Task 3: Update reviewQueue Database Function

**Files:**
- Modify: `src/db/validation.ts:234-289`
- Test: `tests/db/validation.test.ts`

**Interfaces:**
- Consumes: `buildCursorCondition`, `parseCursor` from `src/db/cursor.ts`
- Produces: Updated `reviewQueue` signature: `filter.cursor?: string` instead of `filter.offset: number`

- [ ] **Step 1: Write failing test for reviewQueue with cursor**

```typescript
// Add to tests/db/validation.test.ts
import { reviewQueue } from '../../src/db/validation'
import { generateCursor } from '../../src/db/cursor'

describe('reviewQueue with cursor', () => {
  it('returns first page when no cursor provided', async () => {
    const context = makeContext()
    const result = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 10,
      cursor: undefined,
    })
    expect(result.rows).toHaveLength(10)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBeTruthy()
  })

  it('returns second page when cursor from last row of first page', async () => {
    const context = makeContext()
    const firstPage = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 10,
      cursor: undefined,
    })
    const lastRow = firstPage.rows[9]
    const cursor = generateCursor({
      openErrors: lastRow.open_errors,
      lowestFieldConfidence: lastRow.lowest_field_confidence,
      createdAt: lastRow.created_at.toISOString(),
      documentId: lastRow.document_id,
    })
    
    const secondPage = await reviewQueue(context, {
      kind: null,
      severity: null,
      limit: 10,
      cursor,
    })
    
    expect(secondPage.rows).toHaveLength(10)
    expect(secondPage.rows[0].document_id).not.toBe(firstPage.rows[0].document_id)
    // No overlap
    const firstPageIds = new Set(firstPage.rows.map(r => r.document_id))
    for (const row of secondPage.rows) {
      expect(firstPageIds.has(row.document_id)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/validation.test.ts`
Expected: FAIL with type error (cursor property doesn't exist on filter)

- [ ] **Step 3: Update ReviewQueueFilter interface**

```typescript
// In src/db/validation.ts, find ReviewQueueFilter and update:
export interface ReviewQueueFilter {
  kind: 'invoice' | 'contract' | null
  severity: 'error' | 'warning' | null
  limit: number
  cursor?: string  // Replace offset with cursor
}
```

- [ ] **Step 4: Import cursor utilities**

```typescript
// Add to imports at top of src/db/validation.ts
import { parseCursor, generateCursor, buildCursorCondition } from './cursor'
```

- [ ] **Step 5: Update reviewQueue function signature and return type**

```typescript
// In src/db/validation.ts:234-289, update the function:
export async function reviewQueue(
  context: TenantRequestContext,
  filter: ReviewQueueFilter,
): Promise<{ rows: ReviewQueueRow[]; total: number; nextCursor: string | null; hasMore: boolean }> {
  // ... existing code ...
}
```

- [ ] **Step 6: Replace OFFSET with cursor condition in SQL**

```typescript
// In reviewQueue function, replace the pageResult query:
const parsedCursor = filter.cursor ? parseCursor(filter.cursor) : null
if (filter.cursor && !parsedCursor) {
  throw new Error('Invalid cursor format')
}

const cursorCondition = buildCursorCondition(parsedCursor)
const cursorParams = cursorCondition.params

const allParams = [
  ...vis.params,
  filter.kind,
  filter.severity,
  filter.limit + 1, // Fetch one extra to determine hasMore
  ...cursorParams,
]

const pageResult = await client.query<ReviewQueueRow>(
  `SELECT d.id AS document_id, d.title, d.kind, d.status, d.confidence,
          d.created_at,
          (SELECT MIN(NULLIF(kv.value, 'null'::jsonb)::numeric)
             FROM jsonb_each(d.field_confidence) AS kv(key, value)) AS lowest_field_confidence,
          COALESCE(c.errors, 0)::int   AS open_errors,
          COALESCE(c.warnings, 0)::int AS open_warnings` +
    from +
    ` ${cursorCondition.sql}
   ORDER BY COALESCE(c.errors, 0) DESC, lowest_field_confidence ASC NULLS LAST,
              d.created_at ASC, d.id ASC
     LIMIT ${limitRef}`,
  allParams,
)

const hasMore = pageResult.rows.length > filter.limit
const rows = hasMore ? pageResult.rows.slice(0, filter.limit) : pageResult.rows

let nextCursor: string | null = null
if (hasMore && rows.length > 0) {
  const lastRow = rows[rows.length - 1]
  nextCursor = generateCursor({
    openErrors: lastRow.open_errors,
    lowestFieldConfidence: lastRow.lowest_field_confidence,
    createdAt: lastRow.created_at.toISOString(),
    documentId: lastRow.document_id,
  })
}

return { rows, total: countResult.rows[0]?.total ?? 0, nextCursor, hasMore }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/db/validation.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/db/validation.ts tests/db/validation.test.ts
git commit -m "feat(phase3): replace offset with cursor in reviewQueue"
```

---

## Task 4: Update /review-queue API Route

**Files:**
- Modify: `src/api/documents.ts:422-456`
- Test: `tests/api/review-queue-cursor.test.ts`

**Interfaces:**
- Consumes: Updated `reviewQueue` from Task 3
- Produces: API response with `nextCursor` and `hasMore` instead of `offset`

- [ ] **Step 1: Write failing test for cursor parameter**

```typescript
// tests/api/review-queue-cursor.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/api/app'

describe('GET /review-queue with cursor', () => {
  it('returns nextCursor and hasMore in response', async () => {
    const res = await app.request('/api/documents/review-queue?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('nextCursor')
    expect(body).toHaveProperty('hasMore')
    expect(body).not.toHaveProperty('offset')
  })

  it('accepts cursor parameter', async () => {
    const firstRes = await app.request('/api/documents/review-queue?limit=10')
    const firstBody = await firstRes.json()
    
    const secondRes = await app.request(`/api/documents/review-queue?limit=10&cursor=${firstBody.nextCursor}`)
    expect(secondRes.status).toBe(200)
  })

  it('returns 400 for malformed cursor', async () => {
    const res = await app.request('/api/documents/review-queue?cursor=invalid')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('bad_filter')
    expect(body.param).toBe('cursor')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/review-queue-cursor.test.ts`
Expected: FAIL (response still has offset, doesn't accept cursor)

- [ ] **Step 3: Update route to remove offset and add cursor**

```typescript
// In src/api/documents.ts:422-456, replace the route:
app.get('/review-queue', async (c) => {
  const gate = await auth(c)
  if ('error' in gate) return gate.error

  const kind = c.req.query('kind')
  if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
    return c.json({ error: 'bad_filter', param: 'kind' }, 400)
  }
  const severity = c.req.query('severity')
  if (severity !== undefined && severity !== 'error' && severity !== 'warning') {
    return c.json({ error: 'bad_filter', param: 'severity' }, 400)
  }

  const rawLimit = intQuery(c.req.query('limit'), 50)
  if (rawLimit === null || rawLimit < 1) {
    return c.json({ error: 'bad_filter', param: 'limit' }, 400)
  }
  const limit = Math.min(200, rawLimit)

  const cursor = c.req.query('cursor')
  if (cursor !== undefined) {
    const parsed = parseCursor(cursor)
    if (!parsed) {
      return c.json({ error: 'bad_filter', param: 'cursor' }, 400)
    }
  }

  const { rows, total, nextCursor, hasMore } = await reviewQueue(gate.identity, {
    kind: kind ?? null,
    severity: severity ?? null,
    limit,
    cursor,
  })
  return c.json({ items: rows.map(toQueueItem), total, limit, nextCursor, hasMore })
})
```

- [ ] **Step 4: Import parseCursor at top of file**

```typescript
// Add to imports in src/api/documents.ts
import { parseCursor } from '../db/cursor'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/api/review-queue-cursor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/api/documents.ts tests/api/review-queue-cursor.test.ts
git commit -m "feat(phase3): update /review-queue route to use cursor pagination"
```

---

## Task 5: Update Console Client for Cursor Paging

**Files:**
- Modify: `console/lib/review.ts:52-57,110-111`
- Test: `console/tests/DocumentManagerCursorPaging.test.tsx`

**Interfaces:**
- Consumes: API response from Task 4
- Produces: Updated `ReviewQueueResponse` and `getReviewQueue` signature

- [ ] **Step 1: Write failing test for cursor in ReviewQueueResponse**

```typescript
// console/tests/DocumentManagerCursorPaging.test.tsx
import { describe, expect, it } from 'vitest'
import type { ReviewQueueResponse } from '../lib/review'

describe('ReviewQueueResponse', () => {
  it('includes nextCursor and hasMore, not offset', () => {
    const response: ReviewQueueResponse = {
      items: [],
      total: 0,
      limit: 50,
      nextCursor: null,
      hasMore: false,
    }
    expect(response).toHaveProperty('nextCursor')
    expect(response).toHaveProperty('hasMore')
    expect(response).not.toHaveProperty('offset')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console && npx vitest run tests/DocumentManagerCursorPaging.test.tsx`
Expected: FAIL (type error)

- [ ] **Step 3: Update ReviewQueueResponse interface**

```typescript
// In console/lib/review.ts:52-57
export interface ReviewQueueResponse {
  items: ReviewQueueItem[]
  total: number
  limit: number
  nextCursor: string | null
  hasMore: boolean
}
```

- [ ] **Step 4: Update getReviewQueue to accept cursor parameter**

```typescript
// In console/lib/review.ts:110-111
export const getReviewQueue = (query: string): Promise<ReviewQueueResponse> =>
  get<ReviewQueueResponse>(`/api/documents/review-queue${query}`)
```

No change needed to the function itself, but the query string will now include `cursor` instead of `offset`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd console && npx vitest run tests/DocumentManagerCursorPaging.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add console/lib/review.ts console/tests/DocumentManagerCursorPaging.test.tsx
git commit -m "feat(phase3): update console client for cursor pagination"
```

---

## Task 6: Update DocumentManager Component for Cursor Paging

**Files:**
- Modify: `console/components/DocumentManager.tsx`
- Test: `console/tests/DocumentManagerCursorPaging.test.tsx`

**Interfaces:**
- Consumes: Updated `getReviewQueue` from Task 5
- Produces: "Load more" button sends cursor, state management for cursor

- [ ] **Step 1: Write failing test for cursor state management**

```typescript
// Add to console/tests/DocumentManagerCursorPaging.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DocumentManager } from '../components/DocumentManager'
import * as reviewModule from '../lib/review'

describe('DocumentManager cursor paging', () => {
  it('sends cursor from last item when Load more clicked', async () => {
    const mockQueue = vi.spyOn(reviewModule, 'getReviewQueue')
      .mockResolvedValueOnce({
        items: [{ documentId: '1', title: 'Doc 1', kind: 'invoice', status: 'ready', confidence: 0.9, lowestFieldConfidence: 0.8, openErrors: 2, openWarnings: 1, reasons: [], createdAt: '2026-11-03 09:00:00+00' }],
        total: 2,
        limit: 1,
        nextCursor: 'cursor-1',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ documentId: '2', title: 'Doc 2', kind: 'invoice', status: 'ready', confidence: 0.9, lowestFieldConfidence: 0.8, openErrors: 1, openWarnings: 0, reasons: [], createdAt: '2026-11-03 10:00:00+00' }],
        total: 2,
        limit: 1,
        nextCursor: null,
        hasMore: false,
      })

    render(<DocumentManager kind="invoice" />)
    
    // Enter review mode
    fireEvent.click(screen.getByText('Review mode'))
    
    await waitFor(() => {
      expect(screen.getByText('Doc 1')).toBeTruthy()
    })
    
    // Click Load more
    fireEvent.click(screen.getByText('Load more'))
    
    await waitFor(() => {
      expect(mockQueue).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-1'))
    })
    
    mockQueue.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console && npx vitest run tests/DocumentManagerCursorPaging.test.tsx`
Expected: FAIL (no "Load more" button, no cursor state)

- [ ] **Step 3: Add cursor state to DocumentManager**

```typescript
// In console/components/DocumentManager.tsx, add state:
const [cursor, setCursor] = useState<string | null>(null)
const [hasMore, setHasMore] = useState(false)
```

- [ ] **Step 4: Update loadQueue function to use cursor**

```typescript
// Find the function that loads the queue and update:
async function loadQueue(resetCursor = false) {
  const query = '?limit=50' + (resetCursor || !cursor ? '' : '&cursor=' + cursor)
  const response = await getReviewQueue(query)
  if (resetCursor) {
    setQueue(response.items)
  } else {
    setQueue(prev => [...prev, ...response.items])
  }
  setCursor(response.nextCursor)
  setHasMore(response.hasMore)
}
```

- [ ] **Step 5: Add Load more button in review mode UI**

```typescript
// In the review mode section, add after the queue table:
{reviewMode && hasMore && (
  <button
    type="button"
    className="mt-2 text-sm underline"
    onClick={() => { void loadQueue(false) }}
    disabled={!hasMore}
  >
    Load more
  </button>
)}
```

- [ ] **Step 6: Reset cursor when entering review mode**

```typescript
// When toggling review mode:
function toggleReviewMode() {
  setReviewMode(prev => !prev)
  setCursor(null)
  setHasMore(false)
  if (!reviewMode) {
    void loadQueue(true)
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd console && npx vitest run tests/DocumentManagerCursorPaging.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add console/components/DocumentManager.tsx console/tests/DocumentManagerCursorPaging.test.tsx
git commit -m "feat(phase3): add Load more button with cursor pagination"
```

---

## Task 7: Add byCustomer Analytics Query

**Files:**
- Modify: `src/db/validation.ts:355-491`
- Create: `tests/helpers/analytics-seed.ts`
- Test: `tests/api/analytics-extended.test.ts`

**Interfaces:**
- Consumes: `AnalyticsWindow` from `src/db/validation.ts:321-327`
- Produces: `byCustomer` array in `ReviewAnalytics` response

- [ ] **Step 1: Create test helpers for analytics seeding**

```typescript
// tests/helpers/analytics-seed.ts
import { getDbClient } from '../../src/db/client'

export async function seedTenant(tenantId = 'test-tenant-id') {
  const client = getDbClient()
  await client.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'Test Tenant') ON CONFLICT (id) DO NOTHING`,
    [tenantId],
  )
  return tenantId
}

export async function seedCustomer({ name, tenantId = 'test-tenant-id' }: { name: string; tenantId?: string }) {
  const client = getDbClient()
  const id = crypto.randomUUID()
  await client.query(
    `INSERT INTO customers (id, tenant_id, name) VALUES ($1, $2, $3)`,
    [id, tenantId, name],
  )
  return { id, name }
}

export async function seedDocument({ customerId, kind, tenantId = 'test-tenant-id' }: { customerId: string | null; kind: 'invoice' | 'contract'; tenantId?: string }) {
  const client = getDbClient()
  const id = crypto.randomUUID()
  await client.query(
    `INSERT INTO documents (id, tenant_id, customer_id, kind, status, confidence, created_at) VALUES ($1, $2, $3, $4, 'ready', 0.9, NOW())`,
    [id, tenantId, customerId, kind],
  )
  return { id, kind }
}

export async function seedValidation({ documentId, status = 'open', tenantId = 'test-tenant-id' }: { documentId: string; status?: string; tenantId?: string }) {
  const client = getDbClient()
  const id = crypto.randomUUID()
  await client.query(
    `INSERT INTO document_validation (id, tenant_id, document_id, rule_id, field_name, severity, status, created_at) VALUES ($1, $2, $3, 'rule-1', 'field-1', 'error', $4, NOW())`,
    [id, tenantId, documentId, status],
  )
  return { id }
}

export async function seedInvoice({ documentId, vendorName, tenantId = 'test-tenant-id' }: { documentId: string; vendorName: string; tenantId?: string }) {
  const client = getDbClient()
  const id = crypto.randomUUID()
  await client.query(
    `INSERT INTO invoices (id, tenant_id, document_id, vendor_name, total_amount, currency, invoice_date) VALUES ($1, $2, $3, $4, '100.00', 'USD', NOW())`,
    [id, tenantId, documentId, vendorName],
  )
  return { id }
}

export async function seedAuditRow({ documentId, fieldName, changeSource = 'manual_correction', tenantId = 'test-tenant-id' }: { documentId: string; fieldName: string; changeSource?: string; tenantId?: string }) {
  const client = getDbClient()
  const id = crypto.randomUUID()
  await client.query(
    `INSERT INTO document_field_audit (id, tenant_id, document_id, table_name, field_name, action, old_value, new_value, changed_by, changed_at, change_source) VALUES ($1, $2, $3, 'invoices', $4, 'update', '"old"', '"new"', 'user-1', NOW(), $5)`,
    [id, tenantId, documentId, fieldName, changeSource],
  )
  return { id }
}
```

- [ ] **Step 2: Write failing test for byCustomer aggregate**

```typescript
// tests/api/analytics-extended.test.ts
import { describe, expect, it, beforeAll } from 'vitest'
import { app } from '../../src/api/app'
import { seedTenant, seedCustomer, seedDocument, seedValidation } from '../helpers/analytics-seed'

describe('byCustomer analytics', () => {
  beforeAll(async () => {
    await seedTenant()
    const customer1 = await seedCustomer({ name: 'Acme Corp' })
    const customer2 = await seedCustomer({ name: 'Globex' })
    
    // Create documents with findings
    const doc1 = await seedDocument({ customerId: customer1.id, kind: 'invoice' })
    const doc2 = await seedDocument({ customerId: customer1.id, kind: 'invoice' })
    const doc3 = await seedDocument({ customerId: customer2.id, kind: 'invoice' })
    
    await seedValidation({ documentId: doc1.id, status: 'open' })
    await seedValidation({ documentId: doc2.id, status: 'open' })
    await seedValidation({ documentId: doc3.id, status: 'open' })
  })

  it('returns top customers by finding count', async () => {
    const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.byCustomer).toHaveLength(2)
    expect(body.byCustomer[0].customer).toBe('Acme Corp')
    expect(body.byCustomer[0].documents).toBe(2)
    expect(body.byCustomer[0].documentsWithFindings).toBe(2)
    expect(body.byCustomer[0].totalFindings).toBe(2)
    expect(body.byCustomer[1].customer).toBe('Globex')
    expect(body.byCustomer[1].documents).toBe(1)
  })

  it('excludes documents without a customer', async () => {
    await seedDocument({ customerId: null, kind: 'invoice' })
    const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31')
    const body = await res.json()
    const totalDocs = body.byCustomer.reduce((sum: number, c: any) => sum + c.documents, 0)
    expect(totalDocs).toBe(3) // Not 4
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: FAIL (byCustomer property doesn't exist)

- [ ] **Step 3: Add byCustomer query to reviewAnalytics**

```typescript
// In src/db/validation.ts, inside reviewAnalytics function, add to Promise.all:
client.query<{ customer: string; documents: number; documents_with_findings: number; total_findings: number }>(
  `SELECT c.name AS customer,
          COUNT(DISTINCT d.id)::int AS documents,
          COUNT(DISTINCT v.document_id)::int AS documents_with_findings,
          COUNT(*)::int AS total_findings
     FROM documents d
     JOIN customers c ON c.id = d.customer_id
     LEFT JOIN document_validation v ON v.document_id = d.id AND v.tenant_id = d.tenant_id
    WHERE d.tenant_id = $1
      AND d.kind IN ('invoice', 'contract')
      AND ($4::text IS NULL OR d.kind = $4)
      AND d.created_at >= $2 AND d.created_at < $3
    GROUP BY c.id, c.name
    ORDER BY total_findings DESC, c.name
    LIMIT 10`,
  p,
),
```

- [ ] **Step 4: Add byCustomer to return object**

```typescript
// In the return statement of reviewAnalytics, add:
byCustomer: byCustomer.rows.map((r) => ({
  customer: r.customer,
  documents: r.documents,
  documentsWithFindings: r.documents_with_findings,
  totalFindings: r.total_findings,
})),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/validation.ts tests/api/analytics-extended.test.ts
git commit -m "feat(phase3): add byCustomer analytics aggregate"
```

---

## Task 8: Add byVendor Analytics Query

**Files:**
- Modify: `src/db/validation.ts`
- Test: `tests/api/analytics-extended.test.ts`

**Interfaces:**
- Consumes: `invoices` table with `vendor_name` column
- Produces: `byVendor` array in `ReviewAnalytics` response

- [ ] **Step 1: Write failing test for byVendor aggregate**

```typescript
// Add to tests/api/analytics-extended.test.ts
import { seedInvoice } from '../helpers/analytics-seed'

describe('byVendor analytics', () => {
  beforeAll(async () => {
    await seedTenant()
    const doc1 = await seedDocument({ kind: 'invoice' })
    const doc2 = await seedDocument({ kind: 'invoice' })
    const doc3 = await seedDocument({ kind: 'contract' }) // Should be excluded
    
    await seedInvoice({ documentId: doc1.id, vendorName: 'Vendor A' })
    await seedInvoice({ documentId: doc2.id, vendorName: 'Vendor A' })
    await seedInvoice({ documentId: doc3.id, vendorName: 'Vendor B' })
    
    await seedValidation({ documentId: doc1.id, status: 'open' })
    await seedValidation({ documentId: doc2.id, status: 'open' })
  })

  it('returns top vendors by finding count (invoices only)', async () => {
    const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31')
    const body = await res.json()
    expect(body.byVendor).toHaveLength(1)
    expect(body.byVendor[0].vendor).toBe('Vendor A')
    expect(body.byVendor[0].documents).toBe(2)
    expect(body.byVendor[0].totalFindings).toBe(2)
  })

  it('returns empty array when kind filter is contract', async () => {
    const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31&kind=contract')
    const body = await res.json()
    expect(body.byVendor).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: FAIL (byVendor property doesn't exist)

- [ ] **Step 3: Add byVendor query to reviewAnalytics**

```typescript
// In src/db/validation.ts, inside reviewAnalytics function, add to Promise.all:
client.query<{ vendor: string; documents: number; documents_with_findings: number; total_findings: number }>(
  `SELECT i.vendor_name AS vendor,
          COUNT(DISTINCT d.id)::int AS documents,
          COUNT(DISTINCT v.document_id)::int AS documents_with_findings,
          COUNT(*)::int AS total_findings
     FROM documents d
     JOIN invoices i ON i.document_id = d.id
     LEFT JOIN document_validation v ON v.document_id = d.id AND v.tenant_id = d.tenant_id
    WHERE d.tenant_id = $1
      AND d.kind = 'invoice'
      AND d.created_at >= $2 AND d.created_at < $3
    GROUP BY i.vendor_name
    ORDER BY total_findings DESC, i.vendor_name
    LIMIT 10`,
  p,
),
```

- [ ] **Step 4: Add byVendor to return object with kind filter logic**

```typescript
// In the return statement of reviewAnalytics, add:
byVendor: kind === 'contract' ? [] : byVendor.rows.map((r) => ({
  vendor: r.vendor,
  documents: r.documents,
  documentsWithFindings: r.documents_with_findings,
  totalFindings: r.total_findings,
})),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/validation.ts tests/api/analytics-extended.test.ts
git commit -m "feat(phase3): add byVendor analytics aggregate"
```

---

## Task 9: Add Heatmap Analytics Query

**Files:**
- Modify: `src/db/validation.ts`
- Test: `tests/api/analytics-extended.test.ts`

**Interfaces:**
- Consumes: `document_field_audit` table with `field_name` and `change_source` columns
- Produces: `heatmap` array in `ReviewAnalytics` response

- [ ] **Step 1: Write failing test for heatmap aggregate**

```typescript
// Add to tests/api/analytics-extended.test.ts
import { seedAuditRow } from '../helpers/analytics-seed'

describe('heatmap analytics', () => {
  beforeAll(async () => {
    await seedTenant()
    const doc1 = await seedDocument({ kind: 'invoice' })
    const doc2 = await seedDocument({ kind: 'contract' })
    
    await seedAuditRow({ documentId: doc1.id, fieldName: 'total_amount', changeSource: 'manual_correction' })
    await seedAuditRow({ documentId: doc1.id, fieldName: 'total_amount', changeSource: 'manual_correction' })
    await seedAuditRow({ documentId: doc1.id, fieldName: 'vendor_name', changeSource: 'manual_correction' })
    await seedAuditRow({ documentId: doc2.id, fieldName: 'total_amount', changeSource: 'manual_correction' })
  })

  it('returns top 20 field-kind combinations by correction count', async () => {
    const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31')
    const body = await res.json()
    expect(body.heatmap).toHaveLength(3)
    expect(body.heatmap[0]).toEqual({ kind: 'invoice', field: 'total_amount', corrections: 2 })
    expect(body.heatmap[1]).toEqual({ kind: 'invoice', field: 'vendor_name', corrections: 1 })
    expect(body.heatmap[2]).toEqual({ kind: 'contract', field: 'total_amount', corrections: 1 })
  })

  it('respects kind filter', async () => {
    const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31&kind=invoice')
    const body = await res.json()
    expect(body.heatmap.every((h: any) => h.kind === 'invoice')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: FAIL (heatmap property doesn't exist)

- [ ] **Step 3: Add heatmap query to reviewAnalytics**

```typescript
// In src/db/validation.ts, inside reviewAnalytics function, add to Promise.all:
client.query<{ kind: string; field: string; corrections: number }>(
  `SELECT d.kind,
          a.field_name,
          COUNT(*)::int AS corrections
     FROM document_field_audit a
     JOIN documents d ON d.id = a.document_id
    WHERE a.tenant_id = $1
      AND a.change_source = 'manual_correction'
      AND a.changed_at >= $2 AND a.changed_at < $3
      AND ($4::text IS NULL OR d.kind = $4)
    GROUP BY d.kind, a.field_name
    ORDER BY corrections DESC, d.kind, a.field_name
    LIMIT 20`,
  p,
),
```

- [ ] **Step 4: Add heatmap to return object**

```typescript
// In the return statement of reviewAnalytics, add:
heatmap: heatmap.rows.map((r) => ({
  kind: r.kind as 'invoice' | 'contract',
  field: r.field,
  corrections: r.corrections,
})),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/validation.ts tests/api/analytics-extended.test.ts
git commit -m "feat(phase3): add heatmap analytics aggregate"
```

---

## Task 10: Update ReviewAnalytics Type and API Response

**Files:**
- Modify: `console/lib/review.ts:80-88`
- Test: `tests/api/analytics-extended.test.ts`

**Interfaces:**
- Consumes: Backend queries from Tasks 7-9
- Produces: Updated `ReviewAnalytics` interface in console client

- [ ] **Step 1: Write failing test for new analytics fields**

```typescript
// Add to tests/api/analytics-extended.test.ts
it('returns all new analytics fields in response', async () => {
  const res = await app.request('/api/documents/analytics/review?from=2026-01-01&to=2026-12-31')
  const body = await res.json()
  expect(body).toHaveProperty('byCustomer')
  expect(body).toHaveProperty('byVendor')
  expect(body).toHaveProperty('heatmap')
  expect(Array.isArray(body.byCustomer)).toBe(true)
  expect(Array.isArray(body.byVendor)).toBe(true)
  expect(Array.isArray(body.heatmap)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/api/analytics-extended.test.ts`
Expected: PASS (backend already returns these fields)

- [ ] **Step 3: Update ReviewAnalytics interface in console client**

```typescript
// In console/lib/review.ts:80-88
export interface ReviewAnalytics {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
  byCustomer: Array<{ customer: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  byVendor: Array<{ vendor: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  heatmap: Array<{ kind: 'invoice' | 'contract'; field: string; corrections: number }>
}
```

- [ ] **Step 4: Commit**

```bash
git add console/lib/review.ts
git commit -m "feat(phase3): update ReviewAnalytics interface with new fields"
```

---

## Task 11: Add byCustomer and byVendor Tables to Console

**Files:**
- Modify: `console/components/ReviewAnalytics.tsx`
- Test: `console/tests/ReviewAnalyticsExtended.test.tsx`

**Interfaces:**
- Consumes: `byCustomer` and `byVendor` arrays from `ReviewAnalytics` type
- Produces: Two new table sections in the analytics panel

- [ ] **Step 1: Write failing test for new table sections**

```typescript
// console/tests/ReviewAnalyticsExtended.test.tsx
import { render, screen } from '@testing-library/react'
import { ReviewAnalytics } from '../components/ReviewAnalytics'
import type { ReviewAnalytics as Analytics } from '../lib/review'

describe('ReviewAnalytics extended tables', () => {
  const mockData: Analytics = {
    window: { from: '2026-01-01', to: '2026-12-31', days: 365 },
    byRule: [],
    topFields: [],
    bySource: [],
    correctionRate: { corrected: 0, documents: 0, rate: null },
    turnaround: { p50Hours: null, p90Hours: null },
    confidenceTrend: [],
    byCustomer: [
      { customer: 'Acme Corp', documents: 10, documentsWithFindings: 8, totalFindings: 15 },
      { customer: 'Globex', documents: 5, documentsWithFindings: 3, totalFindings: 7 },
    ],
    byVendor: [
      { vendor: 'Vendor A', documents: 8, documentsWithFindings: 6, totalFindings: 12 },
    ],
    heatmap: [],
  }

  it('renders By customer table', () => {
    render(<ReviewAnalytics kind={null} />)
    // Mock the fetch to return mockData
    // ...
    expect(screen.getByText('By customer')).toBeTruthy()
    expect(screen.getByText('Acme Corp')).toBeTruthy()
    expect(screen.getByText('Globex')).toBeTruthy()
  })

  it('renders By vendor table', () => {
    render(<ReviewAnalytics kind="invoice" />)
    expect(screen.getByText('By vendor')).toBeTruthy()
    expect(screen.getByText('Vendor A')).toBeTruthy()
  })

  it('renders No data when arrays are empty', () => {
    const emptyData = { ...mockData, byCustomer: [], byVendor: [] }
    render(<ReviewAnalytics kind={null} />)
    // Expect "No data" messages
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console && npx vitest run tests/ReviewAnalyticsExtended.test.tsx`
Expected: FAIL (tables don't exist)

- [ ] **Step 3: Add By customer table section**

```typescript
// In console/components/ReviewAnalytics.tsx, after the existing tables:
<div className="grid gap-4 md:grid-cols-2">
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">By customer</caption>
      <tbody>
        {data.byCustomer.length === 0 ? (
          <tr><td className="py-1 text-text-muted">No data</td></tr>
        ) : (
          data.byCustomer.map((c) => (
            <tr key={c.customer}>
              <td className="py-1">{c.customer}</td>
              <td className="py-1 text-right tabular-nums">{c.documents} docs</td>
              <td className="py-1 text-right text-text-muted">{c.documentsWithFindings} with findings</td>
              <td className="py-1 text-right tabular-nums">{c.totalFindings} findings</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>

  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">By vendor</caption>
      <tbody>
        {data.byVendor.length === 0 ? (
          <tr><td className="py-1 text-text-muted">No data</td></tr>
        ) : (
          data.byVendor.map((v) => (
            <tr key={v.vendor}>
              <td className="py-1">{v.vendor}</td>
              <td className="py-1 text-right tabular-nums">{v.documents} docs</td>
              <td className="py-1 text-right text-text-muted">{v.documentsWithFindings} with findings</td>
              <td className="py-1 text-right tabular-nums">{v.totalFindings} findings</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console && npx vitest run tests/ReviewAnalyticsExtended.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add console/components/ReviewAnalytics.tsx console/tests/ReviewAnalyticsExtended.test.tsx
git commit -m "feat(phase3): add byCustomer and byVendor tables to analytics panel"
```

---

## Task 12: Add Heatmap Grid to Console

**Files:**
- Modify: `console/components/ReviewAnalytics.tsx`
- Test: `console/tests/ReviewAnalyticsExtended.test.tsx`

**Interfaces:**
- Consumes: `heatmap` array from `ReviewAnalytics` type
- Produces: CSS grid with color-coded cells

- [ ] **Step 1: Write failing test for heatmap grid**

```typescript
// Add to console/tests/ReviewAnalyticsExtended.test.tsx
it('renders heatmap grid with color-coded cells', () => {
  const dataWithHeatmap = {
    ...mockData,
    heatmap: [
      { kind: 'invoice', field: 'total_amount', corrections: 10 },
      { kind: 'invoice', field: 'vendor_name', corrections: 5 },
      { kind: 'contract', field: 'total_amount', corrections: 3 },
    ],
  }
  render(<ReviewAnalytics kind={null} />)
  expect(screen.getByText('Field correction heatmap')).toBeTruthy()
  const cells = screen.getAllByTestId('heatmap-cell')
  expect(cells.length).toBe(3)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console && npx vitest run tests/ReviewAnalyticsExtended.test.tsx`
Expected: FAIL (heatmap doesn't exist)

- [ ] **Step 3: Add heatmap section**

```typescript
// In console/components/ReviewAnalytics.tsx, after the byCustomer/byVendor tables:
<div className="overflow-x-auto">
  <table className="w-full text-sm">
    <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">Field correction heatmap</caption>
    <tbody>
      {data.heatmap.length === 0 ? (
        <tr><td className="py-1 text-text-muted">No data</td></tr>
      ) : (
        data.heatmap.map((h, i) => {
          const maxCorrections = Math.max(...data.heatmap.map(x => x.corrections))
          const intensity = maxCorrections > 0 ? (h.corrections / maxCorrections) * 100 : 0
          return (
            <tr key={i}>
              <td className="py-1">{h.kind}</td>
              <td className="py-1">{h.field}</td>
              <td className="py-1">
                <span
                  data-testid="heatmap-cell"
                  className="inline-block rounded px-2 py-1 text-right tabular-nums"
                  style={{
                    backgroundColor: `rgba(59, 130, 246, ${intensity / 100})`,
                    minWidth: '60px',
                  }}
                >
                  {h.corrections}
                </span>
              </td>
            </tr>
          )
        })
      )}
    </tbody>
  </table>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console && npx vitest run tests/ReviewAnalyticsExtended.test.tsx`
Expected: PASS

- [ ] **Step 5: Run style contract test**

Run: `cd console && npx vitest run tests/styles-contract.test.ts`
Expected: PASS (all tables have overflow-x-auto wrapper)

- [ ] **Step 6: Commit**

```bash
git add console/components/ReviewAnalytics.tsx console/tests/ReviewAnalyticsExtended.test.tsx
git commit -m "feat(phase3): add heatmap grid to analytics panel"
```

---

## Task 13: End-to-End Verification

**Files:**
- None (verification task)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Verification that cursor paging and extended analytics work together

- [ ] **Step 1: Run all backend tests**

Run: `npx vitest run tests/db/cursor.test.ts tests/db/validation.test.ts tests/api/review-queue-cursor.test.ts tests/api/analytics-extended.test.ts`
Expected: All PASS

- [ ] **Step 2: Run all console tests**

Run: `cd console && npx vitest run tests/DocumentManagerCursorPaging.test.tsx tests/ReviewAnalyticsExtended.test.tsx tests/styles-contract.test.ts`
Expected: All PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run lint**

Run: `npx eslint src/db/cursor.ts src/db/validation.ts src/api/documents.ts console/lib/review.ts console/components/ReviewAnalytics.tsx console/components/DocumentManager.tsx --no-ignore`
Expected: No errors

- [ ] **Step 5: Manual test cursor paging**

Start the dev server and navigate to the review queue. Verify:
- First page loads without cursor
- "Load more" button appears when hasMore is true
- Clicking "Load more" appends results without duplicates
- Cursor resets when toggling review mode

- [ ] **Step 6: Manual test extended analytics**

Navigate to the analytics panel. Verify:
- "By customer" table shows top customers
- "By vendor" table shows top vendors (invoices only)
- Heatmap shows field corrections with color intensity
- Empty arrays show "No data"
- All tables have horizontal scroll on narrow screens

- [ ] **Step 7: Commit verification**

```bash
git add -A
git commit -m "feat(phase3): end-to-end verification complete"
```

---

## Summary

**Total tasks:** 13
**Estimated time:** 4-6 hours
**Key deliverables:**
1. Cursor parsing/generation utilities with full test coverage
2. Dynamic WHERE clause builder for keyset pagination
3. Updated reviewQueue function with cursor support
4. Updated /review-queue API route
5. Updated console client for cursor paging
6. Updated DocumentManager with "Load more" button
7. byCustomer analytics query
8. byVendor analytics query
9. Heatmap analytics query
10. Updated ReviewAnalytics type
11. byCustomer and byVendor tables in console
12. Heatmap grid in console
13. End-to-end verification

**Deferred (per spec):**
- byModel aggregate (blocked by documents.model_id tracking)
- Materialized views for analytics optimization
- Cursor paging composite index

**Next step:** Choose execution approach (subagent-driven recommended).
