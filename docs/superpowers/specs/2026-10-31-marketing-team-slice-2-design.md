# CRUM marketing team, slice 2 design: a page that exists and leads that arrive

Date: 2026-10-31
Status: owner-approved direction, written without per-section confirmation on the owner's instruction
Parent spec: `docs/superpowers/specs/2026-10-30-marketing-team-design.md` (slice 1 shipped at `d7a7d62`)
Scope: the Cloudflare Pages publisher, the two-approval go-live path, a failed-publish retry approval, the inbound lead endpoint, and the two governance gaps the owner folded in (backlog M3 and M4)

## 1. What this slice makes real

Slice 1 produced a bundle you can write, read, approve and audit, and refused to publish it. Slice 2 removes the refusal. After it, a funnel bundle can reach your custom domain behind two separate clicks, and the form on that page can put a real person into the prospect pipeline with a consent basis recorded.

Success criterion, taken from the parent spec section 10: a page that exists and leads that arrive.

Five owner decisions govern this slice and are not reopened here:

| Decision | Choice |
|---|---|
| Page host | Cloudflare Pages, over its API |
| Go-live shape | Two approvals. First publishes a preview URL, second promotes to the domain |
| Form depth | Full qualification funnel, budget bucket and goal included |
| Domain | Already connected to the Pages project |
| Governance gaps | Backlog M3 (expired-draft deadlock) and M4 (no resume affordance) belong in slice 2 |

The standing rule from the parent spec section 2 is unchanged and this slice is where it is most likely to be broken by accident: a subagent may spend tokens and cents, and may never change anything outside CRUM. The designer and funnel builder still hold no tools. Publishing happens in a publisher process that no agent can call.

## 2. Provider facts, and the one that is missing

Verified in Cloudflare's own documentation:

1. A deployment is created with `POST /accounts/{account_id}/pages/projects/{project_name}/deployments`, `multipart/form-data`, carrying `branch`, `commit_message`, and `manifest`, a JSON object mapping each file path to its content hash, maximum 20,000 entries. The file bytes ride in the same request as parts named by their hash. The response carries `id`, `url`, `short_id`, `created_on`.
2. The production deployment is served at `{project}.pages.dev` and therefore at the connected custom domain. A deployment on any other branch gets its own `pages.dev` address. The preview and live distinction is a real branch property, not something CRUM invents.
3. A project created for Direct Upload needs no git connection and no build step, which matches the project your domain is already pointed at.

Not verified, and not findable in the documentation:

4. **There is no documented call that makes an existing preview deployment production.** The docs describe branch-based URLs and re-deployment. Community threads separately report direct uploads that succeed over the API and then serve 404 or 500, so an undocumented call is not a foundation to build on.

Consequence, and it is a design consequence rather than a workaround: promotion re-sends the identical manifest, same paths and same hashes, with `branch` set to the project's production branch. One documented endpoint, used twice. This means the live deployment carries a **new deployment id** and the preview URL keeps serving the older deployment. The bundle screen shows both ids and states which one is live. A plan task spends the first hour proving this against your real project before the adapter is written, because if a re-upload to the production branch does not take, this section is wrong and the design changes.

## 3. Three schema gaps slice 1 left open

### 3.1 Nothing says which artifact is which file

`deriveActions` gives `publish_page` the payload `{ slug }`. A slug is not bytes. `marketing_artifacts` has no path, no slot and no file name, so the database cannot currently say which `page_html` row is the landing page and which is the thank-you page, and Cloudflare needs a path for each file.

Second half of the same gap: `draft_hash` covers the nine role columns and deliberately excludes artifacts, and artifact inserts are additive with `ON CONFLICT (id) DO NOTHING` and never delete. Re-saving a bundle where only the HTML changed, with identical role columns, keeps the same bundle id and leaves two `page_html` rows under it. That state is reachable today. A publisher that silently picked one of the two would be the exact failure the approval gate exists to make impossible.

Resolution: **CRUM owns the file names, and an ambiguous slot is a refusal.** Each uploaded file gets its own `kind`, and the path is a constant in CRUM derived from the bundle's slug.

| Slot kind | Manifest path | Producer |
|---|---|---|
| `page_html` | `{slug}/index.html` | funnel builder, landing page |
| `thank_you_html` | `{slug}/thanks/index.html` | funnel builder, post-submit page |

A `path` column filled in by the model was rejected for two reasons: a path is a placement instruction from the agent that wrote the copy, so it needs sanitising, and folding it into `artifactIdFor` would re-key every artifact row slice 1 already wrote. With kind-as-slot the model never names a file, `artifactIdFor` is untouched, and the relative-path rules to enforce are: exactly one artifact per slot kind, `page_html` required when a slug is present, and zero artifacts of a slot kind means that file is simply not in the site.

Two artifacts of one slot kind is a refusal that names both ids and tells the human to re-save the bundle. This reuses the precedent set by `unreadPlanColumns`, which refuses before the adapter question for the same reason.

### 3.2 `marketing_actions` cannot hold a recorded response

`external_id` is one text column, and publishing returns two things worth keeping: the deployment id and the URL. Slice 3's analyst will need the recorded response too. The parent spec section 8 said each adapter is "a thin adapter with a recorded response", and there is nowhere to record it.

### 3.3 A published page needs a credential that must exist before its bytes are hashed

The lead form has to post somewhere and prove which bundle it belongs to. Because the approval signs the `siteHash` of the stored bytes, any token injected after approval would mean publishing bytes nobody reviewed. So the token is minted at save time, stamped into the HTML, and stored inside the hashed bytes. Nothing later can move it.

### 3.4 Migration 0019

One migration, `migrations/0019_crum_marketing_publishing.sql`, following the file conventions of 0018 (idempotent, no BEGIN, the runner wraps it with its version row):

| Change | Why here |
|---|---|
| `marketing_artifacts.kind` CHECK gains `thank_you_html` | slot-as-kind, section 3.1 |
| `marketing_actions.action` CHECK gains `promote_page` | the second approval's outbox row |
| `marketing_actions` gains `result jsonb` | section 3.2 |
| `marketing_bundles` gains `lead_token text` | section 3.3, generated from `gen_random_uuid()` |
| `pending_writes.object_type` CHECK gains `marketing_promote` and `marketing_retry` | a distinct object type per distinct decision, as `outreach_draft` and `outreach_send` already split |
| new table `marketing_leads` | section 7 |

`MARKETING_ACTION_NAMES` widens with `promote_page`. Slice 1 computes `UNMAPPED_ACTION_NAMES` from the difference between the declared names and the derived names, and that arithmetic now needs a third category, because `promote_page` is registered as executable yet never derived: a plan asks for a page, only a human asks for it to go live. So `src/marketing/outbox.ts` gains `HUMAN_INITIATED_ACTION_NAMES = ['promote_page']`, and the existing conformance test asserts that `MARKETING_ACTION_NAMES` is the disjoint union of `DERIVED_ACTION_NAMES`, `HUMAN_INITIATED_ACTION_NAMES` and `UNMAPPED_ACTION_NAMES`. `unpublish_page` and `set_campaign_status` remain unmapped, and staging still refuses anything that asks for them.

## 4. Publishing one page

`publish_page` payload becomes `{ slug, siteHash }`. `siteHash` is sha256 over the sorted list of `{ path, sha256(bytes) }` pairs, so it covers the exact bytes that will be uploaded. Identifiers, a hash and numbers, which keeps the parent spec section 7 rule intact and lets the payload-hygiene sweep keep passing with no exception added.

The derivation now needs the artifact set, so `deriveActions` takes it and the two callers supply it:

1. `marketing.stage_bundle` loads the artifacts it already loads for counting, computes `siteHash`, and refuses to stage when a slot is ambiguous or when a slug is present with no `page_html`.
2. `commitBundleApproval` reads the artifacts **inside the same transaction, under the `FOR UPDATE` lock it already holds**, re-derives the actions and recomputes `siteHash`. If the recomputed hash differs from the one the reviewer was shown, the approval throws. The bytes moved after you looked at them, and CRUM will not sign a receipt over a page nobody saw.

`deriveActions` gains a transaction-scoped artifact query rather than a second read of the pool, so the lock and the read are the same connection. Slice 1's unit fixtures that call `deriveActions` with a bundle-only argument are updated to pass an explicit artifact list; that is the intended test churn, not a regression.

## 5. Three approvals, and what each one authorises

| Tool | Class | Staged payload | Effect on approval |
|---|---|---|---|
| `marketing.stage_bundle` | approval | existing fields, now plus `siteHash` | bundle becomes `approved`, `publish_page` queued |
| `marketing.promote_bundle` | approval | `bundleId`, `pageActionId`, `siteHash` | `promote_page` queued, bundle stays `approved` until it succeeds |
| `marketing.retry_publish` | approval | `actionId`, `siteHash` | one new `queued` row cloning the failed action's payload; the bundle is untouched, because a failed action never changed the bundle status |

The two new tools are declared in `policy/tools.yaml` with `idempotent: true` and an `idempotency_key` of `siteHash` and `actionId` respectively, as `src/governance/schema.ts` demands for any non read-only class. `marketing.stage_bundle` keeps its existing `draftHash` key. No `marketing` domain block goes into `policy/risk.yaml`, for the reason already recorded in the parent spec section 7.

`promote_bundle` may only stage when the bundle has a `succeeded` `publish_page` action whose recorded `result.url` exists, and it re-checks that the stored page bytes still hash to the `siteHash` it stages. Its payload deliberately excludes the preview URL: a URL contains the slug, a slug is a phrase an agent wrote, and `delete` or `send` inside a slug would score the promotion to 90 and refuse good work. The reviewer reads the URL from the bundle screen, which renders from the database.

`retry_publish` exists because `attempts <= 3` is enforced by the database and a terminal `failed` needs a new queued row, never a silent retry. Your first publish will probably fail on an under-scoped token, and the retry must be a receipt rather than a `psql` incantation. It clones the failed action's payload unchanged, refuses if the current bytes no longer hash to the stored `siteHash`, and is the only retry path.

## 6. The adapter and the publisher

`src/marketing/page-host.ts` exports two `MarketingActionAdapter` objects, registered through the existing `registerActionAdapter` seam, which already returns an unregister function so a test restores the registry exactly.

Registration is **conditional on configuration**. `src/mastra/agent.ts` boot registers the page adapters only when the account id, project name, API token and site origin are all present. Otherwise `publish_page` stays unmapped and staging refuses with the guard slice 1 already wrote. That is the parent spec section 6 rule operating as designed: an action is not approvable before it is executable, and a missing credential makes it not executable. The app still boots, because a missing Pages token is not a reason CRUM cannot read your prospects.

The adapter builds the manifest from the artifact rows, hashes each file with sha256, and posts the multipart body. It records into `marketing_actions.result` the shape `{ deploymentId, url, uploadedAt, branch, fileCount }` and sets `external_id` to the deployment id, which is the value an operator would search for.

`scripts/publish-drain.ts` follows the shape of `scripts/mail-watch.ts`. Per queued row: claim it with `UPDATE marketing_actions SET status = 'running', attempts = attempts + 1 WHERE id = $1 AND status = 'queued' RETURNING *`, call the adapter, then write `succeeded` plus `result`, or `failed` plus `last_error`. The claim is atomic per row, so running two drainers at once is safe in the sense that one row is never executed twice, and the file comment says exactly that and no more. No external call ever runs inside a SQL transaction, which is the whole reason the outbox exists.

A page publish that succeeds and then loses the process leaves the row `running`. The drainer treats a `running` row older than its own timeout as a failed candidate and marks it `failed` with the reason recorded, rather than retrying inside the same row, because a duplicate deployment is a visible mess and a silently retried one is worse.

## 7. Inbound lead intake

### 7.1 The route

`POST /api/marketing/leads` accepts `application/x-www-form-urlencoded` as the primary shape and `application/json` second.

Urlencoded is primary because the page lives on your domain and CRUM lives elsewhere. A JSON `fetch` across origins needs a CORS preflight, which means CRUM answering `OPTIONS` and the page carrying JavaScript that an agent wrote and you did not read closely. A plain HTML form post with urlencoded body is a simple request: no preflight, no CORS, and it works with scripting disabled. The no-JS path navigates the browser to CRUM, so the route answers `303` to a thank-you page. A JSON caller gets `200` with a body that says nothing useful to a probe.

The thank-you target is computed per request, not stamped into the HTML. `marketing.save_bundle` runs before the page has any URL at all, so it cannot know whether the browser came from the preview address or from the domain. The route therefore looks up the bundle's own serving origin: if a `succeeded` `promote_page` action exists, redirect to `{CRUM_MARKETING_SITE_ORIGIN}/{slug}/thanks/`, otherwise to the `result.url` recorded by the `succeeded` `publish_page` action plus `/{slug}/thanks/`. This is also why intake is refused when no publish action has succeeded: until CRUM can name a page to send the visitor to, it does not accept the lead.

This route is the one place CRUM accepts an unauthenticated write, so it does not use `auth(c)` or `resolveIdentity`. It resolves the tenant from the bundle the token points at. Unknown token answers `404`, which is also what a revoked token answers, so nothing distinguishes them for a prober.

### 7.2 The token, and the placeholder the funnel builder must write

`save_bundle` mints `lead_token` for a bundle whose objective is `inbound_leads` and stamps it into the page HTML. The funnel builder writes `<form action="{{CRUM_LEAD_ENDPOINT}}">`, and `save_bundle` replaces the placeholder with `{site origin}/api/marketing/leads` plus the token, then stores the stamped bytes. A save whose `page_html` has no placeholder while the objective promises leads is **refused at save**, not discovered after publish. One placeholder occurrence is required; two is a refusal, because a page with two forms pointing at one token is a page nobody can reason about.

### 7.3 The fields, and where each lands

The budget wording and the goal wording below are proposed defaults, editable by the owner, not fixed data.

| Field | Shape | Lands in |
|---|---|---|
| Name | text, required | `prospects.name`, plus `name_normalized` |
| Email | text, validated, required | `prospect_channels` with platform `email`, and `profile_url` set to the page URL that produced the lead |
| Country | select, Australia or Vietnam only | `prospects.country` |
| Budget bucket | select: under $500, $500 to $2k, $2k plus, not sure yet | `marketing_leads.budget_bucket` |
| Goal | short text, "What do you want this to do for you?" | `marketing_leads.goal` |
| Honeypot | hidden input, must stay empty | discarded, its presence alone is a refusal |

`prospects.country` admits only `AU` and `VN`, so a free-text country would produce a 500 when a New Zealander arrived. The honest handling is a two-option select, and an out-of-set country is answered exactly like a good lead so nothing about the schema leaks. `prospects.category` gets a coarse value derived from the goal so the existing pipeline views still sort.

### 7.4 `marketing_leads`, which section 8 of the parent spec promised would not be needed

The parent spec said inbound leads need no new core table. There is nowhere on `prospects` to put a budget bucket, and the core spine is not the place to add one. So this slice adds one table in the marketing plane: `id`, `tenant_id`, `bundle_id`, `prospect_id` (nullable until resolved), `email`, `email_normalized`, `country`, `budget_bucket`, `goal`, `source_url`, `created_at`, and unique on `(tenant_id, bundle_id, email_normalized)`, so a double-clicked submit is one lead.

It also gives slice 3 the number the weekly report is actually about, leads per bundle per day, which a bare `prospects` row cannot attribute to a page.

Duplicate handling otherwise runs through the existing key. `prospect_channels` is unique on `(tenant_id, platform, handle_normalized)`. An email that already belongs to a prospect creates no new prospect; the lead row points at the prospect that was found, and the response is identical either way.

### 7.5 Limits, because this is a public door

Intake is refused unless the bundle has a `succeeded` `publish_page` action. A per-bundle daily cap, `CRUM_MARKETING_LEAD_DAILY_CAP` defaulting to 200, stops a runaway page from filling the pipeline. The route inserts rows and nothing else: it sends no reply, creates no outreach draft, and touches no outbound lane. Lead free text is untrusted input that later agents may read, so it is stored raw and kept out of any memory-injection path, which is where the pre-mortem's T2 said to keep it.

## 8. Console, and the two governance gaps folded in

### 8.1 The bundle screen grows the go-live controls

`console/components/MarketingBundleView.tsx` gains: the `siteHash` and the per-file table of path plus sha256, the preview URL after approval one, a **Prepare go-live** control, and when a publish has failed the error and a **Retry publish** control.

Those controls do not approve anything. They post to two new owner-authenticated routes, `POST /api/marketing/bundles/:id/promote` and `POST /api/marketing/bundles/:id/actions/:actionId/retry`, which call the same `stagePromotion` and `stageRetry` functions the tools call. One implementation, two front doors, and the decision still happens only in the approval queue at `POST /api/approvals/drafts/:id/decision`. "Exactly one way to say yes" survives; what changes is that asking becomes reachable from the console instead of requiring a chat sentence.

### 8.2 M3, the expired-draft deadlock, fixed for all eleven approval tools

Chosen shape: **let a rejection land on an expired draft.** In `src/api/approvals.ts` the `410 expired` answer at lines 242-244 moves after the `approved: false` branch, so rejecting an expired draft sets `rejected_at`, which drops the dead row out of the partial unique index `uq_pending_draft_hash` and frees the `draft_hash` key. A re-stage then creates a live draft, and `markBundleStaged` already permits re-staging from `staged`. The deadlock ends with the audit trail intact, and approving an expired draft still answers 410.

The rejected alternative was to add `expires_at > now()` to the partial index predicate. It would let a re-stage win, and it would silently discard the item the owner was already looking at, which is the opposite of what a governance plane is for.

This is shared behaviour and it changes semantics for the six CRM approval tools as well as marketing's. That is the point of folding it in rather than leaving it: with slice 2, staging is now the flow a human actually walks, and a dead queue entry stops being a curiosity.

### 8.3 M4, a suspended run gets a resume control

Two separate defects, both read out of the installed `@mastra/core` typing and the repository rather than guessed, and both must be fixed or the control still cannot work.

`GET /api/approvals/suspended-runs` answers `{"items":[],"total":1}`, which is a count with no rows and therefore unusable. The cause is a page-number boundary: CRUM's `QueueQuerySchema` declares `page` with `.min(1).default(1)`, because a human reads page one off a screen, while the provider documents `/** Zero-indexed page number. */` and paginates as soon as both `page` and `perPage` arrive. Passing the caller's `1` straight through asks for the second page of a one-run set. Asking for the page that would have worked, `page=0`, is refused by CRUM's own validation, so the first page is unreachable through this route. The boundary translates: send `page - 1`. `/pending` was never affected because it calls `listSuspendedRuns()` with no arguments and so receives everything, which is why the queue counted the run while the list route answered nothing.

The second defect is why no console change alone could have added the control. `src/api/approvals.ts` builds `suspension.tool_call_ids` by mapping `tc.toolName`, so the field named for ids carries names, and `approveToolCallGenerate` needs the `toolCallId` that was thrown away at the mapping layer. The mapping returns ids, and the display labels travel in a separate `tool_names` field so the button can still say what it is resuming.

`console/components/ApprovalQueue.tsx` already prints `Suspended run {run_id}` on the draft row and offers nothing to do about it. It gains one resume control per suspended row, wired to the `POST /api/approvals/:runId/decision` endpoint the plane already has, because that is the call that completed the slice 1 walkthrough by hand. Resuming the run does not decide the draft; the pending write stays in the queue for its own Approve click, which is the two-halves rule of spec section 11.3 in the parent spec holding true. Proof it is done: stage a bundle from chat, click once in the console, and see the run continue without touching curl.

## 9. Configuration

| Key | Kind | Absent means |
|---|---|---|
| `CRUM_CLOUDFLARE_ACCOUNT_ID` | identifier | page adapters do not register, staging refuses |
| `CRUM_CLOUDFLARE_PAGES_PROJECT` | identifier | as above |
| `CRUM_CLOUDFLARE_API_TOKEN` | secret, added to `PRODUCTION_REQUIRED_SECRETS` | as above, and the production boot fails loudly |
| `CRUM_MARKETING_SITE_ORIGIN` | identifier, the connected custom domain | lead token cannot be stamped, `save_bundle` refuses an `inbound_leads` bundle |
| `CRUM_MARKETING_LEAD_DAILY_CAP` | number, default 200 | default applies |

`CRUM_CLOUDFLARE_API_TOKEN` joins `PRODUCTION_REQUIRED_SECRETS` (`src/config/env.ts:164-171`), which is checked only when `NODE_ENV` is `production`, exactly as the parent spec section 8 intended. So a development boot with no Pages token is legal and results in unregistered adapters plus a staging refusal, while a production boot fails loudly rather than marketing a page it cannot publish.

The token scope question is answered by refusing to guess: the plan's spike task creates a token scoped to `Account / Pages / Edit` for the specific project, and the resulting 401 or 403 body is recorded in the runbook, because the community reports say a silent-looking failure is the common shape here.

`.env.example` is deliberately **not** touched by this slice. The working tree carries another effort's uncommitted four-line comment edit in that same file, and staging the file would sweep their lines into a marketing commit. The exact lines to add are recorded in section 9 of the implementation plan, to be appended in one pass by whoever commits that effort.

## 10. Refusal and error behaviour

| Situation | Behaviour |
|---|---|
| Slug present, no `page_html` artifact | no `publish_page` derived, staging says what it will and will not do |
| Two artifacts of one slot kind | staging refuses, names both ids |
| Role columns identical, saved bytes differ, and the queue holds the old hash | approval recomputes and refuses |
| Pages credentials absent | adapters unregistered, staging refuses with the slice 1 guard |
| Cloudflare answers 401 or 403 | action `failed`, `last_error` records the status and body, bundle unchanged |
| Cloudflare answers 200 but serves nothing | action `succeeded` with the recorded url, and the runbook tells the owner to check it. The outbox records what the provider said, not what a browser thinks |
| Promotion attempted with no succeeded publish | `promote_bundle` refuses before staging anything |
| Retry attempted while current bytes differ from the stored hash | refuses, so a retry cannot publish unseen bytes |
| Lead token unknown or expired bundle | `404`, identical either way |
| Lead cap reached | `200` with the same thank-you shape, and the lead is dropped. A page visitor is never shown your rate limit |
| Expired draft | rejecting works, approving answers 410, re-stage then succeeds |

## 11. Testing, and how publishing is proved without spending anything

Real Cloudflare calls appear in exactly one place: the spike task, which is manual, throws nothing at a budget, and is recorded in the plan before the adapter is written. Everything else runs against a local stand-in.

| Layer | What it proves |
|---|---|
| Unit: manifest builder | slot resolution, path constants, sha256 pairs, ambiguity refusal, `siteHash` stability under artifact reordering |
| Unit: token stamping | one placeholder required, two refused, missing placeholder refused for `inbound_leads`, no placeholder required for other objectives |
| Unit: payload hygiene | `promote_bundle` and `retry_publish` payloads carry no prose and no irreversible or high-blast token, extending the existing sweep rather than excusing new fields |
| Unit: action-name conformance | `MARKETING_ACTION_NAMES` is the disjoint union of derived, human-initiated and unmapped, so a future name cannot vanish into a derivation that never fires |
| Integration, throwaway Postgres | stage, approve, drain against a local fake Pages server that records the multipart body and returns a canned deployment id and url; then promote approval, second drain, bundle `live`; then a 401 path, a retry approval creating a new queued row, and the byte-moved refusal |
| Integration, lead intake | a real form-encoded request creates one prospect, one `email` channel with `profile_url` set to the page, one `opt_in` consent row, one `marketing_leads` row. A duplicate email creates one lead and no second prospect. Cap and honeypot paths |
| Integration, M3 | age a draft past `expires_at`, reject it, re-stage, and reach a usable approval with no bundle stranded in `staged`. Also asserts the six CRM approval tools still reject and approve normally |
| Integration, M4 | `suspended-runs` returns rows, and the decision call resumes |
| Console | typecheck and lint plus one browser walkthrough: bundle screen shows the file table, Prepare go-live stages a draft, the queue decision promotes |

`npm run verify` stays red by design in this repository, for the reasons in the project memory note and backlog M1. Slice 2's gate is therefore: `npm run typecheck`, `npm run lint`, filtered unit runs over the marketing and governance files, and filtered integration runs against the throwaway cluster on port 5455. The unfiltered `vitest run` spends paid live-model credit and is run once at the end, with the result compared to the slice 1 baseline rather than expected to be green.

The plan splits the slice in two halves that each end at a readable state: **2a, publishing** (migration 0019, slots and `siteHash`, artifact-aware derivation, the lead token mint and stamp, the adapter, the publisher, the two approvals plus retry, and the console controls), and **2b, intake and governance** (the lead route and its limits, then M3 and M4). The stamping belongs in 2a rather than 2b because it changes the bytes that `siteHash` covers, so a page published before 2a is finished would carry a literal `{{CRUM_LEAD_ENDPOINT}}`. 2a ends at a page on your domain whose form posts to an endpoint that does not answer yet, which is a legitimate stopping point; 2b is what makes the page worth publishing at all.

## 12. Where the code lands

| File | Change |
|---|---|
| `migrations/0019_crum_marketing_publishing.sql` | new, section 3.4 |
| `src/marketing/outbox.ts` | `promote_page` and `HUMAN_INITIATED_ACTION_NAMES`, `siteHash`, artifact-aware derivation, re-check under lock |
| `src/marketing/page-host.ts` | new: manifest builder, Cloudflare adapter, promotion adapter |
| `src/marketing/payload.ts` | `siteHash` in the stage view, plus promote and retry payload builders |
| `src/marketing/lead-token.ts` | new: mint, stamp, verify |
| `src/db/marketing.ts` | artifact slot queries, lead token column, lead insert and dedupe |
| `src/mastra/tools/marketing-writes.ts` | `promoteBundleTool`, `retryPublishTool` |
| `src/mastra/agent.ts:85-86` | the tool map gains `'marketing.promote_bundle'` and `'marketing.retry_publish'` beside the two existing marketing entries |
| `policy/tools.yaml` | two new `class: approval` entries with scopes `marketing:promote` and `marketing:retry`, which must be distinct because `tests/governance/conformance.test.ts` forbids one concrete scope holding two classes, and the `── approval (10)` section comment must move to the true count |
| `tests/governance/policy.test.ts:69` | the declared-approval-count assertion rises with it, which is the same file M5 records as driving a copied list elsewhere |
| `src/api/marketing.ts` | public `POST /api/marketing/leads`, owner-authenticated promote and retry staging routes, extended bundle read |
| `src/db/pending-writes.ts` | `marketing_promote` and `marketing_retry` branches in `applyDraft` |
| `src/api/approvals.ts` | M3 expiry ordering, M4 rows from `suspended-runs` |
| `scripts/publish-drain.ts` | new: the outbox drainer |
| `console/components/MarketingBundleView.tsx`, `ApprovalQueue.tsx` | file table, preview URL, Prepare go-live, Retry publish, resume control |
| `tests/**` | the layers in section 11 |

## 13. Deviations from the parent spec, recorded rather than hidden

1. Section 8 promised no new core table for inbound leads. `marketing_leads` is added, in the marketing plane, and section 7.4 states why the fields have nowhere else.
2. Section 10's slice 2 now also carries backlog M3 and M4, on the owner's instruction, because staging without a live queue entry and an expired draft that cannot die are the two things that make slice 2 painful to walk through.
3. Promotion is a re-upload producing a new deployment id, because Cloudflare documents no promote call. Section 2 states the evidence and the spike task is the check.
4. No new golden-dataset items in this slice. Slice 1 added two, the gate is already red from unrelated causes, and a third paid lane buys no coverage that section 11's integration tests do not already provide. This is a choice, not an oversight, and section 12 of the parent spec stays as written for a later phase.
5. `.env.example` is untouched, for the dirty-tree reason in section 9.

## 14. Non-goals of this slice

Unpublishing a page. Anything to do with an ad account. Designer image generation, which is slice 4. The analyst schedule and the weekly numbers message, which are slice 3. The cognitive forcing field where the reviewer types a prediction, which is slice 4. A/B testing, pixel and conversion API plumbing, per spec section 11. Replying to an inbound lead automatically, ever. A client entity.

Deferred and still open: backlog M1 (six real integration failures), M2 (illegal UUID literals), M5 (denial-path coverage driven off the policy instead of a copied list), M6 (four parked Minors).

## 15. Risks worth naming before the first task

| Risk | Mitigation in this design |
|---|---|
| The provider behaves differently than its docs, as the community threads report | a spike task runs first and can invalidate section 2 before code is written |
| A published page is live and CRUM thinks it is not | the outbox is the source of intent, the recorded `result` is the provider's answer, and `unpublish_page` stays unmapped so nothing pretends to reverse it |
| A public endpoint becomes a spam sink | secret per-bundle token, cap, honeypot, `404` symmetry, and no outbound effect |
| The M3 fix changes governance semantics for ten other approval tools | section 11 asserts the six CRM tools still reject and approve normally after the change |
| Rubber-stamping returns, which is tiger T1 | two separate approvals for one campaign is a deliberate reduction in clicks per decision, so the daily bundle count is watched and the console labels a second same-day bundle as exceeding the review budget |
