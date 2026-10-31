# Fix Minor Review Findings (C1–C6, S3–S4)

**Status:** DONE

**Date:** 2026-10-31
**Branch:** feat/marketing-slice-2
**Base commit:** 90a4ed2

---

## Fixes Applied

### C1 — Missing Content-Type header in Meta Ads API calls
- **File:** `src/marketing/meta-ads.ts`
- **Change:** Added `'Content-Type': 'application/json'` to the `headers` object in both `makeCreateCampaignAdapter` and `makeSetCampaignStatusAdapter` fetch calls.
- **Test update:** `tests/marketing/meta-ads.test.ts` — updated both `toHaveBeenCalledWith` header assertions to include `'Content-Type': 'application/json'`.

### C2 — Typo `CRUN_TENANT_ID` → `CRUM_TENANT_ID`
- **File:** `scripts/analyst-cron.ts:365`
- **Change:** Fixed the env-var name in the error message.

### S3 — `campaignName` placeholder replaced with real value from `create_campaign` payload
- **File:** `src/db/marketing.ts` — `listActiveCampaigns`
- **Change:** The SQL query now also selects `payload ->> 'name' AS "campaignName"`. The return type includes `campaignName: string`. The function returns the real campaign name from the `create_campaign` payload instead of requiring callers to substitute.
- **File:** `scripts/analyst-cron.ts:276`
- **Change:** `campaignName: c.campaignExternalId` → `campaignName: c.campaignName`
- **Test update:** `tests/db/marketing-active-campaigns.test.ts` — all mock rows and `toEqual` assertions now include `campaignName`.

### S4 — Dashboard currency changed from USD to AUD
- **File:** `console/components/CampaignMetricsDashboard.tsx:31`
- **Change:** `currency: 'USD'` → `currency: 'AUD'`
- **Test update:** `console/tests/CampaignMetricsDashboard.test.tsx` — `$450.25` → `A$450.25`, `$25.01` → `A$25.01` (the `en-US` locale renders AUD with the `A$` prefix).

### C5 — Test payload typo `dailystatic` → `dailyCeilingMinor`
- **File:** `tests/marketing/meta-ads.test.ts:75`
- **Change:** Fixed the property name in the create_campaign test fixture.

### C6 — Comment accuracy in `src/db/marketing-metrics.ts:3-6`
- **Status:** Verified — no change needed.
- The comment says "The cron job calls insertSnapshot after each successful metrics read." After the S1 fix (task #62), this is now accurate: the analyst cron calls `insertSnapshot` via `collectAndStoreSnapshot` after each successful metrics read.

### Additional fix — pre-existing test assertion gap
- **File:** `tests/marketing/meta-ads.test.ts:213`
- **Change:** The `set_campaign_status` test's `toEqual` assertion was missing `externalId: '23842653876'` from the expected result. The implementation has always returned it; the test was incomplete. Fixed to match.

---

## Commits

```
fix(marketing): address minor review findings C1-C6, S3-S4
```

---

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| `tests/marketing/meta-ads.test.ts` | 8 passed | PASS |
| `tests/db/marketing-active-campaigns.test.ts` | 7 passed | PASS |
| `console/tests/CampaignMetricsDashboard.test.tsx` | 14 passed | PASS |
| **Total** | **29 passed** | **ALL GREEN** |

---

## Concerns / Deviations

- **Deviation:** Fixed a pre-existing test assertion gap in `meta-ads.test.ts` (the `set_campaign_status` result was missing `externalId`). This was not one of the six listed issues but was necessary to achieve a clean test run. The fix aligns the test with the existing implementation — no production code change.
- **Integration tests:** The analyst cron integration test (`tests/integration/analyst-cron.test.ts`) was not run because it requires `CRUM_INTEGRATION_DATABASE_URL`. Its `create_campaign` fixture payloads do not include a `name` field, so `campaignName` will be `null` for those rows. This does not affect test outcomes because the agent invocation is mocked, but a future task may want to add `name` to those fixtures for completeness.
