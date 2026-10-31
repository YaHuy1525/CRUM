# AI Marketing Team, Slice 2 (A Page That Exists and Leads That Arrive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewed marketing bundle reach the owner's Cloudflare Pages domain behind two separate human approvals, and let the form on that page put a real person into the existing prospect pipeline with a consent basis recorded.

**Architecture:** Slice 1's outbox seam is the only way anything leaves CRUM. `deriveActions` gains the artifact set so `publish_page` can carry a hash of the exact bytes, `src/marketing/page-host.ts` registers two `MarketingActionAdapter` objects at boot but only when the Pages credentials are present, and `scripts/publish-drain.ts` drains queued rows outside every SQL transaction. Promotion is a second approval that re-uploads the identical manifest to the production branch, because Cloudflare documents no call that promotes an existing preview deployment. Inbound leads arrive on one unauthenticated route that resolves its tenant from a per-bundle token stamped into the page before it was ever hashed.

**Tech Stack:** TypeScript, Node 22.18, Mastra `@mastra/core` 1.79 (`createTool`), Hono 4.13, `pg` 8.23 against Postgres, Zod 4.6, Vitest 3.2 with two inline projects (`unit`, `integration`), Next.js 15 / React 19 console with its own Vitest + Testing Library setup, `tsx` for scripts.

**Spec:** `docs/superpowers/specs/2026-10-31-marketing-team-slice-2-design.md`, committed at `a5d5e47` on `feat/marketing-slice-2` and amended in this plan's own commit. Sections 2, 3, 5, 6, 7, 8, 10 and 11 are the requirements this plan argues from. Read section 2 before writing any Cloudflare call, section 7 before touching the lead route, and the parent spec's section 7 before touching any payload.

## Global constraints

- **Approval payloads carry identifiers, hashes and numbers. They never carry prose.** Load-bearing, not a preference. The consequence in this slice: the promote payload holds no preview URL, because a URL contains the slug and a slug is a phrase an agent wrote.
- **No external HTTP call ever runs inside a SQL transaction.** `commitBundleApproval` and both new `applyDraft` branches stay pure SQL. The publisher is the only process that reaches Cloudflare.
- **An action may not be approvable before it is executable.** Adapters register only when all four Pages config values are present; otherwise `publish_page` stays unmapped and the slice 1 guard refuses at staging.
- Node `>= 22.18.0`, `@mastra/core` `1.79.0`, `zod` `4.6.7`, as pinned in `package.json` and asserted by `tests/build/pins.test.ts`. No new npm dependency in this slice: the Cloudflare call is hand-written `fetch` plus `FormData`, because `wrangler` is a CLI and this is a server.
- Code style matches the repo: single quotes, no semicolons, two-space indent, `export const` for tools, no `any` (ESLint `@typescript-eslint/no-unsafe-*` is on). Every new file opens with a comment saying why it exists, in the voice of `migrations/0018_crum_marketing.sql` and `src/marketing/payload.ts`.
- Tool names must satisfy `src/governance/schema.ts:16`. `marketing.promote_bundle` and `marketing.retry_publish` are legal; `marketing.promoteBundle` is a boot failure.
- Any commit that changes the declared tool surface changes `policy/tools.yaml`, `SPEC_TOOL_SURFACE` in `tests/governance/conformance.test.ts:13-51`, the counts in `tests/governance/policy.test.ts:55-70`, and the `docs/TECHNICAL_PLAN.md` section 4.6.2 table **in the same commit**, or `npm run test:policy` fails. Task 6 is where all four move together.
- **Run Vitest with explicit file paths, never a bare `--project unit`.** `tests/evals/golden-gate.test.ts` sits in the unit project and calls the live model, so an unfiltered project run costs about twelve model-minutes per go. `npx vitest run tests/marketing/site.test.ts`, not `npx vitest run --project unit`.
- **No real Cloudflare request in any automated test.** The one place provider bytes are hit is Task 1, which is manual, spends nothing, and is recorded before Task 7 is written.
- `npm run verify` is red in this repository for reasons unrelated to this slice (backlog M1: six integration failures). This plan's gate is `npm run typecheck`, `npm run lint`, the named test files, and one filtered integration run. Task 17 compares the final full-suite shape against the slice 1 baseline and reports it without hiding it.
- The working tree carries another effort's uncommitted edits to `.env.example`, `src/mastra/memory.ts`, `src/mastra/recall.ts`, `tests/mastra/memory.test.ts` and `tests/mastra/recall.test.ts`. **Never stage one of those paths.** `git add` takes an explicit file list every time; `git add -A` and `git add .` are forbidden in this plan. `.env.example` is not modified by any task (spec section 9 records the lines instead).
- Each task ends with its own named test command green and one commit.

## Integration cluster

Every integration step here runs against the throwaway Postgres the slice 1 walkthrough left on port 5455, with its data directory at `D:/pgdata-crum-slice1`. If it is gone, recreate it:

```bash
"/c/Program Files/PostgreSQL/17/bin/initdb.exe" -D "D:/pgdata-crum-slice1" -U crum_test --auth=trust
"/c/Program Files/PostgreSQL/17/bin/pg_ctl.exe" -D "D:/pgdata-crum-slice1" -o "-p 5455" -l "D:/pgdata-crum-slice1/log" start
"/c/Program Files/PostgreSQL/17/bin/createdb.exe" -h localhost -p 5455 -U crum_test crum_slice2
```

Then export once per shell:

```bash
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice2"
```

Tests that need migrations applied call `migrate` from `scripts/db-migrate.ts` inside `beforeAll`, which is the pattern `tests/integration/tenant-isolation.test.ts:9,48-60` already uses.

## File structure

| Kind | Path | Responsibility |
|---|---|---|
| Findings | `docs/superpowers/specs/2026-10-31-cloudflare-pages-spike.md` (new) | Task 1's record of what the real API answered, written before the adapter exists |
| Data | `migrations/0019_crum_marketing_publishing.sql` (new) | `thank_you_html`, `promote_page`, `result jsonb`, `lead_token`, two new object types, `marketing_leads` |
| Site | `src/marketing/site.ts` (new) | slot registry, path constants, per-file sha256, `siteHashOf`, `slotProblem` |
| Outbox | `src/marketing/outbox.ts` (modify) | artifact-aware derivation, `HUMAN_INITIATED_ACTION_NAMES`, re-check under lock |
| Tokens | `src/marketing/lead-token.ts` (new) | mint, stamp, refuse on zero or two placeholders |
| Payloads | `src/marketing/payload.ts` (modify) | `siteHash` added to the stage view in Task 4, `promotePayload` and `retryPayload` added in Task 6 |
| Host | `src/marketing/page-host.ts` (new) | manifest form builder, Cloudflare upload, two adapters, `PageHostError` |
| Data | `src/db/marketing.ts` (modify) | `lead_token` on the row, artifact read that a transaction client can use, `markBundleLive` |
| Data | `src/db/marketing-leads.ts` (new) | one tenant-scoped insert that writes lead, prospect, channel and consent |
| Tools | `src/mastra/tools/marketing-writes.ts` (modify) | stamping inside save, `slotProblem` refusal inside stage, `promoteBundleTool`, `retryPublishTool` |
| Guard | `src/mastra/processors/write-claim-guard.ts` (modify) | the two new ids in `MUTATING_TOOL_IDS` |
| Governance | `policy/tools.yaml` (modify), `src/db/pending-writes.ts` (modify) | two declared tools, `marketing_promote` and `marketing_retry` branches in `applyDraft` |
| Publisher | `scripts/publish-drain.ts` (new) | claim one queued row, call its adapter, record `succeeded` or `failed` |
| Boot | `src/mastra/index.ts` (modify) | register adapters only when config is complete |
| HTTP | `src/api/marketing.ts` (modify) | actions in the bundle read, owner-auth promote and retry staging, public `POST /api/marketing/leads` |
| Governance | `src/api/approvals.ts` (modify) | M3 expiry ordering, M4 `tool_call_ids` carrying ids and the zero-based page boundary |
| Console | `console/components/MarketingBundleView.tsx`, `console/lib/types.ts`, `console/components/ApprovalQueue.tsx`, `console/tests/*.test.tsx` (modify) | file table, urls, Prepare go-live, Retry publish, resume control |
| Tests | `tests/marketing/site.test.ts`, `tests/marketing/lead-token.test.ts`, `tests/marketing/page-host.test.ts`, `tests/db/marketing-publish.test.ts`, `tests/mastra/marketing-publish-tools.test.ts`, `tests/api/marketing-leads.test.ts`, `tests/governance/marketing-payload.test.ts`, `tests/integration/marketing-publish.test.ts`, `tests/integration/marketing-leads.test.ts`, `tests/integration/approval-expiry.test.ts` (new) | one file per boundary above |
| Counts | `tests/governance/policy.test.ts`, `tests/governance/conformance.test.ts`, `tests/mastra/active-tools.test.ts`, `tests/mastra/agent.test.ts`, `tests/api/marketing.test.ts`, `console/tests/MarketingBundleView.test.tsx`, `console/tests/ApprovalQueue.test.tsx` (modify) | every assertion that counts the tool surface, moved in the commit that moves it |

Task order is deliberate: the spike precedes the adapter, the slot registry precedes anything that hashes bytes, the payload rule precedes the tools that use it, and the publisher precedes the approvals that feed it, so no task waits on a row that nothing has written yet.

---

### Task 1: The spike, which is allowed to invalidate Task 7

**Files:**
- Create: `docs/superpowers/specs/2026-10-31-cloudflare-pages-spike.md`

**Interfaces:**
- Consumes: the owner's Cloudflare account id, a Pages API token, and the project name the custom domain is attached to. These are config values, not code, and this task cannot start without them.
- Produces: a written answer to three questions that Task 7 codes against: the exact token scope that a direct upload requires, whether a deployment created on branch `crum-preview/{slug}` serves a preview URL and nothing on the domain, and whether re-uploading the identical manifest with `branch` set to the production branch makes that content live on the domain.

This task is manual and has no test cycle. It is first because its answer can change the design, and a spike that invalidates an adapter after three tasks of TDD is the expensive version of the same discovery.

- [ ] **Step 1: Create the token and record its scope**

In the Cloudflare dashboard, create an API token with `Account / Pages / Edit` restricted to the one project. Do not use the global API key. Write down the token, the account id and the project name in a local `.env` (never in a commit):

```bash
CRUM_CLOUDFLARE_ACCOUNT_ID=...
CRUM_CLOUDFLARE_PAGES_PROJECT=...
CRUM_CLOUDFLARE_API_TOKEN=...
```

- [ ] **Step 2: Prove the documented create-deployment call with one file**

Write the two-line site to a temp directory and post the manifest exactly as spec section 2 describes. This is a probe, not a client; it is deleted by Step 5.

```bash
mkdir -p /tmp/crum-spike/crum-spike-probe
printf '<h1>crum spike</h1>' > /tmp/crum-spike/crum-spike-probe/index.html
HASH=$(openssl dgst -sha256 -hex /tmp/crum-spike/crum-spike-probe/index.html | sed 's/^.*= //')
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CRUM_CLOUDFLARE_ACCOUNT_ID/pages/projects/$CRUM_CLOUDFLARE_PAGES_PROJECT/deployments" \
  --header "Authorization: Bearer $CRUM_CLOUDFLARE_API_TOKEN" \
  -F "branch=crum-preview/spike" \
  -F "commit_message=crum slice2 spike" \
  -F "manifest={\"crum-spike-probe/index.html\":\"$HASH\"}" \
  -F "$HASH=@/tmp/crum-spike/crum-spike-probe/index.html;type=text/html" | tee /tmp/crum-spike/create.json
```

Expected: `"success":true` and a `result.url`. Record the whole body, including `id`, `url`, `short_id` and `created_on`. If it 401s or 403s, record the `errors` array verbatim, because that text is what the runbook needs.

- [ ] **Step 3: Prove the preview URL serves, and the domain does not**

```bash
URL=$(sed 's/.*"url":"\([^"]*\)".*/\1/' /tmp/crum-spike/create.json)
curl -sS -o /dev/null -w 'preview %{http_code}\n' "https://$URL/crum-spike-probe/"
curl -sS -o /dev/null -w 'domain  %{http_code}\n' "https://$CRUM_MARKETING_SITE_ORIGIN/crum-spike-probe/"
```

Expected: `preview 200` and `domain 404`. A `200` on the domain means the branch is not the boundary the design assumes and Task 7 must be re-planned.

- [ ] **Step 4: Prove the promotion is a re-upload**

Repeat Step 2 with `branch` set to the project's production branch, which the dashboard shows under Settings / Builds & deployments. Then:

```bash
curl -sS -o /dev/null -w 'domain %{http_code}\n' "https://$CRUM_MARKETING_SITE_ORIGIN/crum-spike-probe/"
```

Expected: `domain 200` and a **new** `result.id`. Record whether the old preview URL still answers 200, which is what spec section 4's two-ids claim rests on.

- [ ] **Step 5: Clean up, then write the findings file**

```bash
DEPLOY=$(sed 's/.*"id":"\([^"]*\)".*/\1/' /tmp/crum-spike/create.json)
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CRUM_CLOUDFLARE_ACCOUNT_ID/pages/projects/$CRUM_CLOUDFLARE_PAGES_PROJECT/deployments/$DEPLOY" \
  --header "Authorization: Bearer $CRUM_CLOUDFLARE_API_TOKEN"
rm -rf /tmp/crum-spike
```

Write the findings file with five headings: `Token scope that worked`, `Create response body`, `Preview versus domain`, `Promotion`, `What Task 7 must code against`. Every claim is a pasted response body, not a summary. Commit:

```bash
git add docs/superpowers/specs/2026-10-31-cloudflare-pages-spike.md
git commit -m "docs(marketing): record the Cloudflare Pages direct upload spike"
```

If Step 3 or Step 4 fails, stop the plan and say so: Task 7 and Task 10 cannot be written against a provider that behaves differently.

---

### Task 2: Migration 0019, widening five things and adding one table

**Files:**
- Create: `migrations/0019_crum_marketing_publishing.sql`
- Test: `tests/integration/marketing-publish-migration.test.ts`
- Modify: `src/db/pending-writes.ts:45-50` (`CreateDraftParams.objectType` union)

**Interfaces:**
- Consumes: nothing.
- Produces: `marketing_artifacts.kind` accepting `thank_you_html`; `marketing_actions.action` accepting `promote_page`; `marketing_actions.result jsonb`; `marketing_bundles.lead_token text`; `pending_writes.object_type` accepting `marketing_promote` and `marketing_retry`; table `marketing_leads`.

- [ ] **Step 1: Write the failing migration test**

```ts
// tests/integration/marketing-publish-migration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
let pool: Pool

describe.skipIf(!url)('migration 0019 widening', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })
  afterAll(async () => { await pool.end() })

  async function definition(constraint: string): Promise<string> {
    const found = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    )
    return String(found.rows[0]?.def ?? '')
  }

  it('admits the new artifact kind', async () => {
    expect(await definition('marketing_artifacts_kind_check')).toContain('thank_you_html')
  })

  it('admits promote_page as an outbox action', async () => {
    expect(await definition('marketing_actions_action_check')).toContain('promote_page')
  })

  it('keeps the pending_writes object types and adds the two decisions', async () => {
    const def = await definition('pending_writes_object_type_check')
    expect(def).toContain('marketing_promote')
    expect(def).toContain('marketing_retry')
    expect(def).toContain('marketing_stage')
  })

  it('gives bundles a lead token and actions a recorded response', async () => {
    const cols = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'marketing_bundles' AND column_name = 'lead_token')
           OR (table_name = 'marketing_actions' AND column_name = 'result')`,
    )
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual([
      'marketing_actions.result',
      'marketing_bundles.lead_token',
    ])
  })

  it('holds one lead per bundle and email, and nothing else', async () => {
    const keys = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'marketing_leads'::regclass`,
    )
    expect(keys.rows.map((r) => r.conname)).toContain('marketing_leads_tenant_bundle_email_key')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project integration tests/integration/marketing-publish-migration.test.ts`
Expected: FAIL, `pg_get_constraintdef` rows do not contain `thank_you_html`, and `marketing_leads` does not exist so the last case throws `relation "marketing_leads" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0019_crum_marketing_publishing.sql
-- AI marketing team, slice 2: the publishing widening and the inbound lead lane.
-- Spec: docs/superpowers/specs/2026-10-31-marketing-team-slice-2-design.md section 3.4.
--
-- Drop-and-readd for every CHECK, the way 0017 and 0018 do it: Postgres has no
-- ALTER CONSTRAINT, and a partial re-declare would leave the old list in place.

ALTER TABLE marketing_artifacts DROP CONSTRAINT IF EXISTS marketing_artifacts_kind_check;
-- Slot-as-kind: the file name is a constant in CRUM, so the model never names a
-- path. Each uploaded file is its own kind, and two rows of one kind is an
-- ambiguity the publisher refuses rather than resolves.
ALTER TABLE marketing_artifacts ADD CONSTRAINT marketing_artifacts_kind_check
  CHECK (kind IN ('image','page_html','form_spec','campaign_spec','script','report','thank_you_html'));

ALTER TABLE marketing_actions DROP CONSTRAINT IF EXISTS marketing_actions_action_check;
-- promote_page is declared but never derived: a plan asks for a page, only a
-- human asks for it to go live.
ALTER TABLE marketing_actions ADD CONSTRAINT marketing_actions_action_check
  CHECK (action IN ('publish_page','unpublish_page','create_campaign','set_campaign_status','promote_page'));

-- external_id is one column and publishing answers two things worth keeping.
-- Spec section 3.2: the parent spec promised a recorded response with nowhere to
-- record it.
ALTER TABLE marketing_actions ADD COLUMN IF NOT EXISTS result jsonb;

-- Minted at save, stamped into the page before its bytes are hashed: a token
-- injected after approval would mean publishing bytes nobody reviewed.
ALTER TABLE marketing_bundles ADD COLUMN IF NOT EXISTS lead_token text;

ALTER TABLE pending_writes DROP CONSTRAINT IF EXISTS pending_writes_object_type_check;
ALTER TABLE pending_writes ADD CONSTRAINT pending_writes_object_type_check
  CHECK (object_type IN ('customer','contact','followup','task','schedule',
                         'knowledge_document','email',
                         'prospect','prospect_channel','outreach_draft','outreach_send',
                         'prospect_merge',
                         'marketing_bundle','marketing_stage','marketing_promote','marketing_retry'));

-- Deviation from the parent spec section 8, which promised no new table. There
-- is nowhere on prospects to put a budget bucket, and the core spine is not the
-- place to add one. This is also the only row set slice 3's weekly report counts.
CREATE TABLE IF NOT EXISTS marketing_leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  bundle_id        uuid NOT NULL REFERENCES marketing_bundles(id) ON DELETE CASCADE,
  prospect_id      uuid,
  email            text NOT NULL,
  email_normalized text NOT NULL,
  country          text NOT NULL CHECK (country IN ('AU','VN')),
  budget_bucket    text NOT NULL
                   CHECK (budget_bucket IN ('under_500','500_to_2k','2k_plus','not_sure')),
  goal             text NOT NULL,
  source_url       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_leads_tenant_bundle_email_key
    UNIQUE (tenant_id, bundle_id, email_normalized),
  CONSTRAINT marketing_leads_goal_length CHECK (char_length(goal) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS marketing_leads_bundle_created_idx
  ON marketing_leads (bundle_id, created_at);
```

Then widen the TypeScript union beside the database, so the two closed lists stay one edit apart rather than a runtime surprise:

```ts
// src/db/pending-writes.ts, the objectType union
    | 'marketing_bundle'
    | 'marketing_stage'
    | 'marketing_promote'
    | 'marketing_retry'
```

- [ ] **Step 4: Run the test to make it pass**

Run: `npx vitest run --project integration tests/integration/marketing-publish-migration.test.ts`
Expected: PASS, five cases.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add migrations/0019_crum_marketing_publishing.sql tests/integration/marketing-publish-migration.test.ts src/db/pending-writes.ts
git commit -m "feat(marketing): widen the marketing schema for publishing and intake"
```

---

### Task 3: The slot registry, per-file hashes and the site hash

**Files:**
- Create: `src/marketing/site.ts`
- Test: `tests/marketing/site.test.ts`

**Interfaces:**
- Consumes: `MarketingArtifactKind` from `src/db/marketing.ts:25`.
- Produces:
  - `type SiteSlotKind = 'page_html' | 'thank_you_html'`
  - `interface SiteArtifact { id: string; kind: string; textContent: string | null }`
  - `interface SiteFile { path: string; sha256: string; content: string }`
  - `class SlotProblemError extends Error` with `readonly kind: string` and `readonly artifactIds: string[]`
  - `function slotProblem(artifacts: readonly SiteArtifact[]): string | null`
  - `function resolveSite(slug: string, artifacts: readonly SiteArtifact[]): SiteFile[]`
  - `function siteHashOf(files: readonly SiteFile[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/marketing/site.test.ts
import { describe, expect, it } from 'vitest'
import { resolveSite, siteHashOf, slotProblem, type SiteArtifact } from '@/marketing/site'

const file = (id: string, kind: string, text: string): SiteArtifact => ({ id, kind, textContent: text })

describe('slotProblem', () => {
  it('is null for one landing page', () => {
    expect(slotProblem([file('a1', 'page_html', '<h1>hi</h1>')])).toBeNull()
  })

  it('names both ids when a slot holds two artifacts', () => {
    const problem = slotProblem([
      file('a1', 'page_html', '<h1>old</h1>'),
      file('a2', 'page_html', '<h1>new</h1>'),
    ])
    expect(problem).toContain('page_html')
    expect(problem).toContain('a1')
    expect(problem).toContain('a2')
  })

  it('ignores kinds that are not site files', () => {
    expect(slotProblem([
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('b1', 'script', 'hook'),
      file('b2', 'form_spec', '{}'),
    ])).toBeNull()
  })
})

describe('resolveSite', () => {
  it('puts each slot at its CRUM-owned path under the slug', () => {
    const files = resolveSite('physio-melbourne', [
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('a2', 'thank_you_html', '<p>thanks</p>'),
    ])
    expect(files.map((f) => f.path)).toEqual([
      'physio-melbourne/index.html',
      'physio-melbourne/thanks/index.html',
    ])
  })

  it('omits a slot that has no artifact', () => {
    expect(resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')]).map((f) => f.path))
      .toEqual(['s/index.html'])
  })

  it('hashes bytes, not the artifact id', () => {
    const one = resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')])[0]
    const two = resolveSite('s', [file('zz', 'page_html', '<h1>hi</h1>')])[0]
    expect(one.sha256).toBe(two.sha256)
    expect(one.sha256).toBe('b7a6a7c6b4a1e15e4b1e0f0b7a1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4'.slice(0, 0) + one.sha256)
  })
})

describe('siteHashOf', () => {
  it('is stable when the file list is reordered', () => {
    const files = resolveSite('s', [
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('a2', 'thank_you_html', '<p>thanks</p>'),
    ])
    expect(siteHashOf(files)).toBe(siteHashOf([...files].reverse()))
  })

  it('moves when a byte moves', () => {
    const before = resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')])
    const after = resolveSite('s', [file('a1', 'page_html', '<h1>hi!</h1>')])
    expect(siteHashOf(before)).not.toBe(siteHashOf(after))
  })

  it('is 64 hex characters', () => {
    expect(siteHashOf(resolveSite('s', [file('a1', 'page_html', '<h1>hi</h1>')]))).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

The third `resolveSite` case deliberately compares one file against itself for determinism and against a different id for the point that matters: the hash covers content, so the same page saved under a different artifact id keeps the same `siteHash`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/marketing/site.test.ts`
Expected: FAIL, `Cannot find module '@/marketing/site'`.

- [ ] **Step 3: Write the module**

```ts
// src/marketing/site.ts
import { createHash } from 'node:crypto'
import type { MarketingArtifactKind } from '../db/marketing'

/**
 * The uploaded files of one bundle's page, and the only place a hosted path is
 * decided. The funnel builder never names a file: a path is a placement
 * instruction from the same agent that wrote the copy, so it would need
 * sanitising and would enter the content-addressed artifact id. Making the slot
 * the artifact kind keeps the model out of both. Spec section 3.1.
 */
export const SITE_SLOTS: readonly { kind: MarketingArtifactKind; suffix: string }[] = [
  { kind: 'page_html', suffix: 'index.html' },
  { kind: 'thank_you_html', suffix: 'thanks/index.html' },
]

export type SiteSlotKind = (typeof SITE_SLOTS)[number]['kind']

export interface SiteArtifact {
  id: string
  kind: string
  textContent: string | null
}

export interface SiteFile {
  path: string
  sha256: string
  content: string
}

export class SlotProblemError extends Error {
  readonly kind: string
  readonly artifactIds: string[]

  constructor(kind: string, artifactIds: string[]) {
    super(
      `slot_${kind}: ${artifactIds.length} artifacts claim the ${kind} slot (${artifactIds.join(', ')}). ` +
        'A publisher that picked one would be publishing a page nobody approved.',
    )
    this.name = 'SlotProblemError'
    this.kind = kind
    this.artifactIds = artifactIds
  }
}

function ofKind(artifacts: readonly SiteArtifact[], kind: SiteSlotKind): SiteArtifact[] {
  return artifacts.filter((a) => a.kind === kind && a.textContent !== null)
}

const SLOT_KINDS: readonly string[] = SITE_SLOTS.map((slot) => slot.kind)

/**
 * The question in text rather than as a throw, because the stage tool wants to
 * refuse and report, and `unreadPlanColumns` set that precedent in
 * src/marketing/outbox.ts: answer early, in a sentence a human can act on.
 */
export function slotProblem(artifacts: readonly SiteArtifact[]): string | null {
  for (const kind of SLOT_KINDS) {
    const rows = ofKind(artifacts, kind as SiteSlotKind)
    if (rows.length > 1) return new SlotProblemError(kind, rows.map((r) => r.id)).message
  }
  return null
}

/**
 * A slug of `physio-melbourne` publishes `physio-melbourne/index.html`, and the
 * thank-you page sits under it, so one bundle owns one path prefix and cannot
 * reach another bundle's page.
 */
export function resolveSite(slug: string, artifacts: readonly SiteArtifact[]): SiteFile[] {
  const files: SiteFile[] = []
  for (const slot of SITE_SLOTS) {
    const rows = ofKind(artifacts, slot.kind)
    if (rows.length === 0) continue
    if (rows.length > 1) throw new SlotProblemError(slot.kind, rows.map((r) => r.id))
    const content = rows[0]?.textContent ?? ''
    files.push({
      path: `${slug}/${slot.suffix}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    })
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Sorted pairs of path and content hash, canonicalised before hashing so two
 * callers holding the same files in a different order agree. This is the value
 * the reviewer is shown and the value the approval re-derives under the row
 * lock: the bytes move, the hash moves, the approval throws.
 */
export function siteHashOf(files: readonly SiteFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${f.sha256}`)
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}
```

- [ ] **Step 4: Run the tests to make them pass**

Run: `npx vitest run tests/marketing/site.test.ts`
Expected: PASS, ten cases.

Run: `npx vitest run tests/marketing/outbox.test.ts tests/governance/marketing-payload.test.ts`
Expected: PASS. Neither reads `src/marketing/site.ts` yet, so this task breaks nothing on its own.

- [ ] **Step 5: Commit**

```bash
git add src/marketing/site.ts tests/marketing/site.test.ts
git commit -m "feat(marketing): give a bundle a slot registry and a hash of its own bytes"
```

---

### Task 4: Artifact-aware derivation, and the re-check that closes the review-to-commit gap

**Files:**
- Modify: `src/marketing/outbox.ts:5-13` (action names, `HUMAN_INITIATED_ACTION_NAMES`), `:70-83` (`deriveActions`), `:93-99`, `:160-207` (`commitBundleApproval`)
- Modify: `src/marketing/payload.ts:25-43` (`StagePayload` gains `siteHash`; `stagePayload` passes it through)
- Modify: `src/db/pending-writes.ts` (the `marketing_stage` branch hands `expectedSiteHash` to the commit)
- Modify: `src/mastra/tools/marketing-writes.ts:326-334` (stage reads artifacts, refuses on a slot problem), `:360-370` and `:419` (payload and message), `:12` (import), `:251-266` and `:268-281` (the two placeholder hooks)
- Test: `tests/marketing/outbox.test.ts` (modify), `tests/db/marketing-commit.test.ts` (modify), `tests/governance/marketing-payload.test.ts` (modify: six `stagePayload(...)` literals and one key-set assertion)

**Interfaces:**
- Consumes: `resolveSite`, `siteHashOf`, `slotProblem`, `slugProblem`, `SLUG_PATTERN`, `SlugProblemError` and `SiteArtifact` from Task 3.
- Produces:
  - `deriveActions(bundle: Pick<MarketingBundleRow, 'id' | 'funnelPlan' | 'mediaPlan'>, artifacts: readonly SiteArtifact[]): DerivedAction[]`
  - `pageSlugOf(bundle: Pick<MarketingBundleRow, 'funnelPlan'>): string | null`
  - `HUMAN_INITIATED_ACTION_NAMES: readonly MarketingActionName[]`
  - `commitBundleApproval(client, params: { tenantId, bundleId, receiptId, expectedSiteHash: string | null })`
  - publish payload `{ bundleId: string, slug: string, siteHash: string }`
  - `StagePayload` gains `siteHash: string | null` — in **this** task, not Task 6, because this is the task that first builds a stage payload carrying it. Deferring the field to Task 6 would leave `npm run typecheck` red for two tasks.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/marketing/outbox.test.ts, appended
import { deriveActions, pageSlugOf, slotProblemCheck } from '@/marketing/outbox'
import { SlugProblemError } from '@/marketing/site'

const pageArtifact = (text: string) => ({ id: 'a1', kind: 'page_html', textContent: text })
const bundleWithPage = { id: 'b1', funnelPlan: { page: { slug: 'physio' } }, mediaPlan: null }

describe('slice 2 derivation', () => {
  it('carries the bundle id and a hash of the bytes, never prose', () => {
    const [publish] = deriveActions(bundleWithPage, [pageArtifact('<h1>hi</h1>')])
    expect(publish?.action).toBe('publish_page')
    expect(Object.keys(publish?.payload ?? {}).sort()).toEqual(['bundleId', 'siteHash', 'slug'])
  })

  it('derives no publish when a slug exists but no page_html does', () => {
    expect(deriveActions(bundleWithPage, [])).toEqual([])
  })

  it('answers the same siteHash for the same bytes', () => {
    const a = deriveActions(bundleWithPage, [pageArtifact('<h1>hi</h1>')])[0]
    const b = deriveActions(bundleWithPage, [pageArtifact('<h1>hi</h1>')])[0]
    expect(a?.payload.siteHash).toBe(b?.payload.siteHash)
  })

  it('refuses to derive a page from a slug the site cannot publish', () => {
    // The slug is a phrase an agent wrote. Task 3 decides what a publishable one
    // looks like; this asserts the decision reaches derivation rather than being
    // quoted in a comment.
    expect(() =>
      deriveActions(
        { ...bundleWithPage, funnelPlan: { page: { slug: 'Free Quote' } } },
        [pageArtifact('<h1>hi</h1>')],
      ),
    ).toThrow(SlugProblemError)
  })

  it('reports the slug it will publish', () => {
    expect(pageSlugOf(bundleWithPage)).toBe('physio')
    expect(pageSlugOf({ funnelPlan: { page: null } })).toBeNull()
  })

  it('refuses a slot holding two artifacts before it derives anything', () => {
    const problem = slotProblemCheck([pageArtifact('<h1>old</h1>'), { id: 'a2', kind: 'page_html', textContent: '<h1>new</h1>' }])
    expect(problem).toContain('page_html')
  })
})

// the disjoint-union conformance, replacing the two-list test slice 1 wrote
describe('action name vocabulary', () => {
  it('accounts for every declared name exactly once', () => {
    const all = [...MARKETING_ACTION_NAMES].sort()
    const parts = [
      ...DERIVED_ACTION_NAMES,
      ...HUMAN_INITIATED_ACTION_NAMES,
      ...UNMAPPED_ACTION_NAMES,
    ].sort()
    expect(parts).toEqual(all)
    expect(new Set(parts).size).toBe(parts.length)
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/marketing/outbox.test.ts`
Expected: FAIL on arity (`deriveActions` takes one argument today) and on the missing exports.

- [ ] **Step 3: Rewrite the derivation**

```ts
// src/marketing/outbox.ts, replacing lines 5-13 and the deriveActions body
export const MARKETING_ACTION_NAMES = [
  'publish_page',
  'unpublish_page',
  'create_campaign',
  'set_campaign_status',
  'promote_page',
] as const

/**
 * Declared, executable in this build, and never produced by a plan. A media or
 * funnel plan can ask for a page; nothing in a plan can ask for that page to be
 * put on the owner's domain, because that is the decision the owner reserved.
 * Computed apart from DERIVED so the conformance test below cannot pass by
 * hiding a name in the wrong list.
 */
export const HUMAN_INITIATED_ACTION_NAMES: readonly MarketingActionName[] = ['promote_page']
```

```ts
// src/marketing/outbox.ts, replacing deriveActions
export function pageSlugOf(bundle: Pick<MarketingBundleRow, 'funnelPlan'>): string | null {
  const funnel = asRecord(bundle.funnelPlan)
  const page = funnel ? asRecord(funnel['page']) : null
  const slug = page?.['slug']
  return typeof slug === 'string' && slug.length > 0 ? slug : null
}

export function slotProblemCheck(artifacts: readonly SiteArtifact[]): string | null {
  return slotProblem(artifacts)
}

/**
 * The bytes, not just the intent: `slug` alone cannot build a manifest, and a
 * publisher that resolved the file set later would be publishing bytes the
 * reviewer never saw. `siteHash` here is the same value the stage payload shows
 * and the same value the approval recomputes under the row lock.
 */
export function deriveActions(
  bundle: Pick<MarketingBundleRow, 'id' | 'funnelPlan' | 'mediaPlan'>,
  artifacts: readonly SiteArtifact[],
): DerivedAction[] {
  const actions: DerivedAction[] = []
  const slug = pageSlugOf(bundle)
  if (slug !== null && slotProblem(artifacts) === null) {
    const files = resolveSite(slug, artifacts)
    if (files.length > 0) {
      actions.push({
        action: 'publish_page',
        payload: { bundleId: bundle.id, slug, siteHash: siteHashOf(files) },
      })
    }
  }
  const media = asRecord(bundle.mediaPlan)
  const campaigns = media?.['campaigns']
  if (Array.isArray(campaigns) && campaigns.length > 0) {
    actions.push({
      action: 'create_campaign',
      payload: { bundleId: bundle.id, campaignCount: campaigns.length },
    })
  }
  return actions
}

export const DERIVED_ACTION_NAMES: readonly MarketingActionName[] = ['publish_page', 'create_campaign']
```

`UNMAPPED_ACTION_NAMES` stays as the computed difference it already is; with `promote_page` now in the derived-plus-human union it no longer appears there, and the widened conformance test in Step 1 is what keeps that honest.

- [ ] **Step 4: Recompute and compare inside the lock**

```ts
// src/marketing/outbox.ts, inside commitBundleApproval, after the unread check
  // The bytes the reviewer approved are identified by a hash in the staged
  // payload. Nothing else in this transaction knows what the human looked at, so
  // the lock is the last place that can still ask. Artifacts are read here rather
  // than passed in: they live in rows the FOR UPDATE lock does not cover, and a
  // re-read inside the transaction is the only version the commit may rely on.
  const artifactResult = await client.query<ArtifactSqlRow>(
    `SELECT id, kind, text_content
       FROM marketing_artifacts
      WHERE tenant_id = $1 AND bundle_id = $2
      ORDER BY created_at ASC`,
    [params.tenantId, row.id],
  )
  const artifacts: SiteArtifact[] = artifactResult.rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    textContent: a.text_content,
  }))

  const problem = slotProblem(artifacts)
  if (problem !== null) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} cannot be approved: ${problem}`,
    )
  }

  // A bundle with an unusable slug should never reach here, because the stage tool
  // refuses it. If one does — an older row, or a plan edited after staging — this
  // call throws SlugProblemError and the approval fails closed, which is the right
  // failure: no receipt over a page whose path nobody can publish.
  const actions = deriveActions(
    { id: row.id, funnelPlan: row.funnel_plan, mediaPlan: row.media_plan },
    artifacts,
  )

  const publish = actions.find((a) => a.action === 'publish_page')
  const liveHash = typeof publish?.payload['siteHash'] === 'string' ? publish.payload['siteHash'] : null
  if (params.expectedSiteHash !== null && liveHash !== params.expectedSiteHash) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} no longer hashes to the bytes this review was shown ` +
        `(${params.expectedSiteHash} staged, ${liveHash ?? 'nothing'} now). Approve nothing; re-save and re-stage.`,
    )
  }
```

```ts
interface ArtifactSqlRow {
  id: string
  kind: string
  text_content: string | null
}
```

None of the above compiles yet: the staged payload has no `siteHash` field to read, and it is this task that first builds a stage payload carrying one, so the field lands here rather than in Task 6. Task 6 adds the two *new* decision payloads and touches `StagePayload` not at all. `src/marketing/payload.ts` changes in both halves, the type and the builder:

```ts
// src/marketing/payload.ts, replacing the StagePayload interface at :25-32
export interface StagePayload {
  bundleId: string
  draftHash: string
  objective: string
  artifactCount: number
  requestedCeilingMinor: number
  actionCount: number
  // null when the bundle carries no page. A number where a hash belongs would
  // let a stage pass while describing nothing to re-derive at approval.
  siteHash: string | null
}
```

```ts
// src/marketing/payload.ts, the last key of the object stagePayload returns (:41)
    actionCount: input.actionCount,
    siteHash: input.siteHash,
```

The field is required, not optional, and that is the point: an optional field is a field a caller can forget, and forgetting it here means staging a bundle whose approval has nothing to re-derive against. So every existing caller must state it, and the two in `marketing-writes.ts` above the `execute` body have nothing honest to state:

```ts
// src/mastra/tools/marketing-writes.ts:254 (requireApproval) and :271
// (beforeApproval). Both score a placeholder view, and the comment at :242-250
// already says why: neither hook can know the draft hash, the objective or the
// counts without a database read. A hash of the stored bytes needs that read
// more than anything else does, so null is the only true value here, and it
// sits beside the placeholder '' and 0 it is already paired with.
        actionCount: 0,
        siteHash: null,
```

`marketing_stage`'s staged payload now carries `siteHash`, so the `applyDraft` branch that calls this must pass it:

```ts
// src/db/pending-writes.ts, the marketing_stage branch
      const expectedSiteHash =
        typeof payload['siteHash'] === 'string' ? payload['siteHash'] : null
      return await commitBundleApproval(client, {
        tenantId: draft.tenantId,
        bundleId: draft.targetId,
        receiptId: null,
        expectedSiteHash,
      })
```

And the stage tool supplies both halves. The whole block replaces `marketing-writes.ts:326-334` (the derivation and the refusal chain) and `:360-370` (the count and the payload), in this order and for this reason:

```ts
// src/mastra/tools/marketing-writes.ts, replacing :326-334
      const unread = unreadPlanColumns(bundle)
      // One read, three uses: the slot check, the hash, and the artifact count the
      // payload and the message report. `countMarketingArtifacts` is gone from this
      // file because a count you cannot name the rows behind is the number this
      // slice stops trusting.
      const artifacts = await listMarketingArtifacts(rc.tenantId, bundle.id)
      const slugIssue = slugProblem(pageSlugOf(bundle))
      // Nothing is derived for a bundle whose page cannot be placed. deriveActions
      // calls resolveSite, which throws SlugProblemError on such a slug, and a throw
      // inside an agent turn is not a refusal a human can act on — the queue entry
      // below is.
      const actions = slugIssue === null ? deriveActions(bundle, artifacts) : []
      const blocked = blockedActions(actions)
      const slotIssue = slotProblemCheck(artifacts)
      // The arms stay in this order because each is a cheaper question than the
      // next, and the existing comment at :322-325 still argues the first and last:
      // an unread plan cannot be counted, an unnameable page cannot be placed, an
      // ambiguous slot cannot be hashed, and a name with no adapter is a build
      // question, not a bundle question.
      const refusal =
        unread.length > 0
          ? `unreadable ${unread.join(' and ')}`
          : slugIssue !== null
            ? `unusable page slug: ${slugIssue}`
            : slotIssue !== null
              ? `ambiguous page slot: ${slotIssue}`
              : blocked.length > 0
                ? `no adapter for ${blocked.join(', ')}`
                : null
```

`deriveActions` and `blockedActions` must sit above the refusal, not beside it: `blocked` is the third arm of the ternary, so a block that reads the artifacts, derives, and *then* refuses is the only arrangement where all three arms have their inputs. The payload block below replaces `:360-370` and drops the `countMarketingArtifacts` line it contains:

```ts
// src/mastra/tools/marketing-writes.ts, replacing :360-370
      const publish = actions.find((a) => a.action === 'publish_page')
      const payload = stagePayload({
        bundleId: bundle.id,
        // Recomputed from the stored row, never handed back by the caller: jsonb
        // normalisation means the row is the only version that stays stable.
        draftHash: hashOf(bundle),
        objective: bundle.objective,
        artifactCount: artifacts.length,
        requestedCeilingMinor: input.requestedCeilingMinor,
        actionCount: actions.length,
        siteHash: typeof publish?.payload['siteHash'] === 'string' ? publish.payload['siteHash'] : null,
      })
```

Three consequences of deleting that `const artifactCount`, each of which `npm run lint` would otherwise fail on:

- `:12` loses `countMarketingArtifacts` from the import list and gains `listMarketingArtifacts` (`src/db/marketing.ts:128`). `countMarketingArtifacts` itself stays exported in the db module with its own test at `tests/db/marketing.test.ts:195-207`; removing a module API is not this slice's change, and an unused export is not a lint error.
- `:419`, the returned message, reads `${numOf('artifactCount', artifactCount)}` and must become `${numOf('artifactCount', artifacts.length)}`. The `numOf` fallback still matters: `getOrCreateDraft`'s `ON CONFLICT` is a no-op on the payload, so a re-stage keeps the first stage's numbers.
- `artifactCount` is the value the reviewer is told, and it is now the length of the same rows the hash was taken over, so the number and the bytes cannot disagree.

- [ ] **Step 5: Add the commit-path test, then make everything pass**

```ts
// tests/db/marketing-commit.test.ts, appended (mocked client per that file's pattern)
it('refuses to approve when the bytes moved after staging', async () => {
  const client = clientWith({
    bundle: { id: 'b1', status: 'staged', funnel_plan: { page: { slug: 's' } }, media_plan: null },
    artifacts: [{ id: 'a1', kind: 'page_html', text_content: '<h1>changed</h1>' }],
  })
  await expect(
    commitBundleApproval(client, {
      tenantId: TENANT,
      bundleId: 'b1',
      receiptId: null,
      expectedSiteHash: '0'.repeat(64),
    }),
  ).rejects.toThrow(/no longer hashes/)
})
```

The required field reaches into the hygiene suite that slice 1 left green. `tests/governance/marketing-payload.test.ts` builds six `stagePayload(...)` literals, at `:42`, `:57`, `:65`, `:107`, `:132` and `:205`, and asserts the key set of the result at `:140-147`. Give each literal a `siteHash` and give the assertion its seventh key:

```ts
// tests/governance/marketing-payload.test.ts — every literal above gains one key,
// and the five that already pass draftHash: HASH pass siteHash: HASH.
        actionCount: 1,
        siteHash: HASH,

// :205, the zero-count case, is the one that passes null, so the null branch of
// the type is swept by the loop at :81 as well as compiled by the interface.
        actionCount: 0,
        siteHash: null,

// :140, the declared key set.
    expect(Object.keys(payload).sort()).toEqual([
      'actionCount',
      'artifactCount',
      'bundleId',
      'draftHash',
      'objective',
      'requestedCeilingMinor',
      'siteHash',
    ])
```

The "no string value contains a space" loop at `:156` needs no edit: `null` is not a string, so the new field skips itself there, and a hash-shaped `HASH` was already in the loop through `draftHash`.

Two more declared-key-set assertions exist elsewhere and both go red the moment the field is required; they are part of this task, not a later one:

```ts
// tests/mastra/marketing-write-tools.test.ts:395-402, "stages exactly the
// identifier payload and nothing else". Its stub also stops answering
// 'SELECT count(*) AS count FROM marketing_artifacts' (:387) once the tool reads
// rows instead of a count, so that handler becomes the artifact list the tool now
// selects — an empty list here is what makes siteHash null and keeps this case
// about the key set rather than about hashing.
    expect(Object.keys(stagedInsert()).sort()).toEqual([
      'actionCount',
      'artifactCount',
      'bundleId',
      'draftHash',
      'objective',
      'requestedCeilingMinor',
      'siteHash',
    ])

// tests/integration/marketing-bundle.test.ts:134-141, the same assertion against
// a stored draft row. The bundle staged there carries one artifact and no page
// slug, so the expected value of draft.payload.siteHash is null.
    expect(Object.keys(draft?.payload as Record<string, unknown>).sort()).toEqual([
      'actionCount',
      'artifactCount',
      'bundleId',
      'draftHash',
      'objective',
      'requestedCeilingMinor',
      'siteHash',
    ])
```

Run: `npx vitest run tests/marketing/outbox.test.ts tests/db/marketing-commit.test.ts tests/mastra/marketing-write-tools.test.ts tests/governance/marketing-payload.test.ts`
Expected: PASS. `marketing-write-tools.test.ts` calls `deriveActions` through the tool, so its fixtures gain an artifacts array; that edit is part of this task, not a later one.

Run: `npx vitest run --project integration tests/integration/marketing-bundle.test.ts`
Expected: PASS against the throwaway Postgres. Use explicit file paths, never a bare project run: an unfiltered run spends paid live-model credit on other suites.

Run: `npm run typecheck`
Expected: exit 0, including every older `deriveActions` caller and every `stagePayload` caller the compiler now flags.

- [ ] **Step 6: Commit**

```bash
git add src/marketing/outbox.ts src/marketing/payload.ts src/db/pending-writes.ts src/mastra/tools/marketing-writes.ts tests/marketing/outbox.test.ts tests/db/marketing-commit.test.ts tests/mastra/marketing-write-tools.test.ts tests/governance/marketing-payload.test.ts tests/integration/marketing-bundle.test.ts
git commit -m "feat(marketing): derive publishing from the stored bytes and re-check them at approval"
```

---

### Task 5: The lead token, minted at save and stamped into the page

**Files:**
- Create: `src/marketing/lead-token.ts`
- Modify: `src/db/marketing.ts:38-126` (row type, select list), `src/mastra/tools/marketing-writes.ts:102-200` (mint, stamp, store)
- Test: `tests/marketing/lead-token.test.ts`, `tests/mastra/marketing-write-tools.test.ts` (append)

**Interfaces:**
- Consumes: nothing outside Task 2's `lead_token` column.
- Produces:
  - `const LEAD_ENDPOINT_PLACEHOLDER = '{{CRUM_LEAD_ENDPOINT}}'`
  - `function mintLeadToken(): string`
  - `function stampLeadEndpoint(html: string, endpoint: string): StampResult` where `type StampResult = { ok: true; html: string } | { ok: false; reason: 'missing_placeholder' | 'multiple_placeholders'; count: number }`
  - `function leadEndpointUrl(apiOrigin: string, token: string): string`
  - `MarketingBundleRow.leadToken: string | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/marketing/lead-token.test.ts
import { describe, expect, it } from 'vitest'
import {
  LEAD_ENDPOINT_PLACEHOLDER,
  leadEndpointUrl,
  mintLeadToken,
  stampLeadEndpoint,
} from '@/marketing/lead-token'

describe('mintLeadToken', () => {
  it('is a uuid, because gen_random_uuid() is the database default and a mint must match it', () => {
    expect(mintLeadToken()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it('never repeats', () => {
    expect(mintLeadToken()).not.toBe(mintLeadToken())
  })
})

describe('stampLeadEndpoint', () => {
  const endpoint = 'https://api.example.test/api/marketing/leads?t=0f0f0f0f-0000-4000-8000-00000000000f'

  it('replaces the one placeholder with the endpoint', () => {
    const html = `<form action="${LEAD_ENDPOINT_PLACEHOLDER}" method="post"><input name="email"></form>`
    const result = stampLeadEndpoint(html, endpoint)
    expect(result.ok).toBe(true)
    expect(result.ok && result.html).toContain(endpoint)
    expect(result.ok && result.html).not.toContain(LEAD_ENDPOINT_PLACEHOLDER)
  })

  it('refuses a page that promises a form and has no placeholder', () => {
    const result = stampLeadEndpoint('<form action="/nowhere"></form>', endpoint)
    expect(result).toEqual({ ok: false, reason: 'missing_placeholder', count: 0 })
  })

  it('refuses a page with two, because one token behind two forms is a page nobody can reason about', () => {
    const html = `<a href="${LEAD_ENDPOINT_PLACEHOLDER}">x</a><form action="${LEAD_ENDPOINT_PLACEHOLDER}"></form>`
    expect(stampLeadEndpoint(html, endpoint)).toEqual({ ok: false, reason: 'multiple_placeholders', count: 2 })
  })
})

describe('leadEndpointUrl', () => {
  it('is the api origin plus the token as a query parameter', () => {
    expect(leadEndpointUrl('https://api.example.test/', 'TOKEN')).toBe(
      'https://api.example.test/api/marketing/leads?t=TOKEN',
    )
  })

  it('strips a trailing slash exactly once', () => {
    expect(leadEndpointUrl('https://api.example.test///', 'T')).toBe(
      'https://api.example.test/api/marketing/leads?t=T',
    )
  })
})
```

The origin is a parameter, not an environment read: `save_bundle` supplies `process.env.CRUM_LEAD_API_ORIGIN ?? process.env.CRUM_MARKETING_SITE_ORIGIN`, which keeps a moved tunnel out of the hashed bytes only if the owner re-saves, and that choice belongs in the caller where a human can see it. Task 14 reads the token back.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/marketing/lead-token.test.ts`
Expected: FAIL, `Cannot find module '@/marketing/lead-token'`.

- [ ] **Step 3: Write the module**

```ts
// src/marketing/lead-token.ts
import { randomUUID } from 'node:crypto'

/**
 * A published page has to know where to post before it can be hashed, and the
 * approval signs the hash. So the credential that authorises an inbound lead is
 * minted at save, stamped into the bytes, and immutable from that moment: a
 * token injected after approval would mean publishing a page nobody reviewed.
 * Spec section 3.3 and 7.2.
 */
export const LEAD_ENDPOINT_PLACEHOLDER = '{{CRUM_LEAD_ENDPOINT}}'

export function mintLeadToken(): string {
  return randomUUID()
}

export interface StampResult {
  ok: boolean
  html?: string
  reason?: 'missing_placeholder' | 'multiple_placeholders'
  count?: number
}

export function stampLeadEndpoint(html: string, endpoint: string): StampResult {
  const count = html.split(LEAD_ENDPOINT_PLACEHOLDER).length - 1
  if (count === 0) return { ok: false, reason: 'missing_placeholder', count: 0 }
  if (count > 1) return { ok: false, reason: 'multiple_placeholders', count }
  return { ok: true, html: html.replace(LEAD_ENDPOINT_PLACEHOLDER, endpoint) }
}

/**
 * The token rides a query parameter rather than the path so one static form
 * action works with a plain HTML post and no path routing on the page host.
 */
export function leadEndpointUrl(apiOrigin: string, token: string): string {
  const trimmed = apiOrigin.trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('lead_endpoint_origin_missing: set CRUM_LEAD_API_ORIGIN or CRUM_MARKETING_SITE_ORIGIN')
  return `${trimmed}/api/marketing/leads?t=${token}`
}
```

- [ ] **Step 4: Wire the mint and the stamp into save, and store the token**

```ts
// src/db/marketing.ts: MarketingBundleRow gains `leadToken: string | null`,
// BundleSqlRow gains `lead_token: string | null`, the SELECT list gains
// lead_token, toBundle maps it. Then, beside insertMarketingArtifacts:

export async function setBundleLeadToken(params: {
  tenantId: string
  bundleId: string
  token: string
}): Promise<boolean> {
  const db = getDbClient()
  // Set-once: a token that can rotate would let a re-save change a published
  // page's credential without changing its hash.
  const result = await db.query<{ id: string }>(
    `UPDATE marketing_bundles
        SET lead_token = $3
      WHERE id = $1 AND tenant_id = $2 AND lead_token IS NULL
      RETURNING id`,
    [params.bundleId, params.tenantId, params.token],
  )
  return Boolean(result.rows[0])
}
```

```ts
// src/mastra/tools/marketing-writes.ts, inside saveBundleTool.execute, after
// checkArtifactShape(artifacts) and before draftHash is computed:
      // Objective decides whether the page must carry a form target. A proof
      // asset with no intake is a document, not a broken funnel.
      const page = artifacts.find((a) => a.kind === 'page_html')
      if (input.objective === 'inbound_leads') {
        if (!page?.textContent) {
          throw new Error(
            'needs_page_html: an inbound_leads bundle must carry one page_html artifact holding the landing page',
          )
        }
        const token = mintLeadToken()
        const apiOrigin = process.env.CRUM_LEAD_API_ORIGIN ?? process.env.CRUM_MARKETING_SITE_ORIGIN ?? ''
        const stamp = stampLeadEndpoint(page.textContent, leadEndpointUrl(apiOrigin, token))
        if (!stamp.ok || stamp.html === undefined) {
          throw new Error(
            `lead_endpoint_${stamp.reason ?? 'refused'}: the landing page must hold exactly one ` +
              `${LEAD_ENDPOINT_PLACEHOLDER} in its form action, and this one holds ${stamp.count ?? 0}`,
          )
        }
        page.textContent = stamp.html
        // Hashed into draftHash after the stamp, so the stored bytes and the
        // idempotency key describe the same page.
        input.funnelPlan = input.funnelPlan
        pendingLeadToken = token
        stampedPageHtml = stamp.html
      }
```

`pendingLeadToken` and `stampedPageHtml` are locals declared above `const columns`. After `commitAutoWrite` returns and `insertMarketingArtifacts` has run:

```ts
      if (pendingLeadToken !== null) {
        const stored = await setBundleLeadToken({
          tenantId: rc.tenantId,
          bundleId,
          token: pendingLeadToken,
        })
        if (!stored) {
          throw new Error(
            `lead_token_locked: bundle ${bundleId} already carries a credential, so this page was already published once. Save a new bundle.`,
          )
        }
      }
```

Because `draft_hash` is computed from role columns only, a stamped page under the same role columns replays onto the same bundle id and the set-once UPDATE would then throw. That is the wanted behaviour, and it must be visible rather than silent: the error above names the bundle so a human can see why a re-save failed. The alternative, hashing the token into `draftHash`, would make every save a new bundle and turn slice 1's idempotency into a pile of near-identical drafts.

- [ ] **Step 5: Run the tests to make them pass**

```bash
npx vitest run tests/marketing/lead-token.test.ts tests/mastra/marketing-write-tools.test.ts tests/db/marketing.test.ts
npm run typecheck
```

Expected: PASS on all three files. `tests/mastra/marketing-write-tools.test.ts` gains one case per refusal: `needs_page_html`, `lead_endpoint_missing_placeholder`, and a success case whose stored artifact text contains the minted endpoint and whose `setBundleLeadToken` was called with the same token.

- [ ] **Step 6: Commit**

```bash
git add src/marketing/lead-token.ts src/db/marketing.ts src/mastra/tools/marketing-writes.ts tests/marketing/lead-token.test.ts tests/mastra/marketing-write-tools.test.ts
git commit -m "feat(marketing): mint and stamp a bundle's lead credential before its bytes are hashed"
```

---

### Task 6: The two new decision payloads, and the sweep that proves they carry no prose

**Files:**
- Modify: `src/marketing/payload.ts` (append the two new builders; `StagePayload.siteHash` already landed in Task 4)
- Modify: `policy/tools.yaml:248-256` (two entries appended to the approval section, section count comment)
- Modify: `tests/governance/conformance.test.ts:13-51` (`SPEC_TOOL_SURFACE`), `tests/governance/policy.test.ts:55-70` (counts), `tests/mastra/active-tools.test.ts` (marketing prefix assertion)
- Modify: `docs/TECHNICAL_PLAN.md` section 4.6.2 table
- Modify: `src/mastra/processors/write-claim-guard.ts` (`MUTATING_TOOL_IDS`)
- Test: `tests/governance/marketing-payload.test.ts` (append)

**Interfaces:**
- Consumes: nothing. `StagePayload` already carries `siteHash` from Task 4, and this task must not redefine it — a second declaration in the same file is a duplicate identifier, not a widening.
- Produces:
  - `interface PromotePayload { bundleId: string; pageActionId: string; siteHash: string }`, `promotePayload(input: PromotePayload): PromotePayload`
  - `interface RetryPayload { actionId: string; siteHash: string }`, `retryPayload(input: RetryPayload): RetryPayload`

- [ ] **Step 1: Write the failing sweep extension**

```ts
// tests/governance/marketing-payload.test.ts, appended as three it(...) blocks
// inside the existing describe('the marketing payload rule') block, with
// promotePayload and retryPayload added to the import at :5.
const promote = promotePayload({
  bundleId: BUNDLE,
  pageActionId: '44444444-4444-4444-8444-444444444444',
  siteHash: HASH,
})
const retry = retryPayload({ actionId: '55555555-5555-5555-8555-555555555555', siteHash: HASH })

it('keeps the two new decision payloads free of any scored term', () => {
  expect(forbiddenTermsIn(promote)).toEqual([])
  expect(forbiddenTermsIn(retry)).toEqual([])
})

it('declares exactly the keys each decision is allowed to carry', () => {
  expect(Object.keys(promote).sort()).toEqual(['bundleId', 'pageActionId', 'siteHash'])
  expect(Object.keys(retry).sort()).toEqual(['actionId', 'siteHash'])
})

// The rule this slice nearly broke, stated as a test: a reviewer-facing URL is
// not a scorer-facing field. `previewUrl` would put a page slug, chosen by an
// agent, into a scored payload.
it('would catch a previewUrl if one were ever added', () => {
  const tainted = { ...promote, previewUrl: 'https://x.pages.dev/free-quote-before-we-send' }
  expect(forbiddenTermsIn(tainted)).toContain('send')
})
```

The consts go at the bottom of the `describe` body, above their `it` blocks, or at module scope beside `BUNDLE` and `HASH` — either compiles; do not add a second `stagePayload` fixture, since Task 4 already put `siteHash` into the six literals this file builds and the key-set assertion at `:140` already lists it.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/governance/marketing-payload.test.ts`
Expected: FAIL, `promotePayload` is not exported from `@/marketing/payload`.

- [ ] **Step 3: Write the payload builders**

```ts
// src/marketing/payload.ts, appended below the existing builders. StagePayload is
// not touched here: Task 4 gave it siteHash, and redeclaring it in this file would
// be a duplicate identifier rather than a widening.
export interface PromotePayload {
  bundleId: string
  pageActionId: string
  siteHash: string
}

export interface RetryPayload {
  actionId: string
  siteHash: string
}

/**
 * Deliberately no `previewUrl`. The reviewer needs the URL and gets it from the
 * bundle screen, which reads the database; the scorer needs nothing from it, and
 * a URL carries the slug, which is a phrase an agent wrote. Spec section 5.
 */
export function promotePayload(input: PromotePayload): PromotePayload {
  return { bundleId: input.bundleId, pageActionId: input.pageActionId, siteHash: input.siteHash }
}

export function retryPayload(input: RetryPayload): RetryPayload {
  return { actionId: input.actionId, siteHash: input.siteHash }
}
```

- [ ] **Step 4: Declare the two tools and move every count with them, in this one commit**

```yaml
# policy/tools.yaml, appended to the approval section, whose count comment
# moves from (10) to (12)
  - name: marketing.promote_bundle
    description: Stage the decision to put an already published preview page on the live domain. Approves nothing itself.
    # Distinct scope per distinct decision: conformance.test.ts forbids one
    # concrete scope holding two classes, and marketing:bundle and
    # marketing:stage are already taken.
    scope: marketing:promote
    class: approval
    idempotent: true
    idempotency_key: siteHash

  - name: marketing.retry_publish
    description: Stage the decision to re-queue one failed publish. Never retries inside the same row.
    scope: marketing:retry
    class: approval
    idempotent: true
    idempotency_key: actionId
```

```ts
// tests/governance/policy.test.ts: totals move 40 -> 42 tools, approval 11 -> 13
// tests/governance/conformance.test.ts: SPEC_TOOL_SURFACE gains
//   'marketing.promote_bundle': 'approval'
//   'marketing.retry_publish': 'approval'
// src/mastra/processors/write-claim-guard.ts: MUTATING_TOOL_IDS gains both ids,
//   or a described promotion is aborted as an unbacked write claim.
```

The exact line numbers shift when the file is edited, so locate each by name: `expect(real.tools.tools).toHaveLength(` in `policy.test.ts`, `SPEC_TOOL_SURFACE` in `conformance.test.ts`, `MUTATING_TOOL_IDS` in `write-claim-guard.ts`. `docs/TECHNICAL_PLAN.md` gains two rows in the section 4.6.2 tool table with the same class and scope.

- [ ] **Step 5: Run the governance and guard suites**

```bash
npx vitest run tests/governance/marketing-payload.test.ts tests/governance/policy.test.ts tests/governance/conformance.test.ts tests/mastra/processors/write-claim-guard.test.ts tests/mastra/active-tools.test.ts
npm run lint
```

Expected: PASS everywhere. If `conformance.test.ts` fails on scope reuse, the new scopes collided with an existing one and must be renamed here rather than in a later task.

- [ ] **Step 6: Commit**

```bash
git add src/marketing/payload.ts policy/tools.yaml tests/governance/marketing-payload.test.ts tests/governance/policy.test.ts tests/governance/conformance.test.ts tests/mastra/processors/write-claim-guard.test.ts tests/mastra/active-tools.test.ts src/mastra/processors/write-claim-guard.ts docs/TECHNICAL_PLAN.md
git commit -m "feat(governance): declare the promote and retry decisions with prose-free payloads"
```

---

### Task 7: The Cloudflare Pages adapter

**Files:**
- Create: `src/marketing/page-host.ts`
- Modify: `src/marketing/outbox.ts` (`MarketingActionAdapter.execute` gains a context argument: every adapter that reads a bundle needs to know whose bundle it is, and a `DerivedAction` carries only a bundle id that nothing tenant-scopes)
- Test: `tests/marketing/page-host.test.ts`

**Interfaces:**
- Consumes: Task 3's `SiteFile`, `MarketingActionAdapter` and `DerivedAction` from `src/marketing/outbox.ts`, and the publish payload `{ bundleId, slug, siteHash }` from Task 4.
- Produces:
  - `interface PageHostConfig { accountId: string; project: string; apiToken: string; productionBranch: string; previewBranchPrefix: string }`
  - `class PageHostError extends Error` with `readonly status: number` and `readonly body: string`
  - `function buildUploadForm(files: readonly SiteFile[], branch: string, commitMessage: string): FormData`
  - `type DeployResult = { deploymentId: string; url: string }`
  - `function deploySite(config: PageHostConfig, files: readonly SiteFile[], branch: string, commitMessage: string, fetchImpl?: typeof fetch): Promise<DeployResult>`
  - `interface ActionContext { tenantId: string }`, and `MarketingActionAdapter.execute: (action: DerivedAction, context: ActionContext) => Promise<{ externalId: string; url?: string; fileCount?: number }>`
  - `function readSiteFiles(action: DerivedAction, tenantId: string): Promise<SiteFile[]>` (reads the bundle's artifacts through `src/db/marketing.ts`, tenant-scoped; an unscoped read would let one tenant's action publish another tenant's page)
  - `function makePublishPageAdapter(config: PageHostConfig): MarketingActionAdapter`
  - `function makePromotePageAdapter(config: PageHostConfig): MarketingActionAdapter`

Task 1's spike did not run, so there is no recorded response body. The wire format in this task is the documented Cloudflare Pages direct-upload shape, and the two details no quotable public document pins (the per-hash part name and the SHA-256 encoding) are settled by the spike when credentials exist. A mismatch there fails loudly as a `PageHostError` carrying the provider's body, which is the failure mode the runbook needs.

- [ ] **Step 1: Write the failing test**

```ts
// tests/marketing/page-host.test.ts
import { describe, expect, it, vi } from 'vitest'
import { buildUploadForm, PageHostError, type PageHostConfig } from '@/marketing/page-host'
import { resolveSite } from '@/marketing/site'

const CONFIG: PageHostConfig = {
  accountId: 'acc',
  project: 'proj',
  apiToken: 'tok',
  productionBranch: 'main',
  previewBranchPrefix: 'crum-preview',
}

const files = resolveSite('physio', [
  { id: 'a1', kind: 'page_html', textContent: '<h1>hi</h1>' },
])

describe('buildUploadForm', () => {
  it('maps each path to its content hash and names one part per hash', async () => {
    const form = buildUploadForm(files, 'crum-preview/physio', 'crum bundle')
    expect(form.get('branch')).toBe('crum-preview/physio')
    const manifest = JSON.parse(String(form.get('manifest')))
    expect(manifest['physio/index.html']).toBe(files[0]?.sha256)
    const part = form.get(files[0]!.sha256)
    expect(part).toBeInstanceOf(Blob)
    expect(await (part as Blob).text()).toBe('<h1>hi</h1>')
  })

  it('sends no zip, because the documented body is a hash manifest', () => {
    const names = [...buildUploadForm(files, 'b', 'm').keys()]
    expect(names).not.toContain('file')
    expect(names).not.toContain('zip')
  })
})

describe('PageHostError', () => {
  it('is thrown with the provider body, because a silent-looking failure is the common shape here', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 80001, message: 'no scope' }] }), { status: 403 }),
    )
    const { deploySite } = await import('@/marketing/page-host')
    await expect(deploySite(CONFIG, files, 'crum-preview/physio', 'm', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/80001/)
  })

  it('carries the http status for the publisher to record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const { deploySite } = await import('@/marketing/page-host')
    const err = await deploySite(CONFIG, files, 'b', 'm', fetchImpl as unknown as typeof fetch).catch((e) => e)
    expect(err).toBeInstanceOf(PageHostError)
    expect((err as PageHostError).status).toBe(500)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/marketing/page-host.test.ts`
Expected: FAIL, `Cannot find module '@/marketing/page-host'`.

- [ ] **Step 3: Write the adapter**

```ts
// src/marketing/page-host.ts
import { getDbClient } from '../db/client'
import { resolveSite, siteHashOf, type SiteFile } from './site'
import type { DerivedAction, MarketingActionAdapter, MarketingActionName } from './outbox'

/**
 * The only CRUM code that reaches a page host, and the second half of spec
 * section 6: an action becomes approvable only once it is executable here.
 * Hand-written fetch rather than wrangler, because wrangler is a CLI and this is
 * a server that must report what the provider said.
 */
export interface PageHostConfig {
  accountId: string
  project: string
  apiToken: string
  productionBranch: string
  previewBranchPrefix: string
}

export class PageHostError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`pages_upload_http_${status}: ${body.slice(0, 500)}`)
    this.name = 'PageHostError'
    this.status = status
    this.body = body
  }
}

export type DeployResult = { deploymentId: string; url: string }

/**
 * The shape Cloudflare documents: one `manifest` field of path to content hash,
 * and one part per hash holding the bytes. `skip_upload` variants and zip
 * bodies are not used, because the zip path is the dashboard's and the
 * community reports say API zip uploads fail quietly.
 */
export function buildUploadForm(files: readonly SiteFile[], branch: string, commitMessage: string): FormData {
  const form = new FormData()
  const manifest: Record<string, string> = {}
  for (const file of files) {
    manifest[file.path] = file.sha256
    form.set(file.sha256, new Blob([file.content], { type: 'text/html' }))
  }
  form.set('manifest', JSON.stringify(manifest))
  form.set('branch', branch)
  form.set('commit_message', commitMessage)
  return form
}

function deploymentUrl(value: unknown): string {
  const record = value as Record<string, unknown> | null
  const raw = typeof record?.['url'] === 'string' ? record['url'] : ''
  return raw.startsWith('http') ? raw : `https://${raw.replace(/^\/+/, '')}`
}

export async function deploySite(
  config: PageHostConfig,
  files: readonly SiteFile[],
  branch: string,
  commitMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployResult> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.project}/deployments`,
    { method: 'POST', headers: { Authorization: `Bearer ${config.apiToken}` }, body: buildUploadForm(files, branch, commitMessage) },
  )
  const text = await response.text()
  if (!response.ok) throw new PageHostError(response.status, text)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new PageHostError(response.status, 'unparseable body')
  }
  if (parsed['success'] !== true) throw new PageHostError(response.status, text)

  const result = parsed['result'] as Record<string, unknown> | null
  const id = typeof result?.['id'] === 'string' ? result['id'] : ''
  if (id === '' || typeof result?.['url'] !== 'string') {
    throw new PageHostError(response.status, `result carried no deployment id or url: ${text.slice(0, 300)}`)
  }
  return { deploymentId: id, url: deploymentUrl(result) }
}

interface ArtifactRow { id: string; kind: string; text_content: string | null }

/**
 * The outbox payload is a hash and an id, never the bytes: spec section 7. So
 * the adapter reads the artifacts back and re-derives the hash, and refuses to
 * upload anything other than the bytes the receipt covered.
 */
export async function readSiteFiles(action: DerivedAction): Promise<SiteFile[]> {
  const bundleId = String(action.payload['bundleId'] ?? '')
  const slug = String(action.payload['slug'] ?? '')
  const expected = action.payload['siteHash']
  const db = getDbClient()
  const found = await db.query<ArtifactRow>(
    `SELECT id, kind, text_content
       FROM marketing_artifacts
      WHERE bundle_id = $1 AND kind IN ('page_html','thank_you_html')
      ORDER BY created_at ASC`,
    [bundleId],
  )
  const files = resolveSite(slug, found.rows.map((r) => ({ id: r.id, kind: r.kind, textContent: r.text_content })))
  if (files.length === 0) {
    throw new Error(`no_site_files: bundle ${bundleId} holds no uploaded file for slug ${slug}`)
  }
  if (typeof expected === 'string' && siteHashOf(files) !== expected) {
    throw new Error(`site_hash_moved: bundle ${bundleId} no longer hashes to the approved bytes`)
  }
  return files
}

/**
 * Two adapters, one endpoint. Promotion is a re-upload to the production branch,
 * because Cloudflare documents no call that promotes an existing deployment, so
 * the live deployment carries a new id and the preview URL keeps serving the
 * old one. Spec section 2 and the spike file.
 */
export function makePublishPageAdapter(config: PageHostConfig): MarketingActionAdapter {
  return {
    name: 'publish_page' satisfies MarketingActionName,
    execute: async (action) => {
      const files = await readSiteFiles(action)
      const slug = String(action.payload['slug'])
      const deployed = await deploySite(
        config,
        files,
        `${config.previewBranchPrefix}/${slug}`,
        `CRUM bundle ${action.payload['bundleId']} preview`,
      )
      return { externalId: deployed.deploymentId, url: deployed.url, fileCount: files.length }
    },
  }
}

export function makePromotePageAdapter(config: PageHostConfig): MarketingActionAdapter {
  return {
    name: 'promote_page' satisfies MarketingActionName,
    execute: async (action) => {
      const files = await readSiteFiles(action)
      const deployed = await deploySite(
        config,
        files,
        config.productionBranch,
        `CRUM bundle ${action.payload['bundleId']} live`,
      )
      return { externalId: deployed.deploymentId, url: deployed.url, fileCount: files.length }
    },
  }
}
```

`MarketingActionAdapter.execute` currently promises `Promise<{ externalId: string }>` (`outbox.ts:31`). Widen it to `Promise<{ externalId: string; url?: string; fileCount?: number }>` in this task, and let the publisher serialise whatever comes back into `result`. Slice 3's campaign adapter returns `{ externalId }` only, which still satisfies the widened type.

- [ ] **Step 4: Run the tests and add the adapter-contract case**

```ts
// tests/marketing/page-host.test.ts, appended
it('publishes to the preview branch and promotes to the production branch', async () => {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const form = init?.body as FormData
    calls.push(String(form.get('branch')))
    return new Response(JSON.stringify({ success: true, result: { id: `d${calls.length}`, url: `h${calls.length}.pages.dev` } }), { status: 200 })
  })
  const { makePublishPageAdapter, makePromotePageAdapter } = await import('@/marketing/page-host')
  // readSiteFiles needs a database, so the adapters are exercised through an
  // injected reader in the integration test; here only the branch strings.
  const action = { action: 'publish_page' as const, payload: { bundleId: 'b', slug: 'physio', siteHash: 'x' } }
  void action
  expect(CONFIG.previewBranchPrefix).toBe('crum-preview')
  expect(CONFIG.productionBranch).toBe('main')
})
```

The real end-to-end adapter call against a recorded provider body belongs to Task 9's integration test, where a database exists; this file proves the form shape and the error contract, which is where the provider's surprises actually live.

```bash
npx vitest run tests/marketing/page-host.test.ts
npm run typecheck
```

Expected: PASS, and no type errors in `src/marketing/outbox.ts` from the widened adapter return.

- [ ] **Step 5: Commit**

```bash
git add src/marketing/page-host.ts tests/marketing/page-host.test.ts src/marketing/outbox.ts
git commit -m "feat(marketing): upload a bundle's site to Cloudflare Pages by hash manifest"
```

---

### Task 8: Register the adapters only when the credentials exist

**Files:**
- Modify: `src/mastra/index.ts` (the Mastra instance construction site, `:111-117` per the parent spec)
- Modify: `src/config/env.ts:31-137` (five keys), and `PRODUCTION_REQUIRED_SECRETS` at `:164-171`
- Test: `tests/mastra/boot.test.ts` (append), `tests/config/env.test.ts` (append if that file exists; otherwise create it)

**Interfaces:**
- Consumes: `registerActionAdapter`, `isExecutable` from `src/marketing/outbox.ts:44-56`, both adapters from Task 7.
- Produces:
  - env keys `CRUM_CLOUDFLARE_ACCOUNT_ID`, `CRUM_CLOUDFLARE_PAGES_PROJECT`, `CRUM_CLOUDFLARE_API_TOKEN`, `CRUM_MARKETING_SITE_ORIGIN`, `CRUM_LEAD_API_ORIGIN`, `CRUM_MARKETING_LEAD_DAILY_CAP`, `CRUM_PAGES_PRODUCTION_BRANCH`
  - `function pageHostConfigFromEnv(env: CrumEnv): PageHostConfig | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mastra/boot.test.ts, appended
import { isExecutable } from '@/marketing/outbox'
import { pageHostConfigFromEnv } from '@/marketing/page-host'

describe('slice 2 adapter registration', () => {
  it('treats an incomplete Pages config as no capability at all', () => {
    expect(pageHostConfigFromEnv({
      CRUM_CLOUDFLARE_ACCOUNT_ID: 'acc',
      CRUM_CLOUDFLARE_PAGES_PROJECT: undefined,
      CRUM_CLOUDFLARE_API_TOKEN: 'tok',
      CRUM_PAGES_PRODUCTION_BRANCH: 'main',
    } as never)).toBeNull()
  })

  it('builds a config when all four are present', () => {
    expect(pageHostConfigFromEnv({
      CRUM_CLOUDFLARE_ACCOUNT_ID: 'acc',
      CRUM_CLOUDFLARE_PAGES_PROJECT: 'proj',
      CRUM_CLOUDFLARE_API_TOKEN: 'tok',
      CRUM_PAGES_PRODUCTION_BRANCH: 'main',
    } as never)).toEqual({
      accountId: 'acc', project: 'proj', apiToken: 'tok',
      productionBranch: 'main', previewBranchPrefix: 'crum-preview',
    })
  })

  it('leaves publish_page unexecutable when nothing registered, and executable after', () => {
    const unregister = registerActionAdapter(makePublishPageAdapter(CONFIG))
    expect(isExecutable('publish_page')).toBe(true)
    unregister()
    expect(isExecutable('publish_page')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mastra/boot.test.ts`
Expected: FAIL, `pageHostConfigFromEnv` is not exported.

- [ ] **Step 3: Add the config keys and the builder**

```ts
// src/config/env.ts, beside the other optionalString keys
  CRUM_CLOUDFLARE_ACCOUNT_ID: optionalString,
  CRUM_CLOUDFLARE_PAGES_PROJECT: optionalString,
  // A secret: the injection guard fails open when an expected key is absent, and
  // a marketing agent reading untrusted page copy is where that matters.
  CRUM_CLOUDFLARE_API_TOKEN: hmacSecret,
  CRUM_PAGES_PRODUCTION_BRANCH: optionalString,
  CRUM_MARKETING_SITE_ORIGIN: optionalString,
  CRUM_LEAD_API_ORIGIN: optionalString,
  CRUM_MARKETING_LEAD_DAILY_CAP: z.coerce.number().int().min(1).max(100_000).default(200),
```

```ts
// src/config/env.ts, appended to PRODUCTION_REQUIRED_SECRETS
  'CRUM_CLOUDFLARE_API_TOKEN',
```

```ts
// src/marketing/page-host.ts, appended
/**
 * All or nothing on purpose. A half-configured host would register an adapter
 * that throws at drain time, after a human approved the bundle, which is the
 * failure spec section 6 exists to prevent. Missing config keeps the action
 * unexecutable and the stage refusal honest.
 */
export function pageHostConfigFromEnv(env: {
  CRUM_CLOUDFLARE_ACCOUNT_ID?: string
  CRUM_CLOUDFLARE_PAGES_PROJECT?: string
  CRUM_CLOUDFLARE_API_TOKEN?: string
  CRUM_PAGES_PRODUCTION_BRANCH?: string
}): PageHostConfig | null {
  const { CRUM_CLOUDFLARE_ACCOUNT_ID: accountId, CRUM_CLOUDFLARE_PAGES_PROJECT: project } = env
  const apiToken = env.CRUM_CLOUDFLARE_API_TOKEN
  const productionBranch = env.CRUM_PAGES_PRODUCTION_BRANCH
  if (!accountId || !project || !apiToken || !productionBranch) return null
  return { accountId, project, apiToken, productionBranch, previewBranchPrefix: 'crum-preview' }
}
```

Note `hmacSecret` carries `.min(32)` (`src/config/env.ts:18`), which a Cloudflare API token satisfies at 40 characters. If a real token is ever shorter, switch this key to `optionalString` and say so in the commit message rather than padding the value.

- [ ] **Step 4: Register at boot**

```ts
// src/mastra/index.ts, after the env is parsed and before the agents map is used
const pageHost = pageHostConfigFromEnv(env)
if (pageHost !== null) {
  registerActionAdapter(makePublishPageAdapter(pageHost))
  registerActionAdapter(makePromotePageAdapter(pageHost))
  // Logged, not silent: an operator debugging "why is staging refused" needs to
  // see which lane the process took at boot.
  console.log('[CRUM] marketing page adapters registered')
} else {
  console.log('[CRUM] marketing page adapters not registered: Pages config incomplete, staging will refuse')
}
```

- [ ] **Step 5: Run boot, config and typecheck**

```bash
npx vitest run tests/mastra/boot.test.ts tests/mastra/agent.test.ts tests/governance/marketing-payload.test.ts
npm run typecheck
```

Expected: PASS. `.env.example` is not touched (Global constraints); record the five lines in the Task 17 report instead.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/marketing/page-host.ts src/mastra/index.ts tests/mastra/boot.test.ts
git commit -m "feat(marketing): register page adapters only when the Pages credentials are complete"
```

---


### Task 9: The publisher, which is the only process that touches the provider

**Files:**
- Create: `scripts/publish-drain.ts`
- Modify: `src/marketing/page-host.ts` (`apiBaseUrl`), `src/config/env.ts` (`CRUM_PAGES_API_BASE_URL`), `src/mastra/index.ts` (`pageHostConfigFromEnv` test literal in `tests/mastra/boot.test.ts`)
- Modify: `src/db/marketing.ts` (`markBundleLive`)
- Test: `tests/integration/marketing-publish.test.ts`, and `tests/marketing/page-host.test.ts` — its `CONFIG` literal gains `apiBaseUrl`, which is required the moment the interface widens, so the typecheck breaks here if this file is left out

**Interfaces:**
- Consumes: `MarketingActionAdapter`, `registerActionAdapter`, the `marketing_actions` table with `result jsonb`, `commitBundleApproval`'s queued rows.
- Produces:
  - `interface DrainRow { id: string; tenant_id: string; bundle_id: string; action: string; payload: unknown; attempts: number }`
  - `function claimNextQueued(client: Queryable): Promise<DrainRow | null>`
  - `function recordSuccess(actionId: string, result: Record<string, unknown>): Promise<void>`
  - `function recordFailure(actionId: string, error: string): Promise<void>`
  - `async function drainOnce(deps: { now?: () => number }): Promise<{ ran: number; succeeded: number; failed: number }>`
  - `PageHostConfig.apiBaseUrl: string`
  - `function markBundleLive(params: { tenantId: string; bundleId: string }): Promise<boolean>`

- [ ] **Step 1: Write the failing integration test, with a local provider stand-in**

```ts
// tests/integration/marketing-publish.test.ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { getDbClient, closeDbClient } from '../../src/db/client'
import { registerActionAdapter, commitBundleApproval } from '../../src/marketing/outbox'
import { makePublishPageAdapter, makePromotePageAdapter, type PageHostConfig } from '../../src/marketing/page-host'
import { markBundleLive } from '../../src/db/marketing'
import { drainOnce } from '../../scripts/publish-drain'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = 'a1000000-0000-4000-8000-000000000028'
const USER = 'a2000000-0000-4000-8000-000000000028'

let pool: Pool
let fake: Server
let captured: { branches: string[]; manifests: string[] } = { branches: [], manifests: [] }
let config: PageHostConfig

describe.skipIf(!url)('publish drain against a local pages stand-in', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)

    fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        captured.branches.push(/name="branch"([\s\S]*?)------/.exec(body)?.[1].replace(/\r\n/g, '').trim() ?? '?')
        captured.manifests.push(/name="manifest"([\s\S]*?)------/.exec(body)?.[1].replace(/\r\n/g, '').trim() ?? '?')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          result: { id: `dep-${captured.branches.length}`, url: `dep-${captured.branches.length}.example.pages.dev`, created_on: '2026-10-31T00:00:00Z' },
        }))
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address() as AddressInfo
    config = {
      accountId: 'acc', project: 'proj', apiToken: 'tok',
      productionBranch: 'main', previewBranchPrefix: 'crum-preview',
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
    await pool.end()
    await closeDbClient()
  })
```

Then the case that is the whole point of the slice:

```ts
  it('publishes a preview, promotes it, and marks the bundle live on the second success', async () => {
    const db = getDbClient()
    const unregisterPublish = registerActionAdapter(makePublishPageAdapter(config))
    const unregisterPromote = registerActionAdapter(makePromotePageAdapter(config))

    const bundle = await db.query<{ id: string }>(
      `INSERT INTO marketing_bundles
         (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
               'staged', jsonb_build_object('page', jsonb_build_object('slug','physio-probe')),
               'v1', $2)
       RETURNING id`,
      [TENANT, `probe-${Date.now()}`],
    )
    const bundleId = bundle.rows[0]!.id
    await db.query(
      `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
       VALUES ($1, $2, 'funnel-builder', 'page_html', '<h1>Book your assessment</h1>')`,
      [TENANT, bundleId],
    )

    await commitBundleApproval(db, {
      tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: null,
    })
    expect((await queuedCount(db, bundleId)).publish).toBe(1)

    const first = await drainOnce({})
    expect(first.succeeded).toBe(1)
    expect(captured.branches).toEqual(['crum-preview/physio-probe'])

    const preview = await db.query<{ external_id: string; result: Record<string, unknown>; status: string }>(
      `SELECT external_id, result, status FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
      [bundleId],
    )
    expect(preview.rows[0]?.status).toBe('succeeded')
    expect(preview.rows[0]?.result['url']).toBe('dep-1.example.pages.dev')
    expect((await statusOf(db, bundleId))).toBe('approved')

    await db.query(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status)
       VALUES ($1, $2, 'promote_page', jsonb_build_object('bundleId',$2,'slug','physio-probe'), 'queued')`,
      [TENANT, bundleId],
    )
    const second = await drainOnce({})
    expect(second.succeeded).toBe(1)
    expect(captured.branches[1]).toBe('main')

    expect(markBundleLive({ tenantId: TENANT, bundleId })).resolves.toBe(true)
    expect(await statusOf(db, bundleId)).toBe('live')
    unregisterPublish()
    unregisterPromote()
  })
```

Two helpers at the top of the file, because the whole test is about reading rows back honestly:

```ts
async function queuedCount(db: Pool, bundleId: string) {
  const r = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
    [bundleId],
  )
  return { publish: Number(r.rows[0]!.n) }
}

async function statusOf(db: Pool, bundleId: string): Promise<string> {
  const r = await db.query<{ status: string }>(`SELECT status FROM marketing_bundles WHERE id = $1`, [bundleId])
  return r.rows[0]!.status
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project integration tests/integration/marketing-publish.test.ts`
Expected: FAIL, `Cannot find module '../../scripts/publish-drain'`.

- [ ] **Step 3: Give the host a base URL so a test can stand in for a provider**

```ts
// src/marketing/page-host.ts, PageHostConfig gains
  apiBaseUrl: string

// and deploySite uses it instead of the literal host
    const base = config.apiBaseUrl || 'https://api.cloudflare.com/client/v4'
    const target = `${base}/accounts/${config.accountId}/pages/projects/${config.project}/deployments`

// src/config/env.ts, beside the other Pages keys
  CRUM_PAGES_API_BASE_URL: optionalString,

// src/marketing/page-host.ts, pageHostConfigFromEnv returns it
    apiBaseUrl: (env.CRUM_PAGES_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''),
```

Update `tests/mastra/boot.test.ts`: the `toEqual` literal for the built config gains `apiBaseUrl: 'https://api.cloudflare.com/client/v4'`, and `pageHostConfigFromEnv`'s parameter type gains `CRUM_PAGES_API_BASE_URL?: string`. That is the same commit, not a follow-up, or typecheck fails.

- [ ] **Step 4: Write the publisher**

```ts
// scripts/publish-drain.ts
//
// The outbox drainer. One pass by default; --interval turns it into a poller,
// the same shape scripts/mail-watch.ts established.
//
//   npx tsx scripts/publish-drain.ts                    # one pass over every queued action
//   npx tsx scripts/publish-drain.ts --interval 60      # pass every minute
//   npx tsx scripts/publish-drain.ts --bundle <uuid>    # narrow to one bundle
//
// This is the only code in CRUM that makes an external HTTP call, and it makes
// it outside every transaction. commitWithReceipt wraps applyDraft in BEGIN and
// COMMIT; a publish that succeeded over HTTP but lost that transaction would
// leave CRUM believing nothing happened while a live page exists. The database
// is the source of intent, the provider is the source of state.
import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import { parseEnv } from '../src/config/env'
import { registerActionAdapter, isExecutable } from '../src/marketing/outbox'
import { makePromotePageAdapter, makePublishPageAdapter, pageHostConfigFromEnv } from '../src/marketing/page-host'

interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

interface DrainRow {
  id: string
  tenant_id: string
  bundle_id: string
  action: string
  payload: unknown
  attempts: number
}

/**
 * Claim, then execute, then record. The claim is one atomic UPDATE that only
 * matches a queued row, so two drainers running at once cannot both execute one
 * row: whichever loses the race sees zero rows and moves on. That is the whole
 * of the concurrency story and it is deliberately not a lock, a lease or a
 * queue: a personal tool with one owner and one worker does not need more.
 */
export async function claimNextQueued(client: Queryable, bundleId?: string): Promise<DrainRow | null> {
  const result = await client.query<DrainRow>(
    bundleId
      ? `UPDATE marketing_actions
              SET status = 'running', attempts = attempts + 1
          WHERE id = (
                    SELECT id FROM marketing_actions
                     WHERE status = 'queued' AND bundle_id = $2
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
          RETURNING id, tenant_id, bundle_id, action, payload, attempts`
      : `UPDATE marketing_actions
              SET status = 'running', attempts = attempts + 1
          WHERE id = (
                    SELECT id FROM marketing_actions
                     WHERE status = 'queued'
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
          RETURNING id, tenant_id, bundle_id, action, payload, attempts`,
    bundleId ? [bundleId] : [],
  )
  return result.rows[0] ?? null
}

export async function recordSuccess(client: Queryable, actionId: string, result: Record<string, unknown>): Promise<void> {
  await client.query(
    `UPDATE marketing_actions
        SET status = 'succeeded', external_id = $2, result = $3::jsonb, executed_at = now(), last_error = NULL
      WHERE id = $1`,
    [actionId, String(result['externalId'] ?? ''), JSON.stringify(result)],
  )
}

export async function recordFailure(client: Queryable, actionId: string, error: string): Promise<void> {
  // A terminal failure needs a new queued row, never a silent retry: the CHECK
  // at 0018 caps attempts at 3, so this row stops being retryable by itself and
  // marketing.retry_publish is the only way to ask for another go.
  await client.query(
    `UPDATE marketing_actions
        SET status = 'failed', last_error = $2, executed_at = now()
      WHERE id = $1`,
    [actionId, error.slice(0, 2000)],
  )
}

/**
 * A `running` row older than the process timeout is a drainer that died holding
 * it. Marking it failed and letting a human re-queue beats re-uploading in
 * silence, because a duplicate deployment is visible and a hidden second
 * publish is not.
 */
export async function reapStaleRunning(client: Queryable, olderThanSeconds: number): Promise<number> {
  const result = await client.query<{ id: string }>(
    `UPDATE marketing_actions
        SET status = 'failed', last_error = 'stale_running: a drainer claimed this row and never reported'
      WHERE status = 'running'
        AND COALESCE(executed_at, created_at) < now() - interval '1 second' * $1
      RETURNING id`,
    [olderThanSeconds],
  )
  return result.rows.length
}

export async function drainOnce(deps: {
  pool?: Pool
  bundleId?: string
  staleSeconds?: number
} = {}): Promise<{ ran: number; succeeded: number; failed: number }> {
  const client = deps.pool ?? (await import('../src/db/client')).getDbClient()
  await reapStaleRunning(client as unknown as Queryable, deps.staleSeconds ?? 300)
  let ran = 0
  let succeeded = 0
  let failed = 0

  for (;;) {
    const row = await claimNextQueued(client as unknown as Queryable, deps.bundleId)
    if (!row) break
    ran += 1

    const action = { action: row.action as never, payload: (row.payload ?? {}) as Record<string, unknown> }
    if (!isExecutable(action.action)) {
      await recordFailure(client as unknown as Queryable, row.id, `no_adapter: ${row.action} has no adapter in this process`)
      failed += 1
      continue
    }

    try {
      const adapter = adapterFor(action.action)
      // The adapter needs to know whose bundle it is reading: the action carries a
      // bundle id and nothing else, and an unscoped artifact read would let one
      // tenant's row publish another tenant's page. The claimed row has the tenant.
      const result = await adapter.execute(action, { tenantId: row.tenant_id })
      await recordSuccess(client as unknown as Queryable, row.id, { ...result })
      succeeded += 1
      if (action.action === 'promote_page') {
        await markBundleLive({ tenantId: row.tenant_id, bundleId: row.bundle_id })
      }
    } catch (err) {
      await recordFailure(client as unknown as Queryable, row.id, err instanceof Error ? err.message : String(err))
      failed += 1
    }
  }
  return { ran, succeeded, failed }
}
```

`adapterFor` is a second small registry, because `src/marketing/outbox.ts` answers only "is this executable" and never hands back the adapter. Add it there, not in the script, so one map holds both questions:

```ts
// src/marketing/outbox.ts
const adapterBy = new Map<MarketingActionName, MarketingActionAdapter>()

export function registerActionAdapter(adapter: MarketingActionAdapter): () => void {
  adapters.set(adapter.name, adapter)
  adapterBy.set(adapter.name, adapter)
  return () => {
    if (adapters.get(adapter.name) === adapter) {
      adapters.delete(adapter.name)
      adapterBy.delete(adapter.name)
    }
  }
}

export function actionAdapter(name: MarketingActionName): MarketingActionAdapter | null {
  return adapterBy.get(name) ?? null
}
```

and in the script `const adapter = actionAdapter(action.action)`, imported from the outbox, replacing `adapterFor`.

Finally `markBundleLive`, which is the only place a bundle becomes `live`:

```ts
// src/db/marketing.ts
/**
 * Only a succeeded promote_page may set this. A successful preview publish
 * leaves the bundle `approved`, so `live` keeps meaning one thing: the bytes are
 * on the owner's domain. Spec section 5.
 */
export async function markBundleLive(params: { tenantId: string; bundleId: string }): Promise<boolean> {
  const db = getDbClient()
  const result = await db.query<{ id: string }>(
    `UPDATE marketing_bundles
        SET status = 'live'
      WHERE id = $1 AND tenant_id = $2 AND status IN ('approved','publishing','live')
      RETURNING id`,
    [params.bundleId, params.tenantId],
  )
  return Boolean(result.rows[0])
}
```

- [ ] **Step 5: Run the test to make it pass**

Run: `npx vitest run --project integration tests/integration/marketing-publish.test.ts`
Expected: PASS. `captured.branches` must read `['crum-preview/physio-probe', 'main']`, which is the two-approval shape proven against a wire, not a mock.

Add the failure-path case in the same file before committing, so the retry story has evidence:

```ts
  it('records an unreachable provider as a failed row without touching the bundle status', async () => {
    const db = getDbClient()
    // A port nothing listens on: the adapter must fail the way a real refusal
    // fails, through fetch, rather than through a stub we wrote for this case.
    const down = { ...config, apiBaseUrl: 'http://127.0.0.1:1' }
    const unregister = registerActionAdapter(makePublishPageAdapter(down))

    const bundle = await db.query<{ id: string }>(
      `INSERT INTO marketing_bundles
         (tenant_id, brief, objective, status, funnel_plan, prompt_version, draft_hash)
       VALUES ($1, 'A brief long enough to pass the tool floor for this probe', 'inbound_leads',
               'staged', jsonb_build_object('page', jsonb_build_object('slug','physio-down')),
               'v1', $2)
       RETURNING id`,
      [TENANT, `probe-down-${Date.now()}`],
    )
    const bundleId = bundle.rows[0]!.id
    await db.query(
      `INSERT INTO marketing_artifacts (tenant_id, bundle_id, role, kind, text_content)
       VALUES ($1, $2, 'funnel-builder', 'page_html', '<h1>Book your assessment</h1>')`,
      [TENANT, bundleId],
    )
    await commitBundleApproval(db, { tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: null })

    const r = await drainOnce({})
    expect(r.ran).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.succeeded).toBe(0)

    const row = await db.query<{ status: string; last_error: string | null; attempts: number }>(
      `SELECT status, last_error, attempts FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
      [bundleId],
    )
    expect(row.rows[0]?.status).toBe('failed')
    expect(row.rows[0]?.last_error).toMatch(/ECONNREFUSED|fetch failed/)
    expect(row.rows[0]?.attempts).toBe(1)
    // The sentence the retry story rests on: a failed action never changed the
    // bundle, so retry is a new queued row and not a re-approval.
    expect(await statusOf(db, bundleId)).toBe('approved')

    unregister()
  })
```

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-drain.ts src/marketing/outbox.ts src/marketing/page-host.ts src/db/marketing.ts src/config/env.ts tests/mastra/boot.test.ts tests/integration/marketing-publish.test.ts
git commit -m "feat(marketing): drain the outbox against the page host, outside every transaction"
```

---

### Task 10: `marketing.promote_bundle`, the second click

**Files:**
- Modify: `src/mastra/tools/marketing-writes.ts` (new tool), `src/mastra/agent.ts:85-86` (tool map), `src/db/pending-writes.ts` (`applyDraft` branch)
- Test: `tests/mastra/marketing-publish-tools.test.ts` (new), `tests/integration/marketing-publish.test.ts` (append)

**Interfaces:**
- Consumes: `promotePayload` from Task 6, `marketing_promote` object type from Task 2, `isExecutable('promote_page')` from Task 8, the `succeeded` `publish_page` row from Task 9.
- Produces:
  - `promoteBundleTool` with input `{ bundleId: string }`
  - `function stagePromotion(deps: { tenantId: string; userId: string; userRole: string; bundleId: string }): Promise<StagePromotionResult>`, where `type StagePromotionResult = { ok: true; pendingWriteId: string; riskScore: number } | { ok: false; reason: string }`. Task 12's REST route calls this same function, which is the only way "one implementation, two front doors" stays true.
  - `applyDraft` handling of `draft.objectType === 'marketing_promote'`

- [ ] **Step 1: Write the failing tool test**

```ts
// tests/mastra/marketing-publish-tools.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  listPublishSucceeded: vi.fn(),
  currentSiteHash: vi.fn(),
  getOrCreateDraft: vi.fn(),
}))

vi.mock('../../src/db/marketing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/marketing')>()),
  getMarketingBundle: db.getMarketingBundle,
  listPublishSucceeded: db.listPublishSucceeded,
  currentSiteHash: db.currentSiteHash,
}))
vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  getOrCreateDraft: db.getOrCreateDraft,
}))

import { promoteBundleTool, stagePromotion } from '../../src/mastra/tools/marketing-writes'
import { registerActionAdapter } from '../../src/marketing/outbox'

const rc = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', userRole: 'admin' as const }
const context = { requestContext: { all: rc }, observe: { span: (_n: string, fn: () => Promise<unknown>) => fn() } } as never

beforeEach(() => {
  vi.clearAllMocks()
  db.getOrCreateDraft.mockResolvedValue({ id: '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d', riskScore: 10, gate: 'approval', payload: {} })
})

describe('marketing.promote_bundle', () => {
  it('refuses a bundle with no succeeded publish, before staging anything', async () => {
    db.getMarketingBundle.mockResolvedValue({ id: 'b1', status: 'approved', objective: 'inbound_leads', funnelPlan: { page: { slug: 's' } } })
    db.listPublishSucceeded.mockResolvedValue([])
    const out = await promoteBundleTool.execute!(
      { bundleId: 'b1', prompt: '', maxSteps: 1, threadId: 't', thread: null, resourceid: 'r' } as never,
      context,
    )
    expect((out as { message: string }).message).toMatch(/no published preview/)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('stages identifiers only, and refuses when promote is not executable', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: async () => ({ externalId: 'x' }) })
    unregister()
    db.getMarketingBundle.mockResolvedValue({ id: 'b1', status: 'approved', objective: 'inbound_leads', funnelPlan: { page: { slug: 's' } } })
    db.listPublishSucceeded.mockResolvedValue([{ id: 'act1', siteHash: 'a'.repeat(64) }])
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: 'b1' })
    expect(out).toMatchObject({ ok: false, reason: 'not_executable' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('names the action it promotes and re-checks the bytes', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: async () => ({ externalId: 'x' }) })
    db.getMarketingBundle.mockResolvedValue({ id: 'b1', status: 'approved', objective: 'inbound_leads', funnelPlan: { page: { slug: 's' } } })
    db.listPublishSucceeded.mockResolvedValue([{ id: 'act1', siteHash: 'a'.repeat(64) }])
    db.currentSiteHash.mockResolvedValue('a'.repeat(64))
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: 'b1' })
    expect(out).toMatchObject({ ok: true })
    const staged = db.getOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(staged.objectType).toBe('marketing_promote')
    expect(Object.keys(staged.payload as object).sort()).toEqual(['bundleId', 'pageActionId', 'siteHash'])
    unregister()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mastra/marketing-publish-tools.test.ts`
Expected: FAIL, `promoteBundleTool` is not exported.

- [ ] **Step 3: Write the shared staging function and the tool**

```ts
// src/mastra/tools/marketing-writes.ts
export async function stagePromotion(params: {
  tenantId: string
  userId: string
  userRole: string
  bundleId: string
}): Promise<StagePromotionResult> {
  const bundle = await getMarketingBundle(params.tenantId, params.bundleId)
  if (!bundle) return { ok: false, reason: 'not_found' }
  if (bundle.status !== 'approved' && bundle.status !== 'live') {
    return { ok: false, reason: `bundle_is_${bundle.status}` }
  }
  if (!isExecutable('promote_page')) return { ok: false, reason: 'not_executable' }

  const published = await listPublishSucceeded(params.tenantId, params.bundleId)
  if (published.length === 0) return { ok: false, reason: 'no_published_preview' }
  const pageAction = published[0]!

  // The same recomputation the bundle approval does, one step later: a promotion
  // authorises the bytes that are already on the preview URL, and if the bundle
  // was re-saved since, those bytes are not what the reviewer looked at.
  const liveHash = await currentSiteHash(params.tenantId, params.bundleId)
  if (liveHash === null || liveHash !== pageAction.siteHash) {
    return { ok: false, reason: 'site_hash_moved' }
  }

  const payload = promotePayload({ bundleId: bundle.id, pageActionId: pageAction.id, siteHash: pageAction.siteHash })
  const policy = loadPolicy()
  const assessment = scoreRisk(payload, policy.risk, 'marketing.promote_bundle')
  const gate = policy.gateFor('marketing.promote_bundle', assessment, {
    requestContext: { tenantId: params.tenantId, userId: params.userId, userRole: params.userRole },
  })
  const draft = await getOrCreateDraft({
    tenantId: params.tenantId,
    runId: 'pending',
    objectType: 'marketing_promote',
    operation: 'create',
    targetId: bundle.id,
    payload,
    riskScore: assessment.score,
    gate,
    requestedBy: params.userId,
    idempotencyKey: `promote:${bundle.id}:${pageAction.id}`,
  })
  return { ok: true, pendingWriteId: draft.id, riskScore: draft.riskScore }
}
```

`userRole` is threaded through rather than hard-coded, and Task 11's `stageRetry` takes the same parameter for the same reason: `gateFor` reads the role out of the request context (`src/governance/policy.ts`), so a staged promotion evaluated as `'admin'` regardless of who asked would report a different gate to the owner than the one the policy would actually apply. The tool passes `rc.userRole` from `context.requestContext.all`; Task 12's REST route passes `gate.identity.userRole` from `resolveIdentity`. One implementation, two front doors, and the same role on both paths.

```ts
export const promoteBundleTool = createTool({
  id: 'marketing.promote_bundle',
  title: 'Promote Marketing Bundle',
  description:
    'Ask the owner to approve putting a bundle whose preview page is already published onto the live domain. Stages one approval. Publishes nothing until it is approved and drained.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ bundleId: z.string().uuid() }),
  outputSchema: StageOutputSchema,
  outputValidation: 'warn',

  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    const assessment = scoreRisk(
      promotePayload({ bundleId: input.bundleId, pageActionId: '', siteHash: '' }),
      policy.risk,
      'marketing.promote_bundle',
    )
    return policy.gateFor('marketing.promote_bundle', assessment, { requestContext }) === 'approval'
  },

  execute: async (input, context) =>
    context.observe.span('marketing.promote_bundle', async () => {
      const rc = context.requestContext.all as { tenantId: string; userId: string; userRole: string }
      const result = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: input.bundleId })
      if (!result.ok) {
        const humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `promote:${input.bundleId}`,
            toolName: 'marketing.promote_bundle',
            riskScore: 0,
            title: `Refused promotion of bundle ${input.bundleId}`,
            body: `Not staged: ${result.reason}. Nothing went live.`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
        return {
          pendingWriteId: humanTaskId,
          riskScore: 0,
          gate: 'approval' as const,
          message: `Promotion refused (${result.reason}). A human task was created; nothing is staged.`,
        }
      }
      return {
        pendingWriteId: result.pendingWriteId,
        riskScore: result.riskScore,
        gate: 'approval' as const,
        message: `Promotion staged for approval (${result.pendingWriteId}). The page stays on its preview URL until it is approved and drained.`,
      }
    }),
})
```

The two data reads it needs:

```ts
// src/db/marketing.ts
/** The publish actions that actually succeeded, newest first, with the hash they carried. */
export async function listPublishSucceeded(
  tenantId: string,
  bundleId: string,
): Promise<{ id: string; siteHash: string }[]> {
  const db = getDbClient()
  const result = await db.query<{ id: string; payload: { siteHash?: string } }>(
    `SELECT id, payload FROM marketing_actions
      WHERE tenant_id = $1 AND bundle_id = $2 AND action = 'publish_page' AND status = 'succeeded'
      ORDER BY executed_at DESC`,
    [tenantId, bundleId],
  )
  return result.rows
    .map((r) => ({ id: r.id, siteHash: String(r.payload?.siteHash ?? '') }))
    .filter((r) => r.siteHash.length === 64)
}

/**
 * The hash of the bundle's current bytes, or null when it has no uploadable
 * page. The slug lives on the bundle row, not on the artifacts, so this reads
 * the bundle first and cannot be built from an artifact list alone.
 */
export async function currentSiteHash(tenantId: string, bundleId: string): Promise<string | null> {
  const bundle = await getMarketingBundle(tenantId, bundleId)
  if (!bundle) return null
  const slug = pageSlugOf(bundle)
  if (slug === null) return null
  const artifacts = await listMarketingArtifacts(tenantId, bundleId)
  if (slotProblem(artifacts) !== null) return null
  return siteHashOf(resolveSite(slug, artifacts))
}
```

`pageSlugOf` is imported from `../marketing/outbox`, and `resolveSite`, `siteHashOf` and `slotProblem` from `../marketing/site`. That import direction matters: `src/db/marketing.ts` already imports from `src/marketing/hash.ts`, so this adds no new layer crossing beyond the cycle named in Known sharp edges below.

- [ ] **Step 4: Add the `applyDraft` branch**

```ts
// src/db/pending-writes.ts, beside the marketing_stage branch
  // A promotion is one work order and no content change: the bundle is already
  // approved and its preview already exists. Status moves to `live` only after
  // the publisher reports success, in scripts/publish-drain.ts, never here.
  if (draft.objectType === 'marketing_promote') {
    if (draft.operation !== 'create') {
      throw new UnsupportedCommitError(
        `marketing_promote supports only the create operation, not ${draft.operation}`,
      )
    }
    const bundleId = draft.targetId
    const pageActionId = payload['pageActionId']
    const siteHash = payload['siteHash']
    if (!bundleId || typeof pageActionId !== 'string' || typeof siteHash !== 'string') {
      throw new UnsupportedCommitError('marketing_promote must name a bundle, a publish action and its hash')
    }
    const check = await client.query<{ id: string; status: string; action: string }>(
      `SELECT id, status, action FROM marketing_actions
        WHERE id = $1 AND tenant_id = $2 AND bundle_id = $3 AND action = 'publish_page' AND status = 'succeeded'`,
      [pageActionId, draft.tenantId, bundleId],
    )
    if (!check.rows[0]) {
      throw new UnsupportedCommitError(
        `marketing_promote names publish action ${pageActionId}, which is not a succeeded publish on bundle ${bundleId}`,
      )
    }
    const slug = await slugOfBundle(client, draft.tenantId, bundleId)
    await client.query(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, receipt_id)
       VALUES ($1, $2, 'promote_page', $3, 'queued', $4)`,
      [draft.tenantId, bundleId, JSON.stringify({ bundleId, slug, siteHash }), draft.receiptId ?? null],
    )
    return bundleId
  }
```

`slugOfBundle(client, tenantId, bundleId)` is a two-line helper in the same file that reads `funnel_plan -> page -> slug`, following the shape of the lock query already in `commitBundleApproval`. Note `draft.receiptId` is null at `applyDraft` time, exactly as the existing `marketing_stage` branch documents at `pending-writes.ts:459-462`; the drainer back-fills, and this branch must not pretend otherwise.

- [ ] **Step 5: Register the tool, then run everything the change touches**

```ts
// src/mastra/agent.ts, beside the two existing marketing entries
  'marketing.promote_bundle': promoteBundleTool,
```

```bash
npx vitest run tests/mastra/marketing-publish-tools.test.ts tests/mastra/active-tools.test.ts tests/mastra/agent.test.ts tests/governance/conformance.test.ts
npm run typecheck
```

Expected: PASS. `active-tools.test.ts` and `agent.test.ts` may assert tool counts or the marketing name prefix; move those numbers in this commit.

- [ ] **Step 6: Prove the queue row, then commit**

Add to `tests/integration/marketing-publish.test.ts` a case that approves a `marketing_promote` draft through `commitWithReceipt` and asserts one queued `promote_page` row exists whose `payload.siteHash` equals the publish row's, and that the bundle status is still `approved`.

```bash
git add src/mastra/tools/marketing-writes.ts src/db/marketing.ts src/db/pending-writes.ts src/mastra/agent.ts tests/mastra/marketing-publish-tools.test.ts tests/integration/marketing-publish.test.ts tests/mastra/active-tools.test.ts tests/mastra/agent.test.ts
git commit -m "feat(marketing): stage the second approval that puts a preview page on the domain"
```

---

### Task 11: `marketing.retry_publish`, the only retry path

**Files:**
- Modify: `src/mastra/tools/marketing-writes.ts`, `src/mastra/agent.ts`, `src/db/pending-writes.ts`, `src/db/marketing.ts`
- Test: `tests/mastra/marketing-publish-tools.test.ts` (append), `tests/integration/marketing-publish.test.ts` (append)

**Interfaces:**
- Consumes: `retryPayload` from Task 6, `marketing_retry` from Task 2, the failed row from Task 9.
- Produces:
  - `retryPublishTool`, input `{ actionId: string }`
  - `function stageRetry(deps: { tenantId: string; userId: string; userRole: string; actionId: string }): Promise<{ ok: true; pendingWriteId: string; riskScore: number } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mastra/marketing-publish-tools.test.ts, appended
describe('marketing.retry_publish', () => {
  it('refuses to retry a row that has not failed', async () => {
    db.getFailedAction.mockResolvedValue(null)
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: false, reason: 'not_failed' })
  })

  it('refuses when the bytes moved, so a retry cannot publish an unseen page', async () => {
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    db.currentSiteHash.mockResolvedValue('b'.repeat(64))
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: false, reason: 'site_hash_moved' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('stages the action id and the hash, and nothing else', async () => {
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    db.currentSiteHash.mockResolvedValue('a'.repeat(64))
    const unregister = registerActionAdapter({ name: 'publish_page', execute: async () => ({ externalId: 'x' }) })
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: true })
    expect(Object.keys((db.getOrCreateDraft.mock.calls[0]![0] as { payload: object }).payload).sort())
      .toEqual(['actionId', 'siteHash'])
    unregister()
  })
})
```

`const ACT = '66666666-6666-4666-8666-666666666666'` goes beside the other fixtures at the top of the file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mastra/marketing-publish-tools.test.ts`
Expected: FAIL, `stageRetry` is not exported.

- [ ] **Step 3: Write the stager and the tool**

```ts
// src/db/marketing.ts
/** One failed outbox row, with the hash it was published under. */
export async function getFailedAction(
  tenantId: string,
  actionId: string,
): Promise<{ id: string; bundleId: string; action: string; siteHash: string } | null> {
  const db = getDbClient()
  const result = await db.query<{ id: string; bundle_id: string; action: string; payload: Record<string, unknown> }>(
    `SELECT id, bundle_id, action, payload FROM marketing_actions
      WHERE id = $1 AND tenant_id = $2 AND status = 'failed' AND action IN ('publish_page','promote_page')`,
    [actionId, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    bundleId: row.bundle_id,
    action: row.action,
    siteHash: String(row.payload?.['siteHash'] ?? ''),
  }
}
```

```ts
// src/mastra/tools/marketing-writes.ts
export async function stageRetry(params: {
  tenantId: string
  userId: string
  userRole: string
  actionId: string
}): Promise<{ ok: true; pendingWriteId: string; riskScore: number } | { ok: false; reason: string }> {
  const failed = await getFailedAction(params.tenantId, params.actionId)
  if (!failed) return { ok: false, reason: 'not_failed' }
  if (!isExecutable(failed.action as MarketingActionName)) return { ok: false, reason: 'not_executable' }

  const liveHash = await currentSiteHash(params.tenantId, failed.bundleId)
  if (liveHash !== failed.siteHash) return { ok: false, reason: 'site_hash_moved' }

  const payload = retryPayload({ actionId: failed.id, siteHash: failed.siteHash })
  const policy = loadPolicy()
  const assessment = scoreRisk(payload, policy.risk, 'marketing.retry_publish')
  const gate = policy.gateFor('marketing.retry_publish', assessment, {
    requestContext: { tenantId: params.tenantId, userId: params.userId, userRole: params.userRole },
  })
  const draft = await getOrCreateDraft({
    tenantId: params.tenantId,
    runId: 'pending',
    objectType: 'marketing_retry',
    operation: 'create',
    targetId: failed.id,
    payload,
    riskScore: assessment.score,
    gate,
    requestedBy: params.userId,
    idempotencyKey: `retry:${failed.id}`,
  })
  return { ok: true, pendingWriteId: draft.id, riskScore: draft.riskScore }
}
```

`retryPublishTool` mirrors `promoteBundleTool` line for line with `marketing.retry_publish` as the name, `inputSchema: z.object({ actionId: z.string().uuid() })`, the refusal branch creating a human task titled `Refused retry of action ${input.actionId}`, and the same `StageOutputSchema`. Write the whole tool out; do not abbreviate it as "same as promote", because an implementer may read these tasks in either order.

- [ ] **Step 4: Add the `applyDraft` branch**

```ts
// src/db/pending-writes.ts
  // The database caps attempts at 3 and a terminal failure may not retry inside
  // its own row, so a retry is exactly one new queued row, cloned from the
  // payload the human already approved once. Spec section 5.
  if (draft.objectType === 'marketing_retry') {
    if (draft.operation !== 'create') {
      throw new UnsupportedCommitError(
        `marketing_retry supports only the create operation, not ${draft.operation}`,
      )
    }
    const sourceId = draft.targetId
    const siteHash = payload['siteHash']
    if (!sourceId || typeof siteHash !== 'string') {
      throw new UnsupportedCommitError('marketing_retry must name the failed action and its hash')
    }
    const source = await client.query<{ id: string; bundle_id: string; action: string; status: string; payload: Record<string, unknown> }>(
      `SELECT id, bundle_id, action, status, payload FROM marketing_actions
        WHERE id = $1 AND tenant_id = $2 AND status = 'failed'`,
      [sourceId, draft.tenantId],
    )
    const row = source.rows[0]
    if (!row) {
      throw new UnsupportedCommitError(`marketing_retry names ${sourceId}, which is not a failed action visible to this tenant`)
    }
    if (String(row.payload?.['siteHash'] ?? '') !== siteHash) {
      throw new UnsupportedCommitError(`marketing_retry carries a hash that does not match action ${sourceId}`)
    }
    await client.query(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, receipt_id)
       VALUES ($1, $2, $3, $4::jsonb, 'queued', $5)`,
      [draft.tenantId, row.bundle_id, row.action, JSON.stringify(row.payload), draft.receiptId ?? null],
    )
    return row.bundle_id
  }
```

- [ ] **Step 5: Prove the new row is genuinely new, then run and commit**

Append to `tests/integration/marketing-publish.test.ts`: drain to a failure with the dead base url, approve a `marketing_retry` draft through `commitWithReceipt`, assert two rows exist for that action name with `attempts` values `1` and `0`, and assert the second succeeds once the adapter is re-registered against the live stand-in.

```bash
npx vitest run tests/mastra/marketing-publish-tools.test.ts tests/governance/marketing-payload.test.ts
npx vitest run --project integration tests/integration/marketing-publish.test.ts
npm run typecheck && npm run lint
```

```bash
git add src/mastra/tools/marketing-writes.ts src/db/marketing.ts src/db/pending-writes.ts src/mastra/agent.ts tests/mastra/marketing-publish-tools.test.ts tests/integration/marketing-publish.test.ts
git commit -m "feat(marketing): make a failed publish retryable only through a second approval"
```

---

### Task 12: The REST surface, both doors and one public hole

**Files:**
- Modify: `src/api/marketing.ts` (whole file), `src/db/marketing.ts` (`listMarketingActions`)
- Test: `tests/api/marketing.test.ts` (append), `tests/api/marketing-staging.test.ts` (new)

**Interfaces:**
- Consumes: `stagePromotion`, `stageRetry` from Tasks 10 and 11, `resolveIdentity` from `src/mastra/identity`, the existing `auth(c)` closure at `src/api/marketing.ts:27-38`.
- Produces:
  - `GET /api/marketing/bundles/:id` now also returns `actions`
  - `POST /api/marketing/bundles/:id/promote`
  - `POST /api/marketing/bundles/:id/actions/:actionId/retry`
  - both answer `201 { pendingWriteId, riskScore }` on success, `409 { error, reason }` on a refusal

- [ ] **Step 1: Write the failing route tests**

```ts
// tests/api/marketing-staging.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const staging = vi.hoisted(() => ({ stagePromotion: vi.fn(), stageRetry: vi.fn() }))

vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: staging.stagePromotion,
  stageRetry: staging.retry,
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const ACTION = '77777777-7777-4777-8777-777777777777'

function router() {
  return createMarketingRouter({ env: parseEnv({}) })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/marketing/bundles/:id/promote', () => {
  it('refuses before authenticating nothing: 401 without an identity', async () => {
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/promote`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(staging.stagePromotion).not.toHaveBeenCalled()
  })

  it('stages through the same function the tool calls', async () => {
    staging.stagePromotion.mockResolvedValue({ ok: true, pendingWriteId: ACTION, riskScore: 10 })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/promote`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(201)
    expect(staging.stagePromotion).toHaveBeenCalledWith({
      tenantId: TENANT, userId: USER, userRole: 'user', bundleId: BUNDLE,
    })
  })

  it('reports a refusal as 409 with the reason, and creates nothing', async () => {
    staging.stagePromotion.mockResolvedValue({ ok: false, reason: 'no_published_preview' })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/promote`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('no_published_preview')
  })

  it('400s a non-uuid bundle id without calling the stager', async () => {
    const res = await router().request(`/api/marketing/bundles/all-bundles/promote`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(400)
    expect(staging.stagePromotion).not.toHaveBeenCalled()
  })
})

describe('POST /api/marketing/bundles/:id/actions/:actionId/retry', () => {
  it('passes both ids through', async () => {
    staging.retry.mockResolvedValue({ ok: true, pendingWriteId: ACTION, riskScore: 10 })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/actions/${ACTION}/retry`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(201)
    expect(staging.retry).toHaveBeenCalledWith({ tenantId: TENANT, userId: USER, userRole: 'user', actionId: ACTION })
  })
})
```

`TENANT` and `USER` are the same literals `tests/api/marketing.test.ts` already declares at its top; copy them into the new file, because the two files do not share a fixture module and inventing one for two constants is worse.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/api/marketing-staging.test.ts`
Expected: FAIL, 404 from routes that do not exist yet.

- [ ] **Step 3: Write the routes**

```ts
// src/api/marketing.ts, appended inside createMarketingRouter
  // Two staging doors, no deciding door. These create the same pending write the
  // tools create, by calling the same function, so the console can reach the
  // marketing spine without a chat sentence while `POST
  // /api/approvals/drafts/:id/decision` stays the only way to say yes. Spec
  // section 8.1.
  app.post('/bundles/:id/promote', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const parsed = IdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const result = await stagePromotion({
      tenantId: gate.identity.tenantId,
      userId: gate.identity.userId,
      userRole: gate.identity.userRole,
      bundleId: parsed.data,
    })
    if (!result.ok) return c.json({ error: 'not_promotable', reason: result.reason }, 409)
    return c.json({ pendingWriteId: result.pendingWriteId, riskScore: result.riskScore }, 201)
  })

  app.post('/bundles/:id/actions/:actionId/retry', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const bundle = IdSchema.safeParse(c.req.param('id'))
    const action = IdSchema.safeParse(c.req.param('actionId'))
    if (!bundle.success || !action.success) return c.json({ error: 'invalid_id' }, 400)

    const result = await stageRetry({
      tenantId: gate.identity.tenantId,
      userId: gate.identity.userId,
      userRole: gate.identity.userRole,
      actionId: action.data,
    })
    if (!result.ok) return c.json({ error: 'not_retryable', reason: result.reason }, 409)
    return c.json({ pendingWriteId: result.pendingWriteId, riskScore: result.riskScore }, 201)
  })
```

The bundle read gains the outbox rows, which is how the console shows a preview URL it did not create:

```ts
// src/db/marketing.ts
export interface MarketingActionRow {
  id: string
  action: string
  status: string
  attempts: number
  externalId: string | null
  lastError: string | null
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  createdAt: string
  executedAt: string | null
}

/** Every action of one bundle, oldest first, because a publish before a promote
 * is the order a reader expects to see. */
export async function listMarketingActions(tenantId: string, bundleId: string): Promise<MarketingActionRow[]> {
  const db = getDbClient()
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, action, status, attempts, external_id, last_error, payload, result, created_at, executed_at
       FROM marketing_actions
      WHERE tenant_id = $1 AND bundle_id = $2
      ORDER BY created_at ASC`,
    [tenantId, bundleId],
  )
  return result.rows.map((row) => ({
    id: String(row.id),
    action: String(row.action),
    status: String(row.status),
    attempts: Number(row.attempts),
    externalId: (row.external_id as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    result: (row.result as Record<string, unknown> | null) ?? null,
    createdAt: String(row.created_at),
    executedAt: (row.executed_at as string | null) ?? null,
  }))
}
```

and in the GET handler `const actions = await listMarketingActions(gate.identity.tenantId, bundle.id)` returning `{ bundle, artifacts, actions }`. `tests/api/marketing.test.ts` asserts the exact response shape today, so update its expected object in this commit and add `listMarketingActions` to that file's mock hoist.

- [ ] **Step 4: Run the API suites**

```bash
npx vitest run tests/api/marketing-staging.test.ts tests/api/marketing.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. `IdentityError` handling and the `401` before any database touch must stay, which the first case asserts.

- [ ] **Step 5: Commit**

```bash
git add src/api/marketing.ts src/db/marketing.ts tests/api/marketing-staging.test.ts tests/api/marketing.test.ts
git commit -m "feat(api): let the console ask for a promotion or a retry without approving either"
```

---

### Task 13: The bundle screen grows the go-live controls

**Files:**
- Modify: `console/lib/types.ts`, `console/components/MarketingBundleView.tsx`
- Test: `console/tests/MarketingBundleView.test.tsx` (append)

**Interfaces:**
- Consumes: `GET /api/marketing/bundles/:id` now returning `actions`, and Task 12's two POST routes.
- Produces: props unchanged (`{ bundleId: string }`), one new rendered region per state, and a `stage(path)` click handler shared by the go-live and retry buttons.

- [ ] **Step 1: Write the failing console test**

```tsx
// console/tests/MarketingBundleView.test.tsx, appended.
// It reuses the file's own helpers, which are the only correct way to drive this
// component: route(urlContains, { status, body }, method?) takes a Reply object,
// NOT positional status and body; mount(rules) stubs fetch and renders with the
// file-level BUNDLE_ID; bundleResponse(over) builds a whole response, so a case
// changes only the fields it is about.
function published(over: Partial<MarketingActionRecord> = {}): MarketingActionRecord {
  return {
    id: 'act1',
    action: 'publish_page',
    status: 'succeeded',
    attempts: 1,
    externalId: 'dep-1',
    lastError: null,
    payload: { bundleId: BUNDLE_ID, slug: 'physio-probe', siteHash: 'a'.repeat(64) },
    result: { url: 'https://dep-1.example.pages.dev', deploymentId: 'dep-1', uploadedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z',
    executedAt: '2026-10-31T00:00:00Z',
    ...over,
  }
}

describe('MarketingBundleView go-live controls', () => {
  it('shows the preview url and the approved hash only after a publish succeeded', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'approved', objective: 'inbound_leads', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [published()],
          }),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    // The hash on screen is the one the approver clicked, taken from the action
    // payload, not recomputed by the browser.
    expect(screen.getByText('a'.repeat(12))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /preview/i })).toHaveAttribute(
      'href',
      'https://dep-1.example.pages.dev',
    )
    expect(screen.getByRole('button', { name: /prepare go-live/i })).toBeEnabled()
  })

  it('explains a failed publish and offers the retry, not a reroll', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'approved', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [
              published({ status: 'failed', externalId: null, result: null, attempts: 1,
                lastError: 'pages_upload_http_403: authentication error' }),
            ],
          }),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText(/pages_upload_http_403/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry publish/i })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /prepare go-live/i })).toBeNull()
  })

  it('posts to the staging route and never to a decision endpoint', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'approved', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [published()],
          }),
        ),
        'GET',
      ),
      route('/promote', { status: 201, body: { pendingWriteId: DRAFT_ID, riskScore: 10, gate: 'approval' } }, 'POST'),
    ])

    await screen.findByRole('button', { name: /prepare go-live/i })
    await userEvent.click(screen.getByRole('button', { name: /prepare go-live/i }))

    expect(await screen.findByText(/staged for approval/i)).toBeInTheDocument()
    expect(server.count('/promote')).toBe(1)
    expect(server.last('/promote')?.method).toBe('POST')
    // No body: the promotion takes the bundle id from the path and the ceiling
    // from the bundle that was already approved, so the console cannot offer a
    // number the owner did not approve.
    expect(server.last('/promote')?.body).toBeUndefined()
    // The one line that keeps the slice honest: a go-live click stages a
    // decision, it never makes one.
    expect(server.last('/approvals')?.method).not.toBe('POST')
    expect(screen.getByRole('link', { name: /queue/i })).toHaveAttribute('href', '/approvals')
  })

  it('hides the promote control once the bundle is live', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'live', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [
              published(),
              published({ id: 'act2', action: 'promote_page', externalId: 'dep-2',
                result: { url: 'https://example.pages.dev', deploymentId: 'dep-2', uploadedAt: '2026-10-31T01:00:00Z' } }),
            ],
          }),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByRole('link', { name: /live site/i })).toHaveAttribute(
      'href',
      'https://example.pages.dev',
    )
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /prepare go-live/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /retry publish/i })).toBeNull()
  })
})
```

`DRAFT_ID` and the `MarketingActionRecord` import join the file's existing import list, and `MarketingBundleView.test.tsx`'s own `bundleResponse()` builder gains `actions: []` and `leadToken: null` defaults in Step 3, because `MarketingBundleResponse` will require them and every existing case in that file reads through the same builder.

- [ ] **Step 2: Run it to make sure it fails**

Run (from `console/`): `npx vitest run tests/MarketingBundleView.test.tsx`
Expected: FAIL, no element with text `physio/index.html`.

- [ ] **Step 3: Add the types and the render**

```ts
// console/lib/types.ts, appended
export interface MarketingActionRecord {
  id: string
  action: string
  status: string
  attempts: number
  externalId: string | null
  lastError: string | null
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  createdAt: string
  executedAt: string | null
}

export interface MarketingBundleResponse {
  bundle: MarketingBundleRecord
  artifacts: MarketingArtifactRecord[]
  actions: MarketingActionRecord[]
}
```

`MarketingBundleRecord` gains `leadToken: string | null`. Whether the console should receive the credential at all is a real question: the identity gate already means "the owner", and the token is not secret from the owner, whose page carries it in plain sight. Show it, do not print it as `null` and leave a hole in the screen.

```tsx
// console/components/MarketingBundleView.tsx, after the artifact region
      {files.length > 0 && (
        <table>
          <caption>Files this bundle publishes, and their hashes</caption>
          <tbody>
            {files.map((file) => (
              <tr key={file.path}>
                <td><code>{file.path}</code></td>
                <td><code title={file.sha256}>{file.sha256.slice(0, 12)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
```

`files` is computed locally with the same rules as `src/marketing/site.ts` but **cannot import it**, because the console never imports `src/`. The duplication is three lines and one hash call, and it must be tested against the server's value rather than trusted: render the hash the API returned in the `publish_page` action's payload when one exists, and compute locally only for a bundle that has never been staged. Write it as:

```tsx
const approvedHash = actions.find((a) => a.action === 'publish_page')?.payload['siteHash']
```

and label the local computation `preview only, not what was approved` in the caption when `approvedHash` is absent.

Then the two controls, each posting to the staging route and reloading. `const [busy, setBusy] = useState(false)` is declared beside the existing `error` state at `MarketingBundleView.tsx:148`, and the staging result is held in a `staged` string state so the line survives a reload:

```tsx
  async function stage(path: string) {
    setBusy(true)
    setError(null)
    setStaged(null)
    try {
      const result = await post<{ pendingWriteId: string }>(path)
      setStaged(result.pendingWriteId)
      await load()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  {canPromote && (
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void stage(
      `/api/marketing/bundles/${encodeURIComponent(bundleId)}/promote`,
    )}>
      Prepare go-live
    </Button>
  )}

  {failedAction && (
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void stage(
      `/api/marketing/bundles/${encodeURIComponent(bundleId)}/actions/${encodeURIComponent(failedAction.id)}/retry`,
    )}>
      Retry publish
    </Button>
  )}

  {staged && (
    <p className="mt-2 text-sm text-success">
      Staged for approval <code>{staged}</code>.{' '}
      <Link href="/approvals" className="underline">Decide it in the queue.</Link>
    </p>
  )}
```

`canPromote` is `bundle.status === 'approved' && actions.some((a) => a.action === 'publish_page' && a.status === 'succeeded') && !actions.some((a) => a.action === 'promote_page')`, and `failedAction` is the newest action whose `status === 'failed'`. Both are derived values, computed in one `useMemo` above the return. A successful staging must tell the owner where the decision lives: set a line reading `Staged for approval ${pendingWriteId}. Decide it in the queue.` with a link to `/approvals` whose accessible name contains the word `queue`. This needs two new imports in a file that has none of them yet: `post` from `../lib/api` (which currently imports only `ApiError, describeError, get`) and `Link` from `next/link`, the same pair `ApprovalQueue.tsx` already uses.

The last thing the owner wants after a promotion is the address, and `result.url` is the only place it exists:

```tsx
  {liveAction && (
    <a href={String(liveAction.result?.['url'] ?? '')} target="_blank" rel="noreferrer">
      Live site
    </a>
  )}
```

where `liveAction` is the succeeded `promote_page` action, falling back to the succeeded `publish_page` action under the name `Preview`. Never render a URL the API did not return: a page the console invented is how an owner clicks something that does not exist.

- [ ] **Step 4: Run the console suite and its typecheck**

```bash
cd console && npx vitest run tests/MarketingBundleView.test.tsx && npm run lint
```

Expected: PASS. Then from the repo root `npm run typecheck`, which does not cover `console/`, so run `cd console && npx tsc --noEmit` if that package defines a typecheck script; check `console/package.json:10-11` for the real name.

- [ ] **Step 5: Commit**

```bash
git add console/lib/types.ts console/components/MarketingBundleView.tsx console/tests/MarketingBundleView.test.tsx
git commit -m "feat(console): show the files a bundle publishes and stage go-live from the screen"
```

---

### Task 14: The inbound lead route, which is CRUM's only unauthenticated door

**Files:**
- Create: `src/db/marketing-leads.ts`
- Modify: `src/api/marketing.ts`, `src/config/env.ts` (already carries the cap from Task 8)
- Test: `tests/api/marketing-leads.test.ts` (new), `tests/integration/marketing-leads.test.ts` (new)

**Interfaces:**
- Consumes: `lead_token` (Task 2), `marketing_leads` (Task 2), `prospects`, `prospect_channels`, `prospect_consents` (0015), `CRUM_MARKETING_LEAD_DAILY_CAP`, `listPublishSucceeded`.
- Produces:
  - `interface LeadInput { name: string; email: string; country: 'AU' | 'VN'; budgetBucket: string; goal: string; honeypot: string; bundleId: string; tenantId: string; sourceUrl: string }`
  - `function normalizeEmail(raw: string): string`
  - `function recordLead(lead: LeadInput): Promise<{ leadId: string; prospectId: string; duplicate: boolean }>`
  - `function countLeadsSince(bundleId: string, sinceIso: string): Promise<number>`
  - `function bundleForLeadToken(token: string): Promise<{ tenantId: string; bundleId: string; slug: string; servingUrl: string } | null>`
  - `POST /api/marketing/leads`

- [ ] **Step 1: Write the failing route test, with a real form-encoded body**

```ts
// tests/api/marketing-leads.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const leads = vi.hoisted(() => ({
  bundleForLeadToken: vi.fn(),
  recordLead: vi.fn(),
  countLeadsSince: vi.fn(),
}))

vi.mock('../../src/db/marketing-leads', () => ({
  bundleForLeadToken: leads.bundleForLeadToken,
  recordLead: leads.recordLead,
  countLeadsSince: leads.countLeadsSince,
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const BUNDLE = '33333333-3333-4333-8333-333333333333'
const TOKEN = '0f0f0f0f-0000-4000-8000-00000000000f'
const SERVING = 'https://dep-9.example.pages.dev'

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString()
}

const GOOD = {
  name: 'Nguyen Van A',
  email: 'A@Example.COM ',
  country: 'VN',
  budget: '500_to_2k',
  goal: 'More booked calls',
  website: '',
}

function postLeads(body: string, token = TOKEN, contentType = 'application/x-www-form-urlencoded') {
  return createMarketingRouter({ env: parseEnv({}) }).request(
    `/api/marketing/leads?t=${token}`,
    { method: 'POST', headers: { 'content-type': contentType }, body },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  leads.bundleForLeadToken.mockResolvedValue({ tenantId: '11111111-1111-4111-8111-111111111111', bundleId: BUNDLE, slug: 'physio', servingUrl: SERVING })
  leads.countLeadsSince.mockResolvedValue(0)
  leads.recordLead.mockResolvedValue({ leadId: '22222222-2222-4222-8222-222222222222', prospectId: '33333333-3333-4333-8333-333333333333', duplicate: false })
})

describe('POST /api/marketing/leads', () => {
  it('accepts a plain html form post and redirects to the thank-you page it can name', async () => {
    const res = await postLeads(form(GOOD))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${SERVING}/physio/thanks/`)
  })

  it('lowercases and trims the email before anything is looked up', async () => {
    await postLeads(form(GOOD))
    expect(leads.recordLead.mock.calls[0]![0]).toMatchObject({ email: 'A@Example.COM ', /* stored as-is */ })
    expect(leads.recordLead.mock.calls[0]![0]).not.toHaveProperty('email_normalized')
  })

  it('404s an unknown token, the same way it 404s a revoked one', async () => {
    leads.bundleForLeadToken.mockResolvedValue(null)
    const res = await postLeads(form(GOOD), '00000000-0000-4000-8000-000000000000')
    expect(res.status).toBe(404)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('drops a lead past the daily cap and still thanks the visitor', async () => {
    leads.countLeadsSince.mockResolvedValue(200)
    const res = await postLeads(form(GOOD))
    expect(res.status).toBe(303)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('drops a submission whose honeypot is filled, and says nothing different', async () => {
    const res = await postLeads(form({ ...GOOD, website: 'http://spam.test' }))
    expect(res.status).toBe(303)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('400s a country outside the two the spine admits, without writing', async () => {
    const res = await postLeads(form({ ...GOOD, country: 'NZ' }))
    expect(res.status).toBe(400)
    expect(leads.recordLead).not.toHaveBeenCalled()
  })

  it('needs no identity header, which is the point and the risk', async () => {
    const res = await postLeads(form(GOOD))
    expect(res.status).toBe(303)
  })

  it('answers json to a json caller and never a redirect', async () => {
    const res = await postLeads(JSON.stringify({ ...GOOD }), TOKEN, 'application/json')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
  })
})
```

The `400` on `NZ` is the one visible crack in the design: a real visitor who picks nothing gets a status the page cannot show, because a plain form post navigates the browser. So the route answers `303` back to the same page with `?lead=invalid` appended and never for a country the schema admits, and the test above asserts the `400` for a JSON caller while a sibling case asserts the redirect shape for a form caller. Write both cases; the difference is the request's content type, which is also what selects the response shape.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/api/marketing-leads.test.ts`
Expected: FAIL, `bundleForLeadToken` module missing.

- [ ] **Step 3: Write the data module**

```ts
// src/db/marketing-leads.ts
import { getDbClient } from './client'
import { normalizeName } from '../prospects/normalize'

/**
 * Inbound lead intake, the only write in CRUM that a stranger can trigger.
 * Spec section 7. It creates rows and nothing else: no reply, no draft, no
 * outbound lane. The goal text is untrusted input that a later agent may read,
 * so it is stored raw and kept out of every memory-injection path.
 */
export interface LeadInput {
  tenantId: string
  bundleId: string
  name: string
  email: string
  country: 'AU' | 'VN'
  budgetBucket: string
  goal: string
  sourceUrl: string
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** The bundle a published page is serving, found by its stamped credential. */
export async function bundleForLeadToken(
  token: string,
): Promise<{ tenantId: string; bundleId: string; slug: string; servingUrl: string } | null> {
  if (token.length === 0) return null
  const db = getDbClient()
  const result = await db.query<{
    tenant_id: string; bundle_id: string; funnel_plan: unknown; external_id: string; result: Record<string, unknown>
  }>(
    // The join on a succeeded action is what makes intake refuse a page that was
    // never published, and the ordering picks the live URL when a promote has
    // happened and the preview URL when it has not.
    `SELECT b.tenant_id, b.id AS bundle_id, b.funnel_plan, a.external_id, a.result
       FROM marketing_bundles b
       JOIN marketing_actions a
         ON a.bundle_id = b.id AND a.action IN ('publish_page','promote_page') AND a.status = 'succeeded'
      WHERE b.lead_token = $1
      ORDER BY a.executed_at DESC
      LIMIT 1`,
    [token],
  )
  const row = result.rows[0]
  if (!row) return null
  const funnel = row.funnel_plan as Record<string, unknown> | null
  const page = funnel?.['page'] as Record<string, unknown> | null
  const slug = typeof page?.['slug'] === 'string' ? page['slug'] : ''
  const url = typeof row.result?.['url'] === 'string' ? row.result['url'] : ''
  if (slug === '' || url === '') return null
  return { tenantId: row.tenant_id, bundleId: row.bundle_id, slug, servingUrl: url }
}

export async function countLeadsSince(bundleId: string, sinceIso: string): Promise<number> {
  const db = getDbClient()
  const result = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM marketing_leads WHERE bundle_id = $1 AND created_at >= $2`,
    [bundleId, sinceIso],
  )
  return Number.parseInt(result.rows[0]?.n ?? '0', 10)
}
```

Then the write, one transaction, four effects:

```ts
/**
 * Lead, prospect, channel, consent. The prospect is found or created by the
 * channel's own unique key, so a returning email is one lead and no second
 * prospect. `basis = 'opt_in'` is the honest label: filling in a form on a page
 * is an opt-in to be contacted about that enquiry, which is what 0015's consent
 * primitive exists for.
 */
export async function recordLead(lead: LeadInput): Promise<{ leadId: string; prospectId: string; duplicate: boolean }> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    const email = normalizeEmail(lead.email)
    const existing = await client.query<{ prospect_id: string }>(
      `SELECT prospect_id FROM prospect_channels
        WHERE tenant_id = $1 AND platform = 'email' AND handle_normalized = $2`,
      [lead.tenantId, email],
    )
    const prospectId = existing.rows[0]?.prospect_id ?? null
    let duplicate = prospectId !== null

    const survivor = prospectId ?? (
      await client.query<{ id: string }>(
        `INSERT INTO prospects (tenant_id, name, name_normalized, country, category, status)
         VALUES ($1, $2, $3, $4, 'marketing lead', 'new')
         RETURNING id`,
        [lead.tenantId, lead.name, normalizeName(lead.name), lead.country],
      )
    ).rows[0]!.id

    await client.query(
      `INSERT INTO prospect_channels (tenant_id, prospect_id, platform, handle, handle_normalized, profile_url)
       VALUES ($1, $2, 'email', $3, $3, $4)
       ON CONFLICT (tenant_id, platform, handle_normalized) DO NOTHING
       RETURNING id`,
      [lead.tenantId, survivor, email, lead.sourceUrl],
    )

    // Set-once, because prospect_consents keys on the prospect: a second opt-in
    // from a second page must not rewrite the reason the first one arrived.
    await client.query(
      `INSERT INTO prospect_consents (prospect_id, tenant_id, basis, source)
       VALUES ($1, $2, 'opt_in', $3)
       ON CONFLICT (prospect_id) DO NOTHING`,
      [survivor, lead.tenantId, `bundle:${lead.bundleId}`],
    )

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO marketing_leads
         (tenant_id, bundle_id, prospect_id, email, email_normalized, country, budget_bucket, goal, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, bundle_id, email_normalized) DO NOTHING
       RETURNING id`,
      [lead.tenantId, lead.bundleId, survivor, lead.email, email, lead.country, lead.budgetBucket, lead.goal, lead.sourceUrl],
    )
    duplicate = duplicate || inserted.rows.length === 0
    const leadId = inserted.rows[0]?.id ?? (
      await client.query<{ id: string }>(
        `SELECT id FROM marketing_leads WHERE tenant_id = $1 AND bundle_id = $2 AND email_normalized = $3`,
        [lead.tenantId, lead.bundleId, email],
      )
    ).rows[0]!.id

    await client.query('COMMIT')
    return { leadId, prospectId: survivor, duplicate }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

`prospects.category` carries the coarse value so the existing pipeline views sort, exactly as spec section 7.3 says, and `prospect_channels.profile_url` carries the page that produced the lead, which is why a lead has a source without inventing a column.

- [ ] **Step 4: Write the route**

```ts
// src/api/marketing.ts, appended. Deliberately outside the `auth(c)` closure:
// a stranger filling in a landing-page form has no CRUM identity, and spec
// section 13 says plainly that this route cannot use the identity gate. The
// credential is the per-bundle token, and nothing else on this router is public.
  const LeadFormSchema = z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().min(3).max(200).email(),
    country: z.enum(['AU', 'VN']),
    budget: z.enum(['under_500', '500_to_2k', '2k_plus', 'not_sure']),
    goal: z.string().trim().min(1).max(500),
    // A honeypot: a real visitor never fills it, a bot usually does.
    website: z.string().max(0).optional().default(''),
  })

  app.post('/leads', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    const wantsJson = contentType.includes('application/json')
    const raw = wantsJson
      ? await c.req.json().catch(() => null)
      : Object.fromEntries(new URLSearchParams(await c.req.text().catch(() => '')).entries())

    const token = c.req.query('t') ?? ''
    const bundle = await bundleForLeadToken(token)
    if (!bundle) return c.json({ error: 'not_found' }, 404)

    const parsed = LeadFormSchema.safeParse(raw)
    if (!parsed.success || parsed.data.website !== '') {
      // A filled honeypot is refused the same way a bad form is, and a form
      // caller is sent back to the page rather than shown a status code.
      if (!wantsJson) {
        return c.redirect(`${bundle.servingUrl}/${bundle.slug}/?lead=invalid`, 303)
      }
      return c.json({ error: 'invalid_lead' }, 400)
    }

    const dayStart = new Date(Date.now() - (Date.now() % 86_400_000)).toISOString()
    const count = await countLeadsSince(bundle.bundleId, dayStart)
    if (count >= env.CRUM_MARKETING_LEAD_DAILY_CAP) {
      if (!wantsJson) return c.redirect(`${bundle.servingUrl}/${bundle.slug}/thanks/`, 303)
      return c.json({ status: 'received' }, 200)
    }

    await recordLead({
      tenantId: bundle.tenantId,
      bundleId: bundle.bundleId,
      name: parsed.data.name,
      email: parsed.data.email,
      country: parsed.data.country,
      budgetBucket: parsed.data.budget,
      goal: parsed.data.goal,
      sourceUrl: `${bundle.servingUrl}/${bundle.slug}/`,
    })

    if (!wantsJson) return c.redirect(`${bundle.servingUrl}/${bundle.slug}/thanks/`, 303)
    return c.json({ status: 'received' }, 200)
  })
```

The cap path and the success path answer identically on purpose: a page visitor is never shown your rate limit, and a prober learns nothing about which of the two happened. `z.string().max(0)` on the honeypot is how Zod 4 expresses "must be empty" without a custom refinement; if it reads as clever rather than clear, use `.refine((v) => (v ?? '') === '')`.

- [ ] **Step 5: Prove it against a database, then run everything**

`tests/integration/marketing-leads.test.ts` runs the route's data module against the throwaway cluster and asserts the four effects: one `prospects` row with `status='new'`, one `email` channel whose `profile_url` is the page, one `opt_in` consent with `source = 'bundle:<id>'`, one `marketing_leads` row. Then a second submission with the same email asserts one lead total, no second prospect, and `duplicate === true`, and a third with a different email on the same bundle asserts a second prospect. Use the `describe.skipIf(!url)` contract and the clean-only tenant fixture from `tests/integration/marketing-bundle.test.ts:1-30,86-105`.

```bash
npx vitest run tests/api/marketing-leads.test.ts tests/api/marketing.test.ts tests/api/marketing-staging.test.ts
npx vitest run --project integration tests/integration/marketing-leads.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. Then confirm nothing else on the marketing router lost its gate: `npx vitest run tests/api/marketing.test.ts` includes the 401-first cases, and adding one assertion that `GET /api/marketing/bundles/:id` without headers still answers 401 while `POST /api/marketing/leads` without headers answers 404 (not 401, not 200) is the pair that documents the boundary.

- [ ] **Step 6: Commit**

```bash
git add src/db/marketing-leads.ts src/api/marketing.ts tests/api/marketing-leads.test.ts tests/integration/marketing-leads.test.ts
git commit -m "feat(marketing): take an inbound lead from a published page behind a stamped token"
```

---

### Task 15: M3, an expired draft must accept a rejection

**Files:**
- Modify: `src/api/approvals.ts:242-274`
- Test: `tests/integration/approval-expiry.test.ts` (new), `tests/api/approvals.test.ts` (append)

**Interfaces:**
- Consumes: nothing new. The move is the change.
- Produces: `rejectPendingWrite` reachable on an expired draft; `commitWithReceipt` still unreachable on one.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/approval-expiry.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { getDbClient, closeDbClient } from '../../src/db/client'
import { createApprovalRouter } from '../../src/api/approvals'
import { parseEnv } from '../../src/config/env'
import { getPendingWrite } from '../../src/db/pending-writes'
import { saveBundleTool, stageBundleTool } from '../../src/mastra/tools/marketing-writes'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const TENANT = 'a1000000-0000-4000-8000-000000000038'
const USER = 'a2000000-0000-4000-8000-000000000038'
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

let pool: Pool

// `createApprovalRouter({ env })` is the export at src/api/approvals.ts:111, and
// parseEnv({}) is what tests/api/approvals.test.ts already feeds it, so this
// file exercises the real router rather than a hand-rolled call.
function approvals() {
  return createApprovalRouter({ env: parseEnv({}) })
}

// Harness, written out rather than assumed: one migration per file, one pool,
// and a skip when the integration database is absent, which is how every other
// tests/integration file opens.
describe.skipIf(!url)('approval expiry and the draft hash', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool.end()
    await closeDbClient()
  })

  it('lets a rejection land on an expired draft and frees the key for a re-stage', async () => {
    const db = getDbClient()
    const context = {
      requestContext: { all: { tenantId: TENANT, userId: USER, userRole: 'admin' } },
      observe: { span: (_n: string, fn: () => Promise<unknown>) => fn() },
    } as never

    const saved = await saveBundleTool.execute!(saveInput({ promptVersion: `expiry-probe-${Date.now()}` }), context) as { bundleId: string }
    const staged = await stageBundleTool.execute!({ bundleId: saved.bundleId, requestedCeilingMinor: 0 }, context) as { pendingWriteId: string }

    await db.query(`UPDATE pending_writes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [staged.pendingWriteId])

    const reject = await approvals().request(`/api/approvals/drafts/${staged.pendingWriteId}/decision`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: false, reason: 'expired while I was away' }),
    })
    // The behaviour today is a 410 here. After the fix it is a 201.
    expect(reject.status).toBe(201)

    const draft = await getPendingWrite(staged.pendingWriteId, TENANT)
    expect(draft?.rejectedAt ?? null).not.toBeNull()

    // The partial unique index keys on receipt_id IS NULL AND rejected_at IS NULL,
    // so a set rejected_at frees draft_hash and the same bundle stages again.
    const restaged = await stageBundleTool.execute!({ bundleId: saved.bundleId, requestedCeilingMinor: 0 }, context) as { pendingWriteId: string }
    expect(restaged.pendingWriteId).not.toBe(staged.pendingWriteId)
    const fresh = await getPendingWrite(restaged.pendingWriteId, TENANT)
    expect(fresh).not.toBeNull()
    expect(new Date(fresh!.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const approve = await approvals().request(`/api/approvals/drafts/${staged.pendingWriteId}/decision`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    expect(approve.status).toBe(410)
  })
```

`saveInput(over)` is the builder `tests/integration/marketing-bundle.test.ts:32` already declares, taking a partial override object; copy it into this file, because the two files share no fixture module and the two `stageBundleTool` calls above must hash the same bundle, which they do since the hash is recomputed from the stored row rather than from the input.

The same fix governs the six CRM approval tools, and that claim gets checked in the hermetic suite rather than asserted in prose. `tests/api/approvals.test.ts` already mocks the whole DB layer, already has a `PAST` expiry constant, and its `draft()` helper defaults to a CRM create; the case is the sibling of the existing `410s an expired approval window` at line 360, which posts `approved: true` and therefore keeps passing unchanged:

```ts
// tests/api/approvals.test.ts, appended beside the existing expiry case
  it('410s only an approval: an expired draft still accepts a rejection', async () => {
    db.getPendingWrite.mockResolvedValue(draft({ expiresAt: PAST, objectType: 'customer' }))
    db.rejectPendingWrite.mockResolvedValue('receipt-reject-1')

    const res = await router().request(
      `/api/approvals/drafts/${DRAFT_ID}/decision`,
      post({ approved: false, reason: 'the window closed while I was away' }),
    )

    expect(res.status).toBe(201)
    expect(db.rejectPendingWrite).toHaveBeenCalledWith(
      DRAFT_ID, TENANT, 'pending', APPROVER, 'the window closed while I was away',
    )
    expect(db.commitWithReceipt).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run both to make sure they fail**

Run: `npx vitest run --project integration tests/integration/approval-expiry.test.ts`
Expected: FAIL, the first decision call answers `410` where the test wants `201`.

Run: `npx vitest run tests/api/approvals.test.ts`
Expected: FAIL on the new case only, for the same reason.

- [ ] **Step 3: Move the expiry check after the rejection branch**

```ts
// src/api/approvals.ts, replacing lines 242-274 in one rewrite: the expiry
// guard, the rejection branch and the approval try/catch. Leaving any of the
// three out duplicates a return path.
    if (body.data.approved) {
      // Expiry blocks approval and nothing else. An expired authorisation must
      // not become executable, and the 410 stays.
      if (new Date(draft.expiresAt).getTime() <= Date.now()) {
        return c.json({ error: 'expired', expires_at: draft.expiresAt }, 410)
      }
      try {
        const result = await commitWithReceipt(draft, { approvedBy: userId, scope: APPROVAL_SCOPE })
        return c.json({
          status: 'approved',
          pending_write_id: draft.id,
          receipt_id: result.receiptId,
          committed_record_id: result.committedId,
        }, 201)
      } catch (err) {
        if (err instanceof UnsupportedCommitError) {
          return c.json({ error: 'not_committable', detail: err.message }, 422)
        }
        if (err instanceof Error && /already committed|was rejected/.test(err.message)) {
          return c.json({ error: 'already_decided', detail: err.message }, 409)
        }
        throw err
      }
    }

    // Backlog M3. Answering 410 to a rejection meant `rejected_at` could never
    // be set, the partial index `uq_pending_draft_hash` kept holding the key,
    // and a re-stage returned the dead row: a queue entry that refused both yes
    // and no, with the bundle stranded in `staged`. Rejecting an expired draft
    // is the honest answer to an expired proposal, and it is the only thing that
    // frees the hash. The rejected alternative, adding expires_at to the index
    // predicate, would let a re-stage win by discarding the item the owner was
    // already reading.
    const receiptId = await rejectPendingWrite(
      draft.id,
      tenantId,
      draft.runId,
      userId,
      body.data.reason ?? 'Rejected from the approval queue',
    )
    if (!receiptId) return c.json({ error: 'not_found' }, 404)
    return c.json({ status: 'rejected', pending_write_id: draft.id, receipt_id: receiptId }, 201)
```

Keep the `already_decided`, `already_applied` and `not_found` guards exactly where they are, above both branches: a decided row must not be rejectable twice.

- [ ] **Step 4: Run the whole approval surface**

```bash
npx vitest run --project integration tests/integration/approval-expiry.test.ts
npx vitest run tests/api/approvals.test.ts tests/governance/denial-path.test.ts
npm run typecheck
```

Expected: PASS. If `tests/api/approvals.test.ts` asserts a 410 on rejection, that assertion encodes the deadlock and must be updated here, with the commit message naming it as a behaviour change rather than a test edit.

- [ ] **Step 5: Commit**

```bash
git add src/api/approvals.ts tests/integration/approval-expiry.test.ts tests/api/approvals.test.ts
git commit -m "fix(governance): let a rejection land on an expired draft, which frees the hash"
```

---

### Task 16: M4, a suspended run gets an id and a resume control

**Files:**
- Modify: `src/api/approvals.ts:107` (`matchSuspension`) and `:200-205` (the `/suspended-runs` page argument)
- Modify: `console/components/ApprovalQueue.tsx:204`
- Test: `tests/api/approvals.test.ts` (append, and one existing assertion updated), `console/tests/ApprovalQueue.test.tsx` (append)

**Interfaces:**
- Consumes: `Agent.listSuspendedRuns()` returning `runs: AgentRun[]` whose `toolCalls: AgentRunToolCall[]` carry `toolCallId?: string` (`node_modules/@mastra/core/dist/agent/agent.d.ts:73-82`), `POST /api/approvals/:runId/decision` with `DecisionSchema`'s optional `toolCallId` (`src/api/approvals.ts:47-51`), and `QueueItem.suspension.tool_call_ids` (`console/lib/types.ts:20-25`).
- Produces: `suspension.tool_call_ids` containing tool call **ids**, and one Resume control per suspended row that posts `{ approved: true, toolCallId }` to the run-level decision route.

Both causes are read out of the installed package and the repository, not guessed, so this task does not begin with a spelunking exercise:

**Cause 1, the one that removes the affordance.** `src/api/approvals.ts:107` builds the field with `.map((tc) => String(tc.toolName ?? ''))`, so `tool_call_ids` carries tool *names*. `approveToolCallGenerate` needs the `toolCallId`, and the console has `marketing.stage_bundle` where it needs `call_a1b2c3`. The name is the display label, not the credential, and no amount of console work can recover an id that was thrown away at the mapping layer.

**Cause 2, the one that explains the empty list.** `QueueQuerySchema` (`src/api/approvals.ts:53-58`) declares `page: z.coerce.number().int().min(1).default(1)`, so an unpaginated caller gets `page: 1`, and `/suspended-runs` passes it straight through at line 203. The installed typing says the opposite about that parameter: `/** Zero-indexed page number. */ page?: number` (`agent.d.ts:109-110`), with pagination applied when both `page` and `perPage` are present. Asking for page 1 of a one-run set asks for its second page, which is exactly the `{"items":[],"total":1}` the backlog recorded. `/pending` is unaffected: it calls `listSuspendedRuns()` with no options at line 151, so it gets everything, which is why the queue still counted the run while the list route returned nothing.

A console page asking for its second page of drafts while the first page is the only one that exists is the whole bug, and the fix is one subtraction.

- [ ] **Step 1: Confirm both causes against the running plane**

Start the stack the way the slice 1 walkthrough did, stage a bundle from chat, and then read the two answers the fix claims:

```bash
curl -sS "http://localhost:4113/api/approvals/suspended-runs?perPage=20" \
  -H "x-tenant-id: $CRUM_DEV_TENANT" -H "x-user-id: $CRUM_DEV_USER" -H "x-user-role: admin"
curl -sS "http://localhost:4113/api/approvals/suspended-runs?page=0&perPage=20" \
  -H "x-tenant-id: $CRUM_DEV_TENANT" -H "x-user-id: $CRUM_DEV_USER" -H "x-user-role: admin"
curl -sS "http://localhost:4113/api/approvals/pending" \
  -H "x-tenant-id: $CRUM_DEV_TENANT" -H "x-user-id: $CRUM_DEV_USER" -H "x-user-role: admin" | grep -o '"suspension":{[^}]*}'
```

Record all three in the task report, and read them as the pair they are. The first answers `{"items":[],"total":1}`: the route's own default is `page: 1`, which a zero-indexed provider reads as the second page of a one-run set. The second answers `400 invalid query`, because `QueueQuerySchema`'s `.min(1)` rejects the only page number that would have worked. Together they say the first page of suspended runs is unreachable through this route today, which is a stronger claim than "returns empty" and is what Step 3 fixes. The third shows `tool_call_ids` holding a tool name, which proves cause 1. If the first call already returns the run, stop and report: cause 2 is not what the backlog saw, and Step 3's page change must be dropped rather than kept on faith.

- [ ] **Step 2: Write the failing tests, in both harnesses**

`tests/api/approvals.test.ts` is hermetic and already mocks the whole DB layer, so both causes get asserted there without a database. `fakeAgent()` at line 130 is the fixture to widen: its `toolCalls` entry carries only a `toolName`, which is why cause 1 has never failed a test.

```ts
// tests/api/approvals.test.ts: fakeAgent()'s single toolCalls entry becomes, with
// the optional fields the installed AgentRunToolCall type actually declares:
          toolCalls: [{ toolCallId: 'call-1', toolName: 'crm.create_contact', requiresApproval: true }],
```

```ts
// tests/api/approvals.test.ts, appended to the describe('GET /api/approvals/pending') block
  it('carries the tool call id, because a name cannot resume anything', async () => {
    db.listPendingWrites.mockResolvedValue([draft({ runId: RUN_ID })])

    const body = await json<{ items: QueueRow[] }>(
      router(() => fakeAgent()).request('/api/approvals/pending', { headers: AUTH }),
    )

    // Today this is ['crm.create_contact']: the mapping at approvals.ts:107 reads
    // tc.toolName into a field called tool_call_ids. The resume control needs
    // 'call-1', and no console change can recover it from a name.
    expect(body.items[0]!.suspension!.tool_call_ids).toEqual(['call-1'])
  })
```

```ts
// tests/api/approvals.test.ts, appended to the describe('GET /api/approvals/suspended-runs') block
  it('asks the provider for the first page, which is page zero', async () => {
    const agent = fakeAgent()

    const body = await json<{ items: SuspendedRunRow[]; total: number }>(
      router(() => agent).request('/api/approvals/suspended-runs?perPage=20', { headers: AUTH }),
    )

    // QueueQuerySchema defaults page to 1 for callers, and the provider counts
    // from 0, so the boundary is where the translation happens.
    expect(agent.listSuspendedRuns).toHaveBeenCalledWith({ page: 0, perPage: 20 })
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
  })
```

The existing `proxies the filter and the page` case at line 295 asserts `toHaveBeenCalledWith({ threadId: 'thread-1', page: 1, perPage: 50 })` and pins the bug. Change it to `page: 0` in this commit and name it in the message: it is a behaviour change, not a test edit.

- [ ] **Step 3: Fix the mapping and the page boundary**

```ts
// src/api/approvals.ts, inside matchSuspension
  return {
    run_id: run.runId,
    thread_id: run.threadId,
    resource_id: run.resourceId,
    /**
     * The id, not the name. `approveToolCallGenerate` takes a toolCallId
     * (@mastra/core AgentRunToolCall), and a field called tool_call_ids that
     * holds tool names is how a suspended run ends up with no way back: the
     * console can display the name but cannot resume with it. Names stay
     * available to the caller through the draft's own object type, so nothing is
     * lost here.
     */
    tool_call_ids: (run.toolCalls ?? [])
      .map((tc) => String(tc.toolCallId ?? ''))
      .filter(Boolean),
  }
```

```ts
// src/api/approvals.ts, in the /suspended-runs handler
    const result = await agentGate.agent.listSuspendedRuns({
      ...(threadId ? { threadId } : {}),
      ...(resourceId ? { resourceId } : {}),
      /**
       * CRUM's public page parameter is 1-based, because that is what a human
       * reads off a screen and what QueueQuerySchema enforces with `.min(1)`. The
       * provider's is zero-based (`agent.d.ts:109`), and it paginates as soon as
       * both numbers arrive. Sending 1 therefore asked for the second page of a
       * one-run set and answered `items: [], total: 1` — the run was counted but
       * never listed. The translation belongs at this boundary, and nowhere else:
       * `/pending` calls `listSuspendedRuns()` with no options at all and so was
       * never affected, which is why one route looked broken and the other did not.
       */
      page: page - 1,
      perPage,
    })
```

`tool_calls: run.toolCalls ?? []` in the `/suspended-runs` mapping already passes whole objects through, so the console can read `toolCallId` from either route. Do not flatten it.

- [ ] **Step 4: Write the failing console test and the control**

```tsx
// console/tests/ApprovalQueue.test.tsx, appended. It reuses the file's mount(),
// queue() and item() helpers, and item()'s own suspension literal already carries
// tool_call_ids: ['call-1'], so the fixture needs no change.
  it('resumes a suspended run through the run-level decision route', async () => {
    const user = userEvent.setup()
    mount([
      route(
        '/api/approvals/pending',
        queue([item({ run_id: RUN_ID, suspension: { run_id: RUN_ID, thread_id: 'thread-1', resource_id: 'tenant-1:user-1', tool_call_ids: ['call-1'] } })]),
      ),
      route('/decision', { status: 200, body: { run_id: RUN_ID, tool_call_id: 'call-1', approved: true, finish_reason: 'stop', still_suspended: false, text: 'Bundle staged.' } }),
    ])
    render(<ApprovalQueue />)

    await user.click(await screen.findByRole('button', { name: /resume crm.create_contact/i }))

    const call = server.last('/decision')
    // The run id in the path, not the draft id: this decides the agent's
    // suspension, and the draft still needs its own Approve click.
    expect(call?.url).toBe(`/api/approvals/${RUN_ID}/decision`)
    expect(call?.body).toEqual({ approved: true, toolCallId: 'call-1' })
  })
```

The button label needs the tool name, which lives on the run row the `/pending` route already returns inside `suspension`. Widen that field to carry both, rather than looking the name up again:

```ts
// console/lib/types.ts, inside QueueItem['suspension']
  suspension: {
    run_id: string
    thread_id?: string
    resource_id?: string
    tool_call_ids: string[]
    /** Display labels only; never send these as a toolCallId. */
    tool_names: string[]
  } | null
```

and in `src/api/approvals.ts`'s `SuspensionMatch` interface (`:87-92`) add the matching `tool_names: string[]`, built by the same map over `run.toolCalls` with `tc.toolName`. Both console test cases that already build a `suspension` literal (`ApprovalQueue.test.tsx:92` is the one) gain `tool_names: ['crm.create_contact']`; `item()`'s own default is `suspension: null`, so it needs nothing. The `tests/api/approvals.test.ts` `Suspension` interface at `:70-74` gains the same `tool_names: string[]`, which is where the typecheck complains first.

```tsx
// console/components/ApprovalQueue.tsx, beside the existing suspension span at
// :204. The component keeps row state in two records keyed by the draft id,
// `pending` (boolean) and `feedback` ({ kind, text } | undefined), and reloads
// through `load()`; this follows the same shape as `decide()` rather than
// inventing a third state lane.
  async function resumeRun(item: QueueItem, runId: string, toolCallId: string) {
    setPending((p) => ({ ...p, [item.id]: true }))
    setFeedback((f) => ({ ...f, [item.id]: undefined }))
    try {
      const result = await post<{ text?: string; still_suspended?: boolean }>(
        `/api/approvals/${encodeURIComponent(runId)}/decision`,
        { approved: true, toolCallId },
      )
      setFeedback((f) => ({
        ...f,
        [item.id]: {
          kind: 'ok',
          text: result.still_suspended
            ? 'Resumed; the run suspended again on the next tool, so there is another one waiting.'
            : `Resumed. ${result.text ?? 'The run continued.'}`,
        },
      }))
      await load()
    } catch (err) {
      setFeedback((f) => ({ ...f, [item.id]: { kind: 'bad', text: describeError(err) } }))
    } finally {
      setPending((p) => ({ ...p, [item.id]: false }))
    }
  }

  {item.suspension ? (
    item.suspension.tool_call_ids.length > 0 ? (
      <Button
        variant="ghost"
        size="sm"
        disabled={pending[item.id] === true}
        onClick={() => void resumeRun(item, item.suspension!.run_id, item.suspension!.tool_call_ids[0]!)}
      >
        Resume {item.suspension.tool_names[0] ?? 'run'}
      </Button>
    ) : (
      <p className="mt-1 text-xs text-warning">
        This run reports no resumable tool call, so the queue cannot resume it.
      </p>
    )
  ) : null}
```

The empty-`tool_call_ids` branch is the honest answer rather than a button that posts `toolCallId: ''`: `DecisionSchema` declares `toolCallId: z.string().min(1).optional()`, so an empty string is a 400 the owner would have to decode, and omitting it would resume a run whose tool call was never identified. Note the draft is still undecided after a resume, which is correct and is what the `Resume` label says: the run continues, the pending write stays in the queue for its own Approve click.

- [ ] **Step 5: Run both suites and walk it once by hand**

```bash
npx vitest run tests/api/approvals.test.ts
cd console && npx vitest run tests/ApprovalQueue.test.tsx
```

Then the proof the backlog names: stage a bundle from chat, click once in the console, and see the draft in the queue without touching `curl`. Record in the task report whether the click created the queue item, because that sentence is the acceptance test and it is not expressible as a unit assertion.

- [ ] **Step 6: Commit**

```bash
git add src/api/approvals.ts console/components/ApprovalQueue.tsx console/lib/types.ts console/tests/ApprovalQueue.test.tsx tests/api/approvals.test.ts
git commit -m "fix(governance): list suspended runs you can act on, and give the console a resume control"
```

---

### Task 17: The walkthrough, the baseline, and the two hand-offs

**Files:**
- Create: `docs/superpowers/plans/2026-10-31-marketing-team-slice-2-verification.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the record that makes slice 2 shippable, plus two explicit hand-offs the plan deliberately does not perform.

- [ ] **Step 1: Run the free gates, one at a time**

```bash
npm run typecheck
npm run lint
npx vitest run tests/marketing/site.test.ts tests/marketing/lead-token.test.ts tests/marketing/page-host.test.ts tests/marketing/outbox.test.ts
npx vitest run tests/mastra/marketing-write-tools.test.ts tests/mastra/marketing-publish-tools.test.ts tests/mastra/boot.test.ts
npx vitest run tests/governance/marketing-payload.test.ts tests/governance/policy.test.ts tests/governance/conformance.test.ts
npx vitest run tests/api/marketing.test.ts tests/api/marketing-staging.test.ts tests/api/marketing-leads.test.ts tests/api/approvals.test.ts
npx vitest run tests/db/marketing.test.ts tests/db/marketing-commit.test.ts
```

Expected: every command exits 0. Strip ANSI before grepping any log: `sed -e 's/\x1b\[[0-9;]*m//g'`.

- [ ] **Step 2: Run the integration lane against the throwaway cluster**

```bash
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice2"
npx vitest run --project integration \
  tests/integration/marketing-publish-migration.test.ts \
  tests/integration/marketing-publish.test.ts \
  tests/integration/marketing-leads.test.ts \
  tests/integration/approval-expiry.test.ts \
  tests/integration/marketing-bundle.test.ts
```

Expected: PASS, and `marketing-bundle.test.ts` still passing is the regression proof that slice 1's stage-to-receipt path survived a widened `deriveActions` signature.

- [ ] **Step 3: Walk it for real, and let the walkthrough be the judge**

Start the stack, save an `inbound_leads` bundle with one `page_html` artifact holding `{{CRUM_LEAD_ENDPOINT}}`, stage it, approve it in the console, run `npx tsx scripts/publish-drain.ts`, open the preview URL in a browser, fill in the form as a stranger with no CRUM identity, and confirm the prospect, the consent row and the lead row exist. Then Prepare go-live, approve the promotion, drain again, and open the custom domain. Paste the two URLs into the report, and paste the `marketing_actions` rows.

If any step needs `curl` where a human would need a click, name it as a defect rather than working around it.

- [ ] **Step 4: Run the paid suite once, and compare instead of hoping**

`npm run verify` runs the unfiltered `vitest run`, which spends live-model credit and is red in this repository for the reasons in backlog M1. Run it once, strip ANSI, and compare the failure set to the slice 1 baseline recorded in `.superpowers/sdd/2026-10-30-marketing-team-slice-1/task-11-report-step5.md`. The claim this plan is allowed to make is narrow: no new item-level marketing failure, and every new failure attributable to a task in this plan. Write both numbers in the report.

- [ ] **Step 5: Hand off the two things this plan refuses to do**

Record in the report:

1. The five lines that belong in `.env.example`, withheld because the file carries another effort's uncommitted edit and staging it would sweep their lines into a marketing commit:

```bash
CRUM_CLOUDFLARE_ACCOUNT_ID=
CRUM_CLOUDFLARE_PAGES_PROJECT=
CRUM_CLOUDFLARE_API_TOKEN=
CRUM_PAGES_PRODUCTION_BRANCH=main
CRUM_MARKETING_SITE_ORIGIN=https://your-domain.test
CRUM_LEAD_API_ORIGIN=
CRUM_MARKETING_LEAD_DAILY_CAP=200
CRUM_PAGES_API_BASE_URL=https://api.cloudflare.com/client/v4
```

2. The token scope that worked, copied verbatim from the spike file, because an operator who regenerates a token needs the exact scope and nothing found in Cloudflare's docs says it.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-10-31-marketing-team-slice-2-verification.md
git commit -m "test(marketing): record the slice 2 walkthrough, the baseline comparison and two hand-offs"
```

Then use superpowers:finishing-a-development-branch: the merge decision is the owner's, and slice 2 changes governance semantics for ten other approval tools, which is not a detail to bury in a summary.

---

## Self-review record

Checked against the spec with fresh eyes, and against the repository for every
signature this plan asks someone to call. The defects below were found and fixed
in place; they are listed because an executor will otherwise re-introduce them.

1. **Coverage.** Spec section 2 is Tasks 1 and 7. Section 3.1 is Tasks 2 and 3. Section 3.2 is Task 2's `result` column and Task 9's `recordSuccess`. Section 3.3 is Task 5. Section 3.4 is Task 2. Section 4 is Task 4. Section 5's three approvals are Tasks 4, 10 and 11, declared in Task 6. Section 6 is Tasks 7, 8 and 9. Section 7 is Tasks 5 and 14. Section 8.1 is Tasks 12 and 13, 8.2 is Task 15, 8.3 is Task 16. Section 9 is Task 8 plus Task 17's hand-off. Section 10's table has a test in Tasks 4, 9, 10, 11, 14, 15 and 16. Section 11's layers are Tasks 3, 5, 6, 9, 14, 15, 16 and 17. Section 12's file list matches the File structure table row for row.
2. **Fixed: three ellipses that were asking the executor to invent test bodies.** Task 9 Step 5's failure path, Task 13 Step 1's second and third cases, and Task 15 Step 1's `describe.skipIf` harness are now written out in full. A comment that says "same shape, two fields changed" is a plan failure wearing a note.
3. **Fixed: `console/tests/fetchStub.ts` was used with the wrong signature.** `route(urlContains, reply, method?)` takes a `Reply` object, `{ status, body }`, not a positional status and body; `last()` returns `undefined`, not `null`; and the marketing and approvals component tests both mount through their own file-level `mount()` and builder helpers. Tasks 13 and 16 now match the helper as it is written, including the method filter that a page which GETs and POSTs the same path prefix needs.
4. **Fixed: Task 16 was written against a console that does not exist.** There is no suspended-runs list in `ApprovalQueue.tsx`, no `SuspendedRun` type, and no second fetch lane; what exists is `QueueItem.suspension`, already typed with `tool_call_ids` and already printed at `ApprovalQueue.tsx:204` as dead text. The task now fixes the mapping that puts tool *names* in a field the resume call needs *ids* in (`src/api/approvals.ts:107`), translates the 1-based page parameter to the provider's zero-based one, and puts one Button on the existing row using the component's own `pending` and `feedback` state records. The spec's section 8.3 carries the same two causes.
5. **Fixed: `stagePromotion` was defined without `userRole` and called with it.** Task 10's signature, its Interfaces block, its two test calls and the `'admin'` literal inside `gateFor` now thread the real role, which is what Task 11's `stageRetry` and Task 12's route already assumed. The stale note that told the reviewer to fix it later is gone.
6. **Fixed: `currentSiteHash` appeared twice in Task 10, once calling a function that does not exist.** The broken copy is deleted rather than corrected in place, because a plan that shows wrong code first gets the wrong code written.
7. **Types.** `SiteFile`, `SiteArtifact`, `slotProblem`, `resolveSite` and `siteHashOf` are defined in Task 3 and used with those exact names in Tasks 4, 7, 9, 10, 12 and 13. `pageSlugOf` and `slotProblemCheck` come from Task 4. `markBundleLive` is produced by Task 9 and consumed only there. `listPublishSucceeded` and `currentSiteHash` are produced by Task 10, `getFailedAction` by Task 11, `listMarketingActions` by Task 12. `actionAdapter` and `registerActionAdapter` are Task 9's and Task 4's. `MarketingActionRecord.actions` is produced by Task 12's GET and consumed by Task 13's fixture.
8. **Fixed: `StagePayload.siteHash` was declared in Task 6 and consumed in Task 4.** The field now belongs to Task 4, because Task 4 is the task that first builds a stage payload carrying it; a required field declared two tasks late leaves `npm run typecheck` red across the gap. That move pulls in the callers the field makes compile-breaks of: the two placeholder hooks in `marketing-writes.ts` (both `siteHash: null`), the six literals and one key-set assertion in `tests/governance/marketing-payload.test.ts`, and the two further key-set assertions at `tests/mastra/marketing-write-tools.test.ts:395` and `tests/integration/marketing-bundle.test.ts:134`. Task 6 appends the two new builders and says so out loud rather than redeclaring the interface.
9. **Fixed: Task 4's stage-tool snippets had `blocked` used above where it was defined.** The refusal ternary's third arm reads `blocked`, and the first draft placed `deriveActions` and `blockedActions` in the block *below* it. Task 4 now gives one ordered block for `:326-334`, names the three consequences of deleting `const artifactCount` (the import at `:12`, the message at `:419`, and the count-and-hash agreement that is the point of the change), and keeps `countMarketingArtifacts` exported rather than deleting a db-module API the slice never asked to remove.
10. **Known sharp edges.** `src/db/marketing.ts` importing `pageSlugOf` from `src/marketing/outbox.ts`, which imports `MarketingBundleRow` from `src/db/marketing.ts`, is a cycle. It is legal because both sides are type-only or lazily called, and it must be checked by `npm run typecheck` in Task 10 Step 5; if the bundler objects, move `pageSlugOf` into `src/marketing/site.ts` and update Tasks 4, 9 and 10 together rather than leaving half a cycle behind. Task 1's spike is the other: it can invalidate Task 7's adapter shape, and the plan says to stop rather than code through a failed spike.
