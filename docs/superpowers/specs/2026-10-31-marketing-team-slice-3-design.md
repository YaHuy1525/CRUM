# CRUM Marketing Team, Slice 3 Design

**Date:** 2026-10-31
**Status:** approved direction, awaiting implementation
**Scope:** Meta campaign creation (paused), pixel injection, Conversions API integration, metrics read-back, weekly analyst schedule

## 1. What we are building

Slice 3 adds campaign management to CRUM's marketing system. The media-buyer agent's campaign spec becomes a real campaign object in Meta Ads Manager (created paused, always), the published pages track conversions via the Meta pixel and Conversions API, and the campaign-analyst agent runs weekly to read metrics and recommend scale, hold, or kill actions.

**What this slice makes real:**
- Campaigns created paused in Meta Ads Manager, with the owner manually starting delivery
- Pixel tracking on all published pages, with automatic injection at publish time
- Server-side conversion tracking via Meta's Conversions API, with event deduplication
- Weekly analyst reports with scale/hold/kill recommendations
- Approval drafts for scale and kill actions, so nothing changes without the owner's click

**What this slice does not do:**
- Automatically activate or pause campaigns (the owner starts delivery by hand)
- Manage budgets or bidding strategies beyond the daily ceiling the media-buyer specifies
- Support ad platforms other than Meta (Google Ads, TikTok, etc. are future slices)
- Run A/B tests (excluded in the parent spec section 11)
- Handle multiple pixels or pixel-level segmentation

## 2. The rule that keeps this survivable

The same rule from slice 1 and 2: **a subagent may spend tokens and cents, but may never change anything outside CRUM.**

Campaigns are created paused. The owner starts delivery by hand in Meta Ads Manager. The analyst can recommend scale or kill, but the recommendation stages a draft that the owner must approve. Nothing in slice 3 bypasses the approval gate.

**Consequences:**

| Consequence | Why it is acceptable |
|---|---|
| Campaigns are always created paused | The owner's click is the only thing that starts spend |
| The analyst's scale/kill recommendation stages a draft | The owner reviews and approves before anything changes |
| Conversions API sends events server-side | The event is a recorded fact (a lead arrived), not an outbound action |
| Pixel injection happens at publish time | The published page is already approved; injection is a mechanical transform |

## 3. Architecture overview

Slice 3 adds four capabilities:

1. **Meta Ads API adapter** — creates campaigns paused in the specified ad account, using the campaign spec from the media-buyer agent. Returns the external campaign ID.

2. **Pixel injection** — at publish time, the page-host adapter injects the Meta pixel base code into the HTML using `CRUM_META_PIXEL_ID` from env. The funnel-builder agent specifies which standard events to fire (PageView, Lead, etc.) in the HTML it generates.

3. **Conversions API** — when a lead arrives at `/api/marketing/leads`, CRUM sends a server-side conversion event to Meta's API with event deduplication (using the `lead_token` as the event ID). This runs in parallel with the existing `marketing_leads` insert.

4. **Metrics read-back and analyst schedule** — a cron job runs every Monday at 9 AM, reads campaign metrics from Meta's Ads API (impressions, clicks, spend, conversions) for the past 7 days, invokes the campaign-analyst agent, and if the recommendation is "scale" or "kill", stages a `set_campaign_status` draft for approval.

**Data flow:**

```
Media buyer → campaign_spec (JSON) → bundle
  ↓
Owner approves bundle
  ↓
create_campaign adapter → Meta Ads API → external_id stored in marketing_actions.result
  ↓
Publish adapter → injects pixel → uploads to Cloudflare Pages
  ↓
Lead arrives → /api/marketing/leads
  ↓ (parallel)
  ├─→ marketing_leads insert (existing)
  └─→ Conversions API → Meta (new)
  ↓
Monday 9 AM cron → reads metrics from Meta → analyst agent → recommendation
  ↓
If scale/kill → stages set_campaign_status draft → owner approves → adapter executes
```

**New env vars:**
- `CRUM_META_PIXEL_ID` — the pixel ID for automatic injection
- `CRUM_META_ADS_ACCESS_TOKEN` — long-lived token for Ads API and Conversions API
- `CRUM_META_AD_ACCOUNTS` — JSON array of ad account IDs the owner manages (e.g., `["act_123", "act_456"]`)

## 4. Data model

Slice 3 adds one new table and uses existing columns in new ways.

### 4.1 `marketing_metrics_snapshots`

Stores periodic reads of campaign metrics from Meta's API, so the analyst can compare periods and see trends.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid NOT NULL | matches the spine convention |
| bundle_id | uuid NOT NULL | links to the bundle that created the campaign |
| campaign_external_id | text NOT NULL | the Meta campaign ID from `marketing_actions.external_id` |
| window_start | timestamptz NOT NULL | the start of the metrics window (e.g., 7 days ago) |
| window_end | timestamptz NOT NULL | the end of the metrics window (e.g., now) |
| metrics | jsonb NOT NULL | the raw metrics object from Meta's API |
| created_at | timestamptz NOT NULL default now() | |

**Why a separate table instead of reusing `marketing_actions.result`?**

The `result` column stores the response from *executing* the action (e.g., the campaign creation response). Metrics change daily, so we need to store snapshots over time. A separate table lets the analyst query "metrics for campaign X in the last 7 days" without parsing action results.

### 4.2 Existing columns used in new ways

- `marketing_actions.payload` — for `create_campaign`, this carries the full campaign spec including `adAccountId`, `objective`, `audience`, `placements`, `dailyCeilingMinor`, `startPaused: true`, and `budgetLadder`. For `set_campaign_status`, it carries `campaignId` and `status`. The payload is identifiers and numbers, no prose (spec section 7).

- `marketing_actions.result` — for `create_campaign`, this stores the Meta API response: `{ campaignId, accountId, status, createdTime }`. For `set_campaign_status`, it stores the response from pausing or activating the campaign.

- `marketing_bundles.campaign_spec` — the media-buyer's JSON output now includes `adAccountId` as a required field, chosen from the configured `CRUM_META_AD_ACCOUNTS` list.

### 4.3 Migration: `migrations/0020_crum_marketing_metrics.sql`

One new table, no schema changes to existing tables. The migration follows the idempotent convention of 0018 and 0019.

## 5. Meta Ads API integration

Two new adapters: `create_campaign` and `set_campaign_status`. Both call Meta's Marketing API using `CRUM_META_ADS_ACCESS_TOKEN` from env.

### 5.1 `create_campaign` adapter

Calls `POST https://graph.facebook.com/v18.0/act_{adAccountId}/campaigns` with:
- `name`: campaign name from the media-buyer spec
- `objective`: "LEAD_GENERATION" (matching the design spec's "Lead objective")
- `status`: "PAUSED" (always — the adapter refuses if `payload.startPaused` is false)
- `special_ad_categories`: [] (empty unless in credit, employment, housing, or politics)

**Payload shape** (stored in `marketing_actions.payload`):
```json
{
  "adAccountId": "act_123456789",
  "name": "Free Scan - Brisbane - Oct 2026",
  "objective": "LEAD_GENERATION",
  "startPaused": true,
  "dailyCeilingMinor": 5000,
  "audience": { "location": "Brisbane, AU", "age": "25-54", "interests": ["home ownership"] },
  "placements": ["facebook_feed", "instagram_feed"],
  "budgetLadder": [
    { "days": 3, "dailyMinor": 3000 },
    { "days": 4, "dailyMinor": 5000 }
  ]
}
```

**Result shape** (stored in `marketing_actions.result`):
```json
{
  "campaignId": "23842653876...",
  "accountId": "act_123456789",
  "status": "PAUSED",
  "createdTime": "2026-10-31T09:00:00+0000"
}
```

**Refusal conditions:**
- `startPaused` is false → refuses with `campaign_must_be_paused`
- `adAccountId` not in `CRUM_META_AD_ACCOUNTS` → refuses with `unknown_ad_account`
- Missing access token → adapter not registered at boot (same pattern as slice 2's page-host)

### 5.2 `set_campaign_status` adapter

Calls `POST https://graph.facebook.com/v18.0/{campaignId}` with `status` field. This is what the analyst stages when recommending "scale" (ACTIVE) or "kill" (PAUSED).

**Payload:**
```json
{
  "campaignId": "23842653876...",
  "status": "ACTIVE"
}
```

**Result:**
```json
{
  "success": true,
  "previousStatus": "PAUSED",
  "newStatus": "ACTIVE"
}
```

### 5.3 Error handling

Both adapters catch Meta API errors and store them in `result.error` with the HTTP status code and message. A failed action stays `failed` in the outbox, and the retry tool (slice 2's `marketing.retry_publish`) can retry it.

### 5.4 Registration at boot

Both adapters register in `src/mastra/index.ts` only when `CRUM_META_ADS_ACCESS_TOKEN` is present. If the token is missing, `create_campaign` and `set_campaign_status` stay unmapped, and the slice 1 guard refuses at staging.

## 6. Pixel injection

The publish adapter (slice 2's `page-host.ts`) gains pixel injection logic. When publishing a page, if `CRUM_META_PIXEL_ID` is set in env, the adapter injects the Meta pixel base code into the HTML before uploading to Cloudflare Pages.

### 6.1 Injection logic

1. Read the HTML from the `page_html` artifact
2. If `CRUM_META_PIXEL_ID` is set:
   - Generate the pixel base code snippet with the pixel ID substituted
   - Inject it before `</head>` in the HTML
   - If no `</head>` tag exists, inject before `</body>`
   - If neither exists, prepend to the HTML
3. If `CRUM_META_PIXEL_ID` is not set:
   - Skip injection
   - Log a warning: "Meta pixel ID not configured; page published without tracking"
4. Upload the (possibly modified) HTML to Cloudflare Pages

### 6.2 Pixel base code snippet

```html
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '{{PIXEL_ID}}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id={{PIXEL_ID}}&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
```

### 6.3 Funnel-builder responsibility

The funnel-builder agent generates the HTML with event firing code. For example, the thank-you page includes:

```html
<script>
fbq('track', 'Lead');
</script>
```

The funnel-builder's instructions (in `src/mastra/agents/funnel-builder.ts`) already say "If the page has a form, its action must be exactly the placeholder `{{CRUM_LEAD_ENDPOINT}}` with method post." We add: "If the page should track conversions, include `fbq('track', 'EventName')` calls for the relevant standard events (PageView, Lead, CompleteRegistration, Purchase, etc.). The pixel base code is injected automatically at publish time."

### 6.4 Adapter registration

The publish adapter registers regardless of whether `CRUM_META_PIXEL_ID` is set. This allows publishing pages without tracking if needed. The warning log makes the missing pixel visible.

## 7. Conversions API integration

When a lead arrives at `/api/marketing/leads`, CRUM sends a server-side conversion event to Meta's Conversions API in addition to writing the `marketing_leads` row. This gives Meta's optimization algorithms the conversion data they need.

### 7.1 Conversions API call

Calls `POST https://graph.facebook.com/v18.0/{pixel_id}/events` with:
- `data`: array of event objects
- `access_token`: `CRUM_META_ADS_ACCESS_TOKEN`

**Event object:**
```json
{
  "event_name": "Lead",
  "event_time": 1698765432,
  "event_id": "lead_token_value",
  "action_source": "website",
  "event_source_url": "https://your-domain.test/thanks/",
  "user_data": {
    "em": ["normalized_email_hash"],
    "client_ip_address": "request_ip",
    "client_user_agent": "request_user_agent"
  },
  "custom_data": {
    "bundle_id": "uuid",
    "campaign_id": "23842653876...",
    "value": 0,
    "currency": "AUD"
  }
}
```

### 7.2 Event deduplication

Meta's Conversions API requires event deduplication when both the pixel and the server send events. The `event_id` field is the deduplication key. We use the `lead_token` (already minted at save time in slice 2) as the `event_id`, so the pixel-fired event and the server-fired event have the same ID and Meta deduplicates them.

The funnel-builder's HTML includes `fbq('track', 'Lead', {}, {eventID: '{{CRUM_LEAD_TOKEN}}'});` to fire the pixel event with the same ID. The lead token is stamped into the page at save time (slice 2), so the HTML already has access to it.

### 7.3 Parallel execution

The Conversions API call runs in parallel with the `marketing_leads` insert. If the API call fails, the lead is still recorded in CRUM (the insert succeeds), and the failure is logged. A future retry mechanism can re-send failed events, but for slice 3, the failure is logged and the owner can manually re-fire if needed.

### 7.4 Error handling

The Conversions API call catches errors and logs them. The response from Meta includes `events_received` (count of events accepted) and `errors` (array of error objects). If `events_received` is 0 and `errors` is non-empty, the log includes the error details.

### 7.5 Registration at boot

The Conversions API module registers only when both `CRUM_META_PIXEL_ID` and `CRUM_META_ADS_ACCESS_TOKEN` are present. If either is missing, the module logs a warning and skips the API call, but the lead insert still succeeds.

## 8. Metrics read-back

The analyst needs to read campaign metrics from Meta's API to generate the weekly report. This section describes how metrics are read and stored.

### 8.1 Metrics API call

Calls `GET https://graph.facebook.com/v18.0/act_{adAccountId}/insights` with:
- `level`: "campaign"
- `time_range`: `{"since":"2026-10-24","until":"2026-10-31"}` (past 7 days)
- `time_increment`: 1 (daily breakdown)
- `fields`: "campaign_name,impressions,clicks,spend,actions,date_start,date_stop"

**Response shape:**
```json
{
  "data": [
    {
      "campaign_name": "Free Scan - Brisbane - Oct 2026",
      "impressions": "1234",
      "clicks": "56",
      "spend": "45.67",
      "actions": [
        {"action_type": "lead", "value": "12"},
        {"action_type": "page_engagement", "value": "89"}
      ],
      "date_start": "2026-10-24",
      "date_stop": "2026-10-24"
    },
    ...
  ]
}
```

### 8.2 Metrics storage

The cron job reads metrics for all active campaigns (those with a `succeeded` `create_campaign` action and no subsequent `set_campaign_status` action with `status: PAUSED`), then inserts a snapshot into `marketing_metrics_snapshots` for each campaign.

The snapshot's `metrics` field stores the raw response from Meta, so the analyst can parse it flexibly. The `window_start` and `window_end` fields record the time range.

### 8.3 Campaign status tracking

A campaign is "active" if:
- It has a `succeeded` `create_campaign` action
- It has no `set_campaign_status` action, or its most recent `set_campaign_status` action has `status: ACTIVE`

A campaign is "paused" if:
- Its most recent `set_campaign_status` action has `status: PAUSED`

The cron job only reads metrics for active campaigns, because paused campaigns have no new metrics.

## 9. Analyst schedule

The campaign-analyst agent runs every Monday at 9 AM, reads the past 7 days of metrics, generates a report, and optionally stages a draft for scale or kill recommendations.

### 9.1 Cron job

A new script `scripts/analyst-cron.ts` runs on a cron schedule (configured externally, e.g., in the owner's crontab or a task scheduler). The script:

1. Queries `marketing_metrics_snapshots` for snapshots from the past 7 days
2. Groups snapshots by `bundle_id` and `campaign_external_id`
3. For each campaign, computes:
   - Total impressions, clicks, spend, leads
   - Average cost per lead
   - Comparison to the previous 7-day window (if available)
4. Invokes the campaign-analyst agent with the computed metrics
5. Parses the agent's response (JSON with `recommendation`, `threshold`, `message`)
6. If `recommendation` is "scale":
   - Stages a `set_campaign_status` draft with `status: ACTIVE` (if the campaign is currently paused)
   - Or does nothing (if the campaign is already active)
7. If `recommendation` is "kill":
   - Stages a `set_campaign_status` draft with `status: PAUSED`
8. If `recommendation` is "hold":
   - Logs the message and does nothing

### 9.2 Analyst agent input

The analyst agent receives a JSON object with:
```json
{
  "window": {
    "start": "2026-10-24T00:00:00Z",
    "end": "2026-10-31T00:00:00Z"
  },
  "campaigns": [
    {
      "bundleId": "uuid",
      "campaignId": "23842653876...",
      "campaignName": "Free Scan - Brisbane - Oct 2026",
      "metrics": {
        "impressions": 1234,
        "clicks": 56,
        "spend": 45.67,
        "leads": 12,
        "costPerLead": 3.81
      },
      "previousWindow": {
        "impressions": 1100,
        "clicks": 50,
        "spend": 40.00,
        "leads": 10,
        "costPerLead": 4.00
      }
    }
  ]
}
```

### 9.3 Analyst agent output

The analyst agent returns a JSON object with:
```json
{
  "recommendation": "scale" | "hold" | "kill",
  "threshold": "cost_per_lead_below_5",
  "message": "Campaign 'Free Scan - Brisbane' has a cost per lead of $3.81, below the $5 threshold. Recommend scaling up.",
  "campaigns": [
    {
      "bundleId": "uuid",
      "campaignId": "23842653876...",
      "recommendation": "scale",
      "reason": "cost_per_lead_below_5"
    }
  ]
}
```

The agent's instructions (in `src/mastra/agents/campaign-analyst.ts`) already say "Give one recommendation, scale, hold or kill, with the threshold that fired and the spend that reached it." We extend this to: "For each campaign, give a recommendation with the threshold that fired. If the recommendation is scale or kill, stage a draft."

### 9.4 Draft staging

The cron script uses the existing `stageCampaignStatusChange` function (new, similar to `stagePromotion` from slice 2) to stage the draft. The function:

1. Validates the campaign exists and is in the correct state (active for scale, any for kill)
2. Computes the risk score using `scoreRisk` on the payload
3. Inserts a `pending_writes` row with `object_type: 'marketing_set_campaign_status'`
4. Returns the draft ID

The draft appears in the approval queue, and the owner can approve or reject it.

### 9.5 Error handling

If the cron job fails (e.g., Meta API is down, database error), the failure is logged and the job exits. The next scheduled run (the following Monday) will retry. The cron job does not retry within the same run, because the analyst's recommendation might change based on new metrics.

If the analyst agent fails to generate a recommendation (e.g., invalid input, model error), the failure is logged and the job exits without staging any drafts.

## 10. Console changes

The console gains one new screen: the campaign metrics dashboard. This screen shows the past 7 days of metrics for all active campaigns, with the analyst's most recent recommendation highlighted.

### 10.1 Campaign metrics dashboard

A new route `/console/campaigns` displays a table of active campaigns with:
- Campaign name
- Ad account
- Status (active/paused)
- Impressions (past 7 days)
- Clicks (past 7 days)
- Spend (past 7 days)
- Leads (past 7 days)
- Cost per lead (past 7 days)
- Analyst recommendation (scale/hold/kill)
- Last analyst run timestamp

Each row links to a detail screen showing the full metrics history (all snapshots) and the analyst's message.

### 10.2 Analyst recommendation display

The dashboard shows the analyst's recommendation as a badge:
- Green badge for "scale"
- Yellow badge for "hold"
- Red badge for "kill"

Clicking the badge opens a modal with the analyst's full message and the threshold that fired.

### 10.3 Draft approval

The approval queue (existing) shows the `set_campaign_status` drafts staged by the analyst. The owner can approve or reject them as usual. The queue item includes the analyst's recommendation and message, so the owner has context.

## 11. Error handling and retry logic

### 11.1 Adapter errors

Both `create_campaign` and `set_campaign_status` adapters catch Meta API errors and store them in `result.error` with the HTTP status code and message. A failed action stays `failed` in the outbox, and the retry tool (slice 2's `marketing.retry_publish`) can retry it.

### 11.2 Conversions API errors

The Conversions API call catches errors and logs them. The lead insert still succeeds, so the lead is recorded in CRUM even if Meta's API is down. A future retry mechanism can re-send failed events, but for slice 3, the failure is logged and the owner can manually re-fire if needed.

### 11.3 Metrics read-back errors

If the metrics API call fails, the cron job logs the error and exits without updating snapshots. The next scheduled run will retry. The analyst only runs if there are snapshots from the past 7 days, so a failed metrics read prevents the analyst from running with incomplete data.

### 11.4 Analyst errors

If the analyst agent fails to generate a recommendation, the failure is logged and the job exits without staging any drafts. The next scheduled run will retry.

## 12. Testing strategy

### 12.1 Unit tests

- `create_campaign` adapter: payload validation, refusal conditions, Meta API call mocking
- `set_campaign_status` adapter: payload validation, Meta API call mocking
- Pixel injection: with/without pixel ID, with/without `</head>` tag
- Conversions API: event deduplication, error handling, parallel execution
- Metrics read-back: API call mocking, snapshot storage
- Analyst schedule: recommendation parsing, draft staging logic

### 12.2 Integration tests

- Campaign creation flow: bundle → stage → approve → create_campaign action → Meta API
- Pixel injection flow: bundle → stage → approve → publish → pixel injected
- Conversions API flow: lead arrives → marketing_leads insert + Conversions API call
- Metrics read-back flow: cron job → metrics API → snapshots stored
- Analyst schedule flow: cron job → metrics read → analyst agent → draft staged

### 12.3 End-to-end tests

- Full flow: bundle → stage → approve → create_campaign → publish → lead → conversions API → metrics → analyst → draft → approve → set_campaign_status

### 12.4 Manual walkthrough

The owner performs a manual walkthrough with a real Meta ad account:
1. Create a campaign paused
2. Publish a page with pixel injection
3. Submit a lead and verify the Conversions API call
4. Run the analyst cron job manually
5. Approve the staged draft
6. Verify the campaign status changed in Meta Ads Manager

## 13. Non-goals

- Automatically activating campaigns without approval
- Managing budgets or bidding strategies beyond the daily ceiling
- Supporting ad platforms other than Meta
- Running A/B tests
- Handling multiple pixels or pixel-level segmentation
- Real-time metrics streaming (the cron job runs weekly)
- Retrying failed Conversions API events (future slice)

## 14. Risks worth naming before the first task

| Risk | Mitigation in this design |
|---|---|
| Meta API rate limits | The cron job runs once a week, so rate limits are unlikely. If they become an issue, add exponential backoff to the API calls. |
| Conversions API event deduplication failures | Use the `lead_token` as the `event_id`, which is unique per lead and already stamped into the page. |
| Analyst generates incorrect recommendations | The analyst's instructions explicitly say "Never estimate a metric, never fill a gap with a plausible looking figure." The owner reviews and approves all drafts. |
| Pixel injection breaks the page HTML | Inject before `</head>` or `</body>`, which are standard HTML tags. If neither exists, prepend to the HTML. Test with malformed HTML. |
| Meta API changes | Pin the API version (v18.0) and test against the documented API. If Meta deprecates the version, update the adapters. |
| Access token expires | Use a long-lived token (60 days) and log a warning when it's within 7 days of expiry. The owner can regenerate it in Meta Business Manager. |

## 15. Delivery slices

Slice 3 can be split into three sub-slices for implementation:

| Sub-slice | Ships | Makes real |
|---|---|---|
| 3a | Meta Ads API adapters (`create_campaign`, `set_campaign_status`), migration 0020 | Campaigns created paused in Meta Ads Manager |
| 3b | Pixel injection, Conversions API integration | Published pages track conversions, leads fire server-side events |
| 3c | Metrics read-back, analyst schedule, console dashboard | Weekly analyst reports with scale/hold/kill recommendations |

Each sub-slice ends with `npm run verify` green and the feature reachable in the running app.

## 16. Where the code lands

| Kind | Path | Responsibility |
|---|---|---|
| Migration | `migrations/0020_crum_marketing_metrics.sql` (new) | `marketing_metrics_snapshots` table |
| Adapters | `src/marketing/meta-ads.ts` (new) | `create_campaign` and `set_campaign_status` adapters |
| Pixel | `src/marketing/pixel-injection.ts` (new) | Pixel base code injection logic |
| Conversions | `src/marketing/meta-conversions.ts` (new) | Conversions API call, event deduplication |
| Metrics | `src/marketing/metrics-readback.ts` (new) | Metrics API call, snapshot storage |
| Analyst | `scripts/analyst-cron.ts` (new) | Cron job: metrics read, analyst invocation, draft staging |
| Data | `src/db/marketing-metrics.ts` (new) | Snapshot insert and query |
| Tools | `src/mastra/tools/marketing-writes.ts` (modify) | `stageCampaignStatusChange` function |
| Boot | `src/mastra/index.ts` (modify) | Register Meta adapters conditionally |
| HTTP | `src/api/marketing.ts` (modify) | Conversions API call in lead route |
| Console | `console/components/CampaignMetricsDashboard.tsx` (new) | Campaign metrics screen |
| Console | `console/app/campaigns/page.tsx` (new) | Campaigns route |
| Tests | `tests/marketing/meta-ads.test.ts`, `tests/marketing/pixel-injection.test.ts`, `tests/marketing/meta-conversions.test.ts`, `tests/marketing/metrics-readback.test.ts`, `tests/integration/analyst-cron.test.ts` (new) | One file per boundary |

## 17. Environment variables

New env vars for slice 3:

```bash
CRUM_META_PIXEL_ID=
CRUM_META_ADS_ACCESS_TOKEN=
CRUM_META_AD_ACCOUNTS=["act_123","act_456"]
```

All three are added to `.env.example` with comments explaining their purpose and how to obtain them.

## 18. Sources

- Meta Marketing API: https://developers.facebook.com/docs/marketing-api
- Meta Conversions API: https://developers.facebook.com/docs/marketing-api/conversions-api
- Meta Pixel: https://developers.facebook.com/docs/meta-pixel
- CRUM marketing team design: `docs/superpowers/specs/2026-10-30-marketing-team-design.md`
- CRUM marketing slice 2 design: `docs/superpowers/specs/2026-10-31-marketing-team-slice-2-design.md`
