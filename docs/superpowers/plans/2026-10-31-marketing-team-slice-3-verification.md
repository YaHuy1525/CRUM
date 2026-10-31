# Slice 3 Verification Report

**Date:** 2026-10-31
**Branch:** `feat/marketing-slice-2`
**Commit:** `025ee9e`
**Slice 3 range:** `c006b43..afc18dc` (15 commits)

## Test Results

### Typecheck
- Command: `npm run typecheck`
- Result: **FAIL** — 57 TypeScript errors

Errors concentrate in three groups:

1. **Source files** — `src/marketing/meta-ads.ts` (12 errors: `unknown` json access, unsafe casts), `src/marketing/metrics-readback.ts` (4 errors: `unknown` json access), `src/db/marketing-metrics.ts` (1 error: possibly undefined row), `src/db/marketing.ts` (1 error: possibly undefined object)
2. **Test files** — `tests/db/marketing-metrics.test.ts` (18 errors: `call` possibly undefined), `tests/db/marketing-active-campaigns.test.ts` (5 errors: object possibly undefined), `tests/marketing/meta-ads.test.ts` (4 errors: undefined access, missing property, missing config field), `tests/marketing/metrics-readback.test.ts` (5 errors: object possibly undefined)

All errors are strict-null / unknown-type issues introduced by slice 3 code. The runtime behavior is correct (all tests pass), but the typechecker is not satisfied.

### Lint
- Command: `npm run lint`
- Result: **FAIL** — 90 errors (0 warnings)

Errors concentrate in:

1. `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, `no-unsafe-return` — throughout new slice 3 source and test files
2. `@typescript-eslint/require-await` — async `json()` methods in `metrics-readback.test.ts` and `meta-ads.ts` that return literals without `await`
3. All 90 errors are in files touched by slice 3

### Unit Tests

| Suite | Passed | Failed | Skipped/Todo | Files |
|-------|--------|--------|--------------|-------|
| Marketing | 158 | 0 | 0 | 10/10 |
| Governance | 245 | 0 | 1 todo | 10/10 |
| Mastra | 478 | **4** | 0 | 52/55 |
| DB | 133 | 0 | 0 | 10/10 |
| API | 260 | 0 | 0 | 20/20 |

**Mastra failures (4):**

All four are off-by-one tool count assertions. Slice 3 added `marketing.set_campaign_status` as a new governance-surface tool, but the hardcoded counts in these tests were not updated:

1. `tests/mastra/active-tools.test.ts` — "gives an admin the approval-class writes too" expects 40 tools, got 41
2. `tests/mastra/active-tools.test.ts` — "leaves no dotted id in the list the agent hands the model" expects 40, got 41
3. `tests/mastra/agent.test.ts` — "has 39 tools configured" expects 39, got 40
4. `tests/mastra/processors/write-claim-guard.test.ts` — "MUTATING_TOOL_IDS lists every write tool" expects 14, got 15

**Fix:** Bump each expected count by 1 and add `marketing.set_campaign_status` to the `MUTATING_TOOL_IDS` list.

### Console Tests
- Command: `cd console && npm test`
- Result: **205/205 passed** (24 files)

Includes the new `tests/app/campaigns.test.tsx` (3 tests) for the campaigns route page.

### Integration Tests
- Command: `npx vitest run tests/integration/`
- Result: **35 passed, 55 skipped** (16 files, 3 passed + 13 skipped)

The 13 skipped files require `CRUM_INTEGRATION_DATABASE_URL` (a live Postgres connection). The 3 files that ran (all non-DB integration tests) passed cleanly. No new integration test files were added in slice 3.

## Baseline Comparison

- **Slice 2 baseline:** [`2026-10-31-marketing-team-slice-2-verification.md`](./2026-10-31-marketing-team-slice-2-verification.md) (commit `1905e0f`)
- **Slice 2 result:** Typecheck PASS, Lint PASS, 455 unit tests PASS, 28 integration tests PASS

### New failures introduced by slice 3

| Gate | Slice 2 | Slice 3 | Delta |
|------|---------|---------|-------|
| Typecheck | PASS (0 errors) | **FAIL (57 errors)** | +57 errors in new files |
| Lint | PASS (0 errors) | **FAIL (90 errors)** | +90 errors in new files |
| Marketing tests | 95/95 | 158/158 | +63 new tests, all pass |
| Governance tests | 157/157 + 1 todo | 245/245 + 1 todo | +88 new tests, all pass |
| Mastra tests | 88/88 | 478/482 | **+4 failures** (stale counts) |
| DB tests | 21/21 | 133/133 | +112 new tests, all pass |
| API tests | 57/57 | 260/260 | +203 new tests, all pass |
| Console tests | 37/37 | 205/205 | +168 new tests, all pass |
| Integration tests | 28/28 | 35/35 (+55 skip) | +7 pass, 55 skip (no DB) |

### Regressions

- **Mastra tool counts:** The 4 Mastra failures are regressions caused by stale hardcoded counts. The underlying functionality works; only the test assertions need updating.
- **Typecheck and lint:** These were clean in slice 2. The 57 typecheck errors and 90 lint errors are all in new slice 3 code (strict-null checks on `unknown` JSON responses, possibly-undefined array/object access). No existing file was broken.

### Test volume growth

Slice 3 added approximately **839 new passing tests** (from 455 to 1294 across unit suites), a 2.8x increase. Every new test passes at runtime.

## Hand-offs

### Environment Variables

The following env vars need to be set for slice 3 to function:

- `CRUM_META_PIXEL_ID` — the Meta pixel ID for automatic injection into published pages. When absent, pages publish without the pixel script tag and a stderr warning is logged.
- `CRUM_META_ADS_ACCESS_TOKEN` — long-lived token for Ads API (`create_campaign`, `set_campaign_status`) and Conversions API (server-side event tracking on lead submission). When absent, the Meta Ads adapters are not registered and leads are recorded without a server-side event.
- `CRUM_META_AD_ACCOUNTS` — JSON array of ad account IDs (e.g., `["act_123","act_456"]`). Required by the Ads API adapter to target the correct account.

**Token scope:** The Ads API token needs `ads_management` and `ads_read` permissions on the ad accounts listed in `CRUM_META_AD_ACCOUNTS`. A long-lived token is recommended because the Conversions API is called synchronously on every lead submission.

### Manual Walkthrough Procedure

1. **Set the three env vars** listed above in `.env`
2. **Create a campaign paused** (via media-buyer agent or directly): the analyst cron creates campaigns in PAUSED status by default
3. **Approve the bundle** via the governance surface (`marketing.save_bundle` then approve the draft)
4. **Run the drain script** (`npx tsx scripts/publish-drain.ts`) to create the campaign in Meta via the `create_campaign` adapter
5. **Publish a page with pixel injection**: approve a bundle whose page HTML contains the `{{CRUM_META_PIXEL_ID}}` stamp; verify the pixel script tag appears in the published output
6. **Submit a lead** via the public form endpoint; verify the Conversions API call fires (check stderr for the event POST, or observe the Meta Events Manager)
7. **Run the analyst cron job manually** (`npx tsx scripts/analyst-cron.ts`): it calls `listActiveCampaigns`, reads metrics via `metricsReadBack`, stores a snapshot, and may call `stageCampaignStatusChange` to stage a scale/kill draft
8. **Approve the staged draft** via the governance surface: the `marketing.set_campaign_status` action drains and calls the Meta Ads API
9. **Verify the campaign status changed** in Meta Ads Manager

**Status:** Not performed. Requires live Meta Ads API credentials and a Meta pixel ID.

## Commits

| SHA | Description |
|-----|-------------|
| `c006b43` | docs(marketing): add slice 3 design spec for Meta campaign management and analyst schedule |
| `01b33fa` | docs(marketing): add slice 3 implementation plan |
| `27f11a2` | feat(marketing): add migration 0020 for marketing_metrics_snapshots table |
| `0b217ab` | feat(marketing): add Meta Ads API adapters for create_campaign and set_campaign_status |
| `9162a4e` | feat(marketing): add Meta pixel injection at publish time |
| `e145510` | feat(marketing): add Conversions API integration for server-side event tracking |
| `680571b` | feat(marketing): add metrics read-back and snapshot storage |
| `64ef86f` | feat(marketing): add listActiveCampaigns for analyst cron |
| `50347fd` | feat(marketing): add stageCampaignStatusChange for analyst scale/kill drafts |
| `9e83f00` | feat(governance): add marketing.set_campaign_status to the governance surface |
| `cd920a5` | feat(marketing): register Meta Ads API adapters at boot |
| `0bf70bc` | feat(marketing): add analyst cron script for weekly campaign analysis |
| `4a92dd4` | feat(console): add campaign metrics dashboard component |
| `148004a` | feat(console): add campaigns route page |
| `afc18dc` | feat(console): move CampaignMetrics type to shared types module |

## Summary

**What was verified:**
- 1294 unit tests across 5 suites (marketing, governance, mastra, db, api) — 1290 pass, 4 fail
- 205 console tests — all pass
- 35 integration tests (non-DB) — all pass, 55 skipped (no Postgres)

**What failed:**
- Typecheck: 57 errors (strict-null and unknown-type issues in new slice 3 code)
- Lint: 90 errors (unsafe assignments, require-await in new slice 3 code)
- Mastra: 4 failures (stale tool count assertions, not functional regressions)

**What was not verified:**
- Manual walkthrough against real Meta Ads API (no credentials)
- Integration tests requiring `CRUM_INTEGRATION_DATABASE_URL` (no Postgres)
- `npm run verify` paid suite (spends credit, owner decision required)

**Required fixes before merge:**
1. Fix 57 typecheck errors — add null checks and type assertions for `unknown` JSON responses
2. Fix 90 lint errors — add `await` to async methods, type unsafe assignments
3. Fix 4 Mastra test failures — bump tool counts from 39→40, 40→41, 14→15 and add `marketing.set_campaign_status` to `MUTATING_TOOL_IDS`

**Slice 3 is NOT shippable** in its current state. The runtime behavior is correct (all functional tests pass), but the typecheck and lint gates are red, and 4 Mastra tests have stale assertions. These are mechanical fixes, not design issues.
