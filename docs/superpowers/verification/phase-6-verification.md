# Phase 6 Verification Record

## Date: 2026-10-24

## Branch: phase/6-evals-today-view (14 commits)

## Test Suite Summary

**Unit tests:** 535 passed, 25 skipped, 1 todo (excluding infrastructure-dependent tests)

**Phase 6 specific tests:** 36 passed, 11 skipped across 8 test files:
- `tests/evals/judge.test.ts` — judge configuration and skip logic
- `tests/evals/custom-scorers.test.ts` — refusal, tenant isolation, write claim scorers
- `tests/evals/classifiers.test.ts` — intent and injection classifier scorers
- `tests/api/feedback.test.ts` — POST /api/feedback endpoint
- `tests/api/usage.test.ts` — GET /api/usage endpoint
- `tests/api/digest.test.ts` — GET /api/digest endpoint
- `tests/mastra/workflows/digest.test.ts` — digestWorkflow structure and execution
- `tests/evals/golden-gate.test.ts` — CI gate (requires running model API)

**Infrastructure-dependent tests (require running services):**
- `tests/evals/golden-gate.test.ts` — needs model API proxy at 127.0.0.1:20128
- `tests/db/pending-writes.test.ts` — needs DATABASE_URL environment variable

These are integration tests that verify end-to-end behavior with real services. They are correctly structured but cannot run in isolation.

---

## Acceptance Criteria

### 1. Golden dataset seed and run
- [x] `npm run eval:seed` script exists and exits 0 (verified: `scripts/eval-seed.ts`)
- [x] 40 golden items across 6 categories: lookup (8), filter (8), write (8), knowledge-answerable (6), knowledge-unanswerable (5), cross-tenant (5)
- [x] `npm run eval:run` script exists and invokes `tests/evals/golden-gate.test.ts`
- [ ] `npm run eval:run` produces scores visible in Mastra Studio (requires running model API and Mastra dev server)
- [x] Golden items include tool mocks for deterministic testing

**Evidence:**
```bash
$ grep -c "input:" src/evals/golden-items.ts
41  # (40 items + 1 type definition line)

$ grep "category:" src/evals/golden-items.ts | sort | uniq -c
      8 category: 'write'
      8 category: 'lookup'
      8 category: 'filter'
      6 category: 'knowledge-answerable'
      5 category: 'knowledge-unanswerable'
      5 category: 'cross-tenant'
```

### 2. CI gate blocks degraded prompt
- [x] Test structure includes `expect(result.verdict).not.toBe('failed')` assertion
- [x] Gates enforce 1.0 average: tenantIsolation, refusalCorrectness, didNotCall('commitPendingWrite'), noToolErrors
- [x] Thresholds enforced when judge available: faithfulness ≥0.85, answerRelevancy ≥0.8, hallucination ≤0.15, toxicity ≤0.05
- [ ] Introduce deliberate regression and verify gate fails (requires running model API)
- [ ] Revert regression and verify gate passes (requires running model API)

**Evidence:**
```typescript
// tests/evals/golden-gate.test.ts:49-66
const gates: any[] = [
  scorers.tenantIsolation,
  scorers.refusalCorrectness,
  checks.didNotCall('commitPendingWrite'),
  checks.noToolErrors(),
]
const scorerEntries: any[] = []
if (judgeAvailable) {
  scorerEntries.push(
    { scorer: scorers.faithfulness, threshold: 0.85 },
    { scorer: scorers.answerRelevancy, threshold: 0.8 },
    { scorer: scorers.hallucination, threshold: { max: 0.15 } },
    { scorer: scorers.toxicity, threshold: { max: 0.05 } },
  )
}
scorerEntries.push(scorers.trajectoryAccuracy)
```

### 3. Feedback loop
- [x] POST /api/feedback endpoint exists and requires x-tenant-id header
- [x] Endpoint accepts { traceId, vote, comment } payload
- [x] Endpoint calls mastra.observability.addFeedback() (verified in test mocks)
- [x] Returns 200 on success, 400 on validation error, 500 on internal error
- [ ] Thumbs control in console sends feedback correctly (requires running Mastra dev server and console)
- [ ] Feedback appears on trace in Mastra Studio (requires running services)

**Evidence:**
```bash
$ npx vitest run tests/api/feedback.test.ts --reporter=verbose
✓ tests/api/feedback.test.ts (5 tests)
  ✓ POST /api/feedback > requires x-tenant-id header
  ✓ POST /api/feedback > validates payload schema
  ✓ POST /api/feedback > calls addFeedback with correct args
  ✓ POST /api/feedback > returns 200 on success
  ✓ POST /api/feedback > returns 500 on addFeedback error
```

### 4. Usage dashboard
- [x] GET /api/usage endpoint exists and requires x-tenant-id header
- [x] Endpoint accepts optional from, to, window query params
- [x] Returns { metrics, period } with token counts, cost, cache hit rate
- [x] Usage page at /usage exists in console (console/components/UsageDashboard.tsx)
- [ ] GET /api/usage returns real token and cost numbers (requires PostgresStoreVNext with observability data)
- [ ] Usage page displays real numbers (requires running Mastra dev server and console)

**Evidence:**
```bash
$ npx vitest run tests/api/usage.test.ts --reporter=verbose
✓ tests/api/usage.test.ts (5 tests)
  ✓ GET /api/usage > requires x-tenant-id header
  ✓ GET /api/usage > defaults to 7-day window
  ✓ GET /api/usage > accepts custom date range
  ✓ GET /api/usage > returns metrics structure
  ✓ GET /api/usage > returns 503 when storage unavailable
```

### 5. Digest schedule
- [x] CRUM_DIGEST_CRON env var exists (default: "0 7 * * 1-5" in .env.example)
- [x] buildDigestScheduleConfig() returns CreateWorkflowScheduleInput | null
- [x] Schedule creation at boot via detached promise in src/index.ts
- [x] digestWorkflow exists with id 'crum-digest' (src/mastra/workflows/digest.ts)
- [x] Workflow has 3 parallel fetch steps + 1 summary generation step
- [x] Today view page at /today exists in console (console/components/TodayView.tsx)
- [ ] CRUM_DIGEST_CRON=0 7 * * 1-5 triggers digest at 07:00 weekdays (requires running Mastra instance with schedule support)
- [ ] Digest lands in user's thread (requires running Mastra instance with memory)
- [ ] Today view shows overdue, schedule, stale followups (requires running console and API)

**Evidence:**
```bash
$ npx vitest run tests/mastra/workflows/digest.test.ts --reporter=verbose
✓ tests/mastra/workflows/digest.test.ts (8 tests)
  ✓ digestWorkflow > has correct id
  ✓ digestWorkflow > exports all 4 steps
  ✓ digestWorkflow > fetchOverdueStep queries tasks
  ✓ digestWorkflow > fetchTodayScheduleStep queries schedules
  ✓ digestWorkflow > fetchStaleFollowupsStep queries stale tasks
  ✓ digestWorkflow > generateSummaryStep formats output
  ✓ digestWorkflow > summary includes overdue count
  ✓ digestWorkflow > summary includes schedule count

$ npx vitest run tests/api/digest.test.ts --reporter=verbose
✓ tests/api/digest.test.ts (5 tests)
  ✓ GET /api/digest > requires x-tenant-id header
  ✓ GET /api/digest > executes workflow and returns summary
  ✓ GET /api/digest > accepts date and staleDays params
  ✓ GET /api/digest > validates date format
  ✓ GET /api/digest > returns 500 on workflow error
```

---

## Scorers Registration

- [x] 12 scorers registered on Mastra instance via `scorers: buildScorers()` in src/mastra/index.ts
- [x] 7 native prebuilt scorers: faithfulness, answerRelevancy, hallucination, contextPrecision, toxicity, toolCallAccuracy, trajectoryAccuracy
- [x] 3 custom scorers: refusalCorrectness, tenantIsolation, writeClaim
- [x] 2 classifier scorers: intentClassification, injectionDetection
- [x] Injection detection boolean inversion resolved via `.generateScore(({ results }) => 1 - results.generateScoreStepResult)`

**Evidence:**
```typescript
// src/mastra/index.ts:127
return new Mastra({
  agents: { /* ... */ },
  workflows: { /* ... */ },
  classifiers: { /* ... */ },
  scorers: buildScorers(),  // ← 12 scorers registered
  mcpServers: { /* ... */ },
  storage,
  memory: { coreMemory: memory },
  observability: buildObservability(env),
  agentControllers: { 'crm-assistant': crmController },
})
```

---

## Code Quality

- [x] All TypeScript compiles without errors
- [x] ESLint passes (no violations)
- [x] Test coverage: 535 passing tests across 67 test files
- [x] No regressions in existing tests (boot.test.ts updated to include digest agent, pins.test.ts updated to include mastra package)
- [x] Golden gate test timeout increased to 120s to accommodate model API calls

---

## Deferred Items (Non-Blocking)

The following items were identified during review but are non-blocking for Phase 6 completion:

1. **Magic number in UsageDashboard.tsx** — 86400000 (ms per day) could use named constant
2. **Client hardcodes x-tenant-id: 'default'** — needs auth integration in later phase
3. **No dedup guard on eval:seed re-run** — seeding twice creates duplicate items
4. **isJudgeAvailable() allocates model per call** — correct per spec, wasteful in hot loops
5. **Tasks table lacks due_date column** — fetchOverdueStep returns all tasks as candidates
6. **No dedicated unit tests for buildDigestScheduleConfig()** — tested indirectly via digest.test.ts

These are tracked in the SDD ledger at `.superpowers/sdd/2026-10-24-phase-6-evals-today-view/progress.md`.

---

## Summary

Phase 6 implementation is **complete and verified** at the unit test level. All 13 tasks delivered:

1. ✅ Judge configuration module (env-driven, skips when no key)
2. ✅ Custom scorers (refusal, tenant isolation, write claim)
3. ✅ Classifier scorers (intent, injection with boolean inversion fix)
4. ✅ Golden dataset seed script (40 items, 6 categories)
5. ✅ CI gate test (gates + thresholds, 120s timeout)
6. ✅ Feedback API endpoint (POST /api/feedback → addFeedback)
7. ✅ Usage dashboard API (GET /api/usage from observability metrics)
8. ✅ Usage console page (token/cost dashboard with date range picker)
9. ✅ Digest agent and workflow (morning priorities summary)
10. ✅ Digest schedule (CRUM_DIGEST_CRON env var, boot-time registration)
11. ✅ Today view console page (digest stats and item lists)
12. ✅ Mastra instance update (12 scorers registered)
13. ✅ Verification record (this document)

**Integration testing** (golden gate with real model API, feedback/usage with PostgresStoreVNext, digest schedule with Mastra scheduler) requires a running environment and is deferred to deployment verification.

**Next steps:**
- Final whole-branch code review
- Merge to main or create PR
- Deploy to staging environment for integration testing
- Monitor golden gate results in Mastra Studio
- Verify feedback loop end-to-end with real traces
- Confirm digest schedule fires at 07:00 weekdays
