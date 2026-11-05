# Phase 3: Cursor Paging and Extended Analytics

**Date:** 2026-11-05  
**Status:** Draft  
**Phase:** Field-audit Phase 3

## Overview

Phase 2 shipped the review queue with offset-based pagination and six analytics aggregate keys. Phase 3 extends both:

1. **Cursor paging** replaces offset pagination in the review queue to handle large datasets efficiently
2. **Extended analytics** adds four new aggregate dimensions: byCustomer, byVendor, byModel, and a field-correction heatmap

Both features are backward-compatible at the database layer; the API contract changes are breaking for console clients but can be versioned or rolled out with a feature flag if needed.

---

## 1. Cursor Paging for Review Queue

### 1.1 Problem

Offset-based pagination (`LIMIT 50 OFFSET 100`) degrades as the offset grows:
- The database must scan and discard 100 rows before returning 50
- For a queue of 10,000 documents at page 200, the query scans 10,000 rows to return 50
- Row insertions/deletions between pages cause items to be skipped or duplicated

### 1.2 Solution: Keyset Pagination

Use the ORDER BY columns as the cursor. The client sends the last row's values; the query filters to rows "after" that position.

**Current ORDER BY:**
```sql
ORDER BY open_errors DESC, lowest_field_confidence ASC NULLS LAST, created_at ASC, id ASC
```

**Cursor format:** `open_errors|lowest_field_confidence|created_at|id`  
**Example:** `5|0.2|2026-11-03T09:00:00.000Z|a1b2c3d4-...`

### 1.3 API Contract

**Request:**
```
GET /api/documents/review-queue?limit=50&cursor=5|0.2|2026-11-03T09:00:00.000Z|a1b2c3d4-...
```

- `limit` (optional, default 50, max 200): page size
- `cursor` (optional): opaque string encoding the last row's sort key values
- `kind` (optional): filter by document kind
- `severity` (optional): filter by finding severity

**Response:**
```json
{
  "items": [...],
  "nextCursor": "3|0.4|2026-11-03T10:00:00.000Z|e5f6g7h8-...",
  "hasMore": true,
  "total": 1234
}
```

- `items`: array of ReviewQueueItem (unchanged)
- `nextCursor`: cursor for the next page, or `null` if `hasMore` is false
- `hasMore`: boolean indicating if more pages exist
- `total`: total count of matching documents (unchanged, expensive but required for the UI)

**Breaking change:** `offset` parameter is removed. `nextCursor` replaces it. Console clients must be updated together with the backend.

### 1.4 Database Query

**Current query (offset-based):**
```sql
SELECT ... FROM documents d
WHERE <visibility> AND <filters>
ORDER BY open_errors DESC, lowest_field_confidence ASC NULLS LAST, created_at ASC, id ASC
LIMIT $limit OFFSET $offset
```

**New query (cursor-based):**
```sql
SELECT ... FROM documents d
WHERE <visibility> AND <filters>
  AND (
    -- First page: no cursor condition
    -- Subsequent pages: row is "after" the cursor in the ORDER BY sequence
    -- ORDER BY: open_errors DESC, lowest_field_confidence ASC NULLS LAST, created_at ASC, id ASC
    ($cursor IS NULL) OR  -- first page
    (open_errors < $cursor_open_errors) OR  -- lower open_errors comes later in DESC
    (open_errors = $cursor_open_errors AND (
      (lowest_field_confidence IS NOT NULL AND $cursor_lowest_confidence IS NULL) OR  -- non-null comes before null (NULLS LAST)
      (lowest_field_confidence IS NOT NULL AND $cursor_lowest_confidence IS NOT NULL AND lowest_field_confidence > $cursor_lowest_confidence) OR  -- higher confidence comes later in ASC
      (lowest_field_confidence IS NULL AND $cursor_lowest_confidence IS NULL AND (
        (created_at > $cursor_created_at) OR
        (created_at = $cursor_created_at AND id > $cursor_id)
      ))
    ))
  )
ORDER BY open_errors DESC, lowest_field_confidence ASC NULLS LAST, created_at ASC, id ASC
LIMIT $limit
```

**Simplification:** The nested NULL logic is verbose. In practice, the route builds the WHERE clause dynamically:
- If `cursor` is null/undefined: no cursor condition (first page)
- If `cursor` is present: build the keyset condition with explicit NULL checks based on the cursor's parsed values

**Cursor parsing:** The route parses the cursor string into four typed values:
```typescript
function parseCursor(cursor: string): { openErrors: number; lowestConfidence: number | null; createdAt: Date; id: string } | null
```

Returns `null` if the cursor is malformed; the route returns 400 in that case.

**Cursor generation:** The route generates `nextCursor` from the last item in the response:
```typescript
function generateCursor(item: ReviewQueueItem): string {
  return `${item.openErrors}|${item.lowestFieldConfidence ?? 'null'}|${item.createdAt}|${item.documentId}`
}
```

### 1.5 NULL Handling

`lowest_field_confidence` can be `null` in the database (documents with no field-level confidence). The ORDER BY uses `NULLS LAST`, so nulls sort after all non-null values.

**Cursor value vs database column:**
- The cursor encodes the actual value from the last row: either a number (e.g., `0.42`) or the literal string `null`
- When parsing the cursor, `parseCursor` returns `{ lowestConfidence: number | null }`
- When building the WHERE clause, the route checks whether the cursor's `lowestConfidence` is null and generates the appropriate SQL condition

**Keyset logic for ASC NULLS LAST:**
- Non-null values come first (ordered ASC), then null values
- If cursor's `lowestConfidence` is non-null: match rows where `lowest_field_confidence > cursor OR lowest_field_confidence IS NULL`
- If cursor's `lowestConfidence` is null: match rows where `lowest_field_confidence IS NULL` (only nulls come after nulls)

This is verbose but necessary for correct pagination.

### 1.6 Performance

**Index requirement:** The query benefits from an index on `(tenant_id, open_errors DESC, lowest_field_confidence ASC NULLS LAST, created_at ASC, id ASC)`. However, `open_errors` and `lowest_field_confidence` are computed columns (from the findings aggregate and field_confidence jsonb), so a materialized view or generated columns may be needed.

**Fallback:** If the index is not present, the query still works but scans more rows. Phase 3 does not require the index; it can be added in a follow-up if performance is insufficient.

### 1.7 Console Client Changes

**`console/lib/review.ts`:**
- `getReviewQueue` signature changes: `cursor?: string` parameter added, `offset` removed
- Return type changes: `nextCursor` and `hasMore` added, `offset` removed

**`console/components/DocumentManager.tsx`:**
- Review mode state: replace `offset` with `cursor`
- "Load more" button: sends `cursor` from the last item, appends results
- Reset to first page: sends no cursor

### 1.8 Migration Strategy

**Option A: Breaking change** — remove `offset` parameter, add `cursor`. Console and backend deploy together.

**Option B: Versioned** — add `/review-queue/v2` with cursor support, deprecate v1 after console migration.

**Recommendation:** Option A. The console is the only client, and both are in the same repo. A coordinated deploy is simpler than maintaining two versions.

### 1.9 Transition from Offset to Cursor

**Existing bookmarks:** Users with bookmarked URLs containing `?offset=100` will have the offset parameter ignored after the deploy. The console will treat it as the first page (no cursor).

**In-flight requests:** If a user loads the page with an old console client (cached JS), the backend will receive `offset` and ignore it, returning the first page. The user sees stale data but no error. A hard refresh loads the new console code.

**Database migration:** No schema changes required. The `documents` table already has the columns used in the cursor.

---

## 2. Extended Analytics

### 2.1 Problem

The current analytics panel shows six aggregate keys:
- `byRule`: findings per validation rule
- `topFields`: most-corrected fields
- `bySource`: changes per source (extraction, manual_correction, etc.)
- `correctionRate`: fraction of documents corrected
- `turnaround`: p50/p90 hours from creation to first correction
- `confidenceTrend`: per-week average confidence and correction rate

Missing dimensions:
- **byCustomer**: which customers have the most findings/corrections?
- **byVendor**: which vendors have the most findings/corrections?
- **byModel**: which OCR model produced the most findings? (requires `documents.model_id` tracking)
- **Heatmap**: which fields are corrected most often, cross-tabulated by document kind?

### 2.2 New Aggregate Keys

#### 2.2.1 byCustomer

**Query:**
```sql
SELECT c.name AS customer, 
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
 LIMIT 10
```

**Response shape:**
```typescript
byCustomer: Array<{
  customer: string
  documents: number
  documentsWithFindings: number
  totalFindings: number
}>
```

**Note:** `documents.customer_id` is nullable (ON DELETE SET NULL). Documents without a customer are excluded from this aggregate. If this is a problem, add a "no customer" bucket.

#### 2.2.2 byVendor

**Query:**
```sql
SELECT i.vendor_name AS vendor,
       COUNT(DISTINCT d.id)::int AS documents,
       COUNT(DISTINCT v.document_id)::int AS documents_with_findings,
       COUNT(*)::int AS total_findings
  FROM documents d
  JOIN invoices i ON i.document_id = d.id
  LEFT JOIN document_validation v ON v.document_id = d.id AND v.tenant_id = d.tenant_id
 WHERE d.tenant_id = $1
   AND d.kind = 'invoice'
   AND ($4::text IS NULL OR $4 = 'invoice')
   AND d.created_at >= $2 AND d.created_at < $3
 GROUP BY i.vendor_name
 ORDER BY total_findings DESC, i.vendor_name
 LIMIT 10
```

**Response shape:**
```typescript
byVendor: Array<{
  vendor: string
  documents: number
  documentsWithFindings: number
  totalFindings: number
}>
```

**Note:** Only applies to invoices (contracts have no `vendor_name`). For contracts, return an empty array or a separate `byCounterparty` aggregate if contracts have a counterparty field.

#### 2.2.3 byModel

**Prerequisite:** `documents.model_id` must track which OCR model processed the document. This is not currently implemented (Phase 1 deferred it).

**If `model_id` exists:**
```sql
SELECT m.name AS model,
       COUNT(DISTINCT d.id)::int AS documents,
       COUNT(DISTINCT v.document_id)::int AS documents_with_findings,
       COUNT(*)::int AS total_findings
  FROM documents d
  JOIN ocr_models m ON m.id = d.model_id
  LEFT JOIN document_validation v ON v.document_id = d.id AND v.tenant_id = d.tenant_id
 WHERE d.tenant_id = $1
   AND d.kind IN ('invoice', 'contract')
   AND ($4::text IS NULL OR d.kind = $4)
   AND d.created_at >= $2 AND d.created_at < $3
 GROUP BY m.id, m.name
 ORDER BY total_findings DESC, m.name
```

**If `model_id` does not exist:** Return `byModel: []` and log a warning. Document this as a deferred dependency.

**Recommendation:** Defer `byModel` until `documents.model_id` is implemented. Include it in the spec but mark it as "blocked by model tracking".

#### 2.2.4 Heatmap (field corrections by document kind)

**Query:**
```sql
SELECT d.kind,
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
 LIMIT 20
```

**Response shape:**
```typescript
heatmap: Array<{
  kind: 'invoice' | 'contract'
  field: string
  corrections: number
}>
```

**Console rendering:** A 2D grid with `kind` on one axis and `field` on the other, cell color intensity proportional to `corrections`. Use CSS grid + background color. Limited to top 20 combinations per D3.

### 2.3 API Response

**Updated `ReviewAnalytics` type:**
```typescript
interface ReviewAnalytics {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
  // New:
  byCustomer: Array<{ customer: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  byVendor: Array<{ vendor: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  byModel: Array<{ model: string; documents: number; documentsWithFindings: number; totalFindings: number }> // empty if model_id not tracked
  heatmap: Array<{ kind: 'invoice' | 'contract'; field: string; corrections: number }>
}
```

### 2.4 Console Panel

**`console/components/ReviewAnalytics.tsx`:**
- Add three new table sections: "By customer", "By vendor", "By model"
- Add a heatmap section: grid with kind × field, color-coded cells
- Each section is collapsible (default: collapsed for new sections, expanded for existing)
- Empty arrays render as "No data" instead of an empty table

### 2.5 Performance

The new aggregates add 3-4 more queries to the analytics endpoint (depending on whether `byModel` is implemented). All queries are window-scoped and tenant-scoped, so they should be fast for typical tenants.

**Optimization:** If the analytics endpoint becomes slow, consider:
1. Materialized views for the aggregates (refresh every N minutes)
2. Caching the response for a given (tenant, window, kind) tuple
3. Lazy-loading the new sections in the console (fetch on expand)

Phase 3 does not require optimization; it can be added in a follow-up if needed.

---

## 3. Testing Strategy

### 3.1 Cursor Paging

**Backend tests (`tests/api/review-queue-cursor.test.ts`):**
- First page (no cursor) returns the first N items
- Second page (cursor from last item of first page) returns the next N items, no overlap
- Last page (cursor from last item of second-to-last page) returns fewer than N items, `hasMore: false`
- Malformed cursor returns 400
- Cursor with null `lowest_field_confidence` works correctly
- Insertions between pages do not cause duplicates or skips (seed 100 items, fetch page 1, insert 10 items with higher priority, fetch page 2, verify no duplicates)

**Console tests (`console/tests/DocumentManagerCursorPaging.test.tsx`):**
- "Load more" button sends cursor from last item
- Reset to first page clears cursor
- Empty queue renders "No documents need review"

### 3.2 Extended Analytics

**Backend tests (`tests/api/analytics-extended.test.ts`):**
- `byCustomer` returns top 10 customers by finding count
- `byVendor` returns top 10 vendors by finding count (invoices only)
- `byModel` returns empty array if `model_id` not tracked
- `heatmap` returns top 20 field corrections cross-tabulated by kind
- All aggregates respect the window filter
- All aggregates respect the kind filter

**Console tests (`console/tests/ReviewAnalyticsExtended.test.tsx`):**
- New sections render with data
- Empty arrays render as "No data"
- Heatmap cells are color-coded by correction count (top 20 combinations)

---

## 4. Implementation Order

1. **Cursor paging backend** — modify `reviewQueue` function and `/review-queue` route
2. **Cursor paging tests** — backend and console
3. **Cursor paging console** — update `getReviewQueue` and `DocumentManager`
4. **Extended analytics backend** — add 3-4 new queries to `reviewAnalytics`
5. **Extended analytics tests** — backend and console
6. **Extended analytics console** — update `ReviewAnalytics` component

Steps 1-3 and 4-6 are independent and can be done in parallel or sequentially.

---

## 5. Deferred Items

- **Model tracking (`documents.model_id`):** Required for `byModel` aggregate. Deferred until Phase 4 or when OCR model tracking is prioritized.
- **Materialized views for analytics:** Optimization for large tenants. Deferred until performance is measured as a problem.
- **Contract-specific vendor aggregate (`byCounterparty`):** Requires defining what "vendor" means for contracts. Deferred until contract review workflow is clarified.
- **Cursor paging index:** Composite index on sort columns. Deferred until performance is measured as a problem.

---

## 6. Rulings

**R30 (cursor format):** Keyset pagination with readable cursor, not opaque token. Cost if wrong: debuggability suffers, but the API is still correct.

**R31 (cursor NULL handling):** Explicit NULL checks in cursor condition, not COALESCE. Cost if wrong: pagination skips or duplicates rows with NULL sort keys.

**R32 (breaking change):** Remove `offset` parameter, do not version the API. Cost if wrong: console and backend must deploy together, but the codebase stays simple.

**R33 (byCustomer scope):** Exclude documents without a customer. Cost if wrong: "no customer" bucket is missing, but most documents have a customer.

**R34 (byVendor scope):** Only apply to invoices. Cost if wrong: contracts show empty `byVendor`, but contracts have no vendor field.

**R35 (byModel deferral):** Return empty array if `model_id` not tracked. Cost if wrong: feature is incomplete, but it does not block the other aggregates.

**R36 (heatmap rendering):** CSS grid with color-coded cells, not a chart library. Cost if wrong: visual polish is lower, but no new dependency is added.

---

## 7. Success Criteria

1. Review queue pagination works correctly for 10,000+ documents without performance degradation
2. Analytics panel shows customer, vendor, and heatmap dimensions
3. All new features have backend and console tests
4. No regression in existing review queue or analytics functionality

---

## 8. Decisions

**D1 (cursor format):** Readable string, not base64-encoded. Rationale: debuggability; the API is internal to the console.

**D2 (byCustomer null handling):** Exclude documents without a customer. Rationale: most documents have a customer; a "no customer" bucket adds complexity without much value.

**D3 (heatmap granularity):** Top 20 field-kind combinations. Rationale: balances completeness with visual clarity; the LIMIT prevents rendering hundreds of rows.

**D4 (performance budget):** Analytics endpoint should respond in < 2 seconds for typical tenants. Rationale: acceptable for an admin dashboard; can be optimized later with materialized views if needed.

**D5 (total count in cursor paging):** Keep the `total` field in the response. Rationale: the console shows "X of Y documents" and removing it would break the UI; the COUNT query is acceptable for typical queue sizes.

---

**Next step:** Review this spec, approve or request changes, then transition to implementation planning.
