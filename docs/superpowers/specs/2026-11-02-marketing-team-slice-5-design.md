# CRUM Marketing Team, Slice 5 Design

Date: 2026-11-02
Branch: `feat/marketing-slice-5`
Prior slices: slice 1 `docs/superpowers/specs/2026-10-30-marketing-team-design.md`, slice 2 `2026-10-31-marketing-team-slice-2-design.md`, slice 3 `2026-10-31-marketing-team-slice-3-design.md`, slice 4 `2026-11-01-marketing-team-slice-4-design.md` (shipped at `6ed390d` on `main`).
Verification report that named the holes this slice closes: `docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md`.

## 1. What we are building

Slice 4 ended with a marketing team that can generate images and a reviewer who is forced to think before approving them. What it could not do was put a generated image on the published page. The images exist as documents with bytes, they appear in the review panel, and then `resolveSite` drops every one of them on the floor because it only knows the two HTML slots. The owner approves a bundle that says "hero image, testimonial image" and publishes a page with no pictures on it.

This slice closes the six named residuals and the two whole-branch review items, in one pass:

| # | Hole | What "fixed" means |
|---|------|--------------------|
| R1 | A generated image never reaches the published page | The page's placeholders resolve to hosted asset paths inside the bytes the approval hashes, and the image bytes are uploaded beside the page |
| R2 | A staged bundle keeps its open approval after its assets change | An asset change hard-rejects the open stage draft and moves the bundle back to `draft` |
| R3 | One ceiling for the whole tenant day lets one bundle eat it | A second, lifetime ceiling per bundle under the daily tenant ceiling |
| R4 | One image provider reached through a module global | A named registry, selected by config, with no silent fallback |
| R5 | `marketing_asset` documents are not browsable | The document manager lists them and shows thumbnails, through the same prediction gate |
| R6 | `marketing.set_campaign_status` is declared and governed but unreachable and uncommittable | The agent can call it, the analyst cron can stage one, and approving it enqueues the action |
| RV1 | `reviewer_predictions.createdAt` is typed `string` and is a `Date` at runtime | The row mapper normalises, so the declared type tells the truth |
| RV2 | `write-claim-guard.test.ts:58` asserts a literal count nothing derives | The list is derived from `policy/tools.yaml` and the executable registry. Doing so finds four mutating tools missing from the guard |

Two of these turned out to be deeper than the verification report could see, and they are the reason this slice is worth doing rather than deferring. R6 is not a missing registry entry. `applyDraft` has no branch for `marketing_set_campaign_status`, so the draft falls through to `requireTarget` (`src/db/pending-writes.ts:632`) and throws `UnsupportedCommitError`. Approving one commits nothing today. And `stageCampaignStatusChange` (`src/mastra/tools/marketing-writes.ts:875`) passes `targetId: args.campaignExternalId` and `requestedBy: 'analyst-cron'` into columns declared `uuid` (`migrations/0002_crum_spine.sql:149` and `:158`), so staging one crashes in the insert. Neither path was ever exercised end to end because nothing could reach it. That is the class of bug the slice-4 report called a residual and this slice calls a requirement: a proof must run the code, not the mock.

R1 is the load-bearing one. Everything else is either arithmetic or wiring.

## 2. The rule that keeps this survivable

The bytes a reviewer approved are the bytes that go live, or nothing goes live.

Slice 2 built that rule into three places that must agree: `deriveActions` computes a `siteHash` at stage time, `commitBundleApproval` recomputes it under a `FOR UPDATE` lock and throws if it moved, and `readSiteFiles` recomputes it again at publish time. Slice 3 bent the rule once, on purpose. `injectPixelIntoFiles` runs in `makePublishPageAdapter` after `readSiteFiles` has checked the hash, so the published page carries a tracking script that the hashed bytes did not contain. That is defensible for a script tag the owner configured, and it is documented in the code that does it.

It is not defensible for the picture. A hero image is the thing the review is about. So R1 must put the asset URL inside the hashed bytes, which means the resolution has to happen on the same path that produced the hash, not after it. That single constraint decides the whole design of section 5, and it is why this slice does not reuse the pixel injection shape even though that shape is right next to it and would have been easier.

## 3. Architecture

Nothing new enters the process map. The four processes stay: the API server, the Mastra agent, the publisher drain (`scripts/publish-drain.ts`), the analyst cron (`scripts/analyst-cron.ts`). The changes are inside the boxes and on the edges between them.

```
designer script ──> marketing.generate_assets ──> documents + document_files (bytes)
                                │                        │
                                │                        │  R3 per-bundle ceiling
                                │                        ▼
                                │                 marketing_image_spend (bundle_id)
                                │
funnel page_html ──> marketing.save_bundle ──> marketing_artifacts (text, no bytes read)
                                │
                          marketing.stage_bundle ──> loadSiteArtifacts ──┐
                                │                                        │ reads bytes
                                ▼                                        ▼
                        pending_writes (draft) ─────────────> resolveSite(slug, artifacts)
                                │                                     │
                     approval (prediction gate)                SiteFile[] (html + images)
                                ▼                                     │
                    commitBundleApproval ── re-derives hash ──────────┤
                                ▼                                     ▼
                    marketing_actions (queued) ──> publish-drain ──> Cloudflare Pages
                                                      │
                                             R2: any asset change after staging
                                                 rejects this draft, bundle -> draft
```

Three units carry the new shape:

`src/marketing/site.ts` remains the only place a hosted path is decided. It gains asset placeholders, byte files, and the problems that come with them. It stays synchronous and pure. Every refusal it can express is expressed as a sentence first (the `slotProblem` precedent) and as a throw second (the `resolveSite` precedent), because the stage tool wants to report and the publisher wants to fail.

`src/db/marketing-assets.ts` remains the only place that touches image bytes. It gains one reader that hands `site.ts` the artifacts plus the bytes of only the images the page actually references, so hashing a page never drags twelve megabytes of unreferenced PNGs into memory.

`src/marketing/image-provider.ts` stops being a singleton and becomes a named registry, modelled on `registerActionAdapter` in `src/marketing/outbox.ts:70`, including the unregister-closure return that lets a test put the world back.

## 4. Data model

One migration, `migrations/0022_crum_marketing_assets_reachable.sql`. It adds no table.

### 4.1 `marketing_image_spend` gains a bundle

```sql
ALTER TABLE marketing_image_spend ADD COLUMN IF NOT EXISTS bundle_id uuid;
CREATE INDEX IF NOT EXISTS idx_marketing_image_spend_bundle
  ON marketing_image_spend (tenant_id, bundle_id, created_at);
```

Nullable for the same reason `document_id` is already nullable (`0021` comment on the ledger): a prediction that produced no usable bytes still cost money, and a spend we cannot attribute to a bundle is the truth rather than a gap in the arithmetic. No backfill. Rows written before this slice have no bundle, so the new per-bundle ceiling counts only spend from now on. That is stated here rather than hidden because it is a real consequence: an owner who already burned $3 on a bundle will find the bundle ceiling counting from zero.

A generated column and a partial index were considered for the same goal and rejected. The join that gets there without the column, spend to document to artifact to bundle, is wrong in a way that matters: `insertAssetDocument` dedups on content hash (`src/db/marketing-assets.ts:78`), so identical bytes reached from two bundles are one document, and a spend row joined through it either double-counts or vanishes. The column records what was true at the moment the money was spent, which is the only moment that knows which bundle it was for.

### 4.2 Nothing gains a byte column

`resolveSite` will read image bytes from `document_files`, which has held them since `migrations/0011_crum_document_parse.sql:27`. A second byte store on the same entity is two sources of truth about whether a document has a file, and slice 4 already refused that on purpose.

### 4.3 `pending_writes` is unchanged, and that is the point

R2 needs `rejected_at` and `rejection_reason`, which exist (`0002:156` and `:157`), and the reject statement that already writes them (`src/db/pending-writes.ts:851`). R6 needs `marketing_set_campaign_status` in the object type list, which `migrations/0019_crum_marketing_publishing.sql:37` already admits. The only column-shaped problem is R6's `target_id`, and section 9.2 solves it in code with the existing content-addressed uuid helper rather than with a migration, because the column is right and the caller was wrong.

## 5. R1, the image reaches the page

### 5.1 The placeholder is the contract

The funnel builder writes `<img src="{{ASSET:hero}}" alt="Therapist adjusting a patient's shoulder">`. The designer names the asset `hero` in its script artifact, which `parseAssetPrompts` already reads and `marketing.generate_assets` already stores as the document title (`src/mastra/tools/marketing-writes.ts:1402`, `title: entry.name`). So the handle is a name both agents can see in the bundle before a single pixel is paid for, which is what makes it writable at page-save time, and it resolves to a document only at read time, which is what makes a re-run of the generator land in the same place.

Reference by document id was rejected on the order of operations alone. The page is saved into an `inbound_leads` bundle at the same moment its lead token is minted, and a later save that carries a page is refused once the token is set (`marketing-writes.ts:273`, `leadTokenLocked`). The funnel builder therefore cannot know a document id when it writes the page, because the images do not exist yet. A handle that requires the id is a handle that requires the page to be saved twice, and the design refuses that.

The grammar is `/{{ASSET:([^{}]+?)}}/g`, trimmed on both ends, because asset names are prose-ish (`Hero image` has a space in it) and a grammar that forbids spaces would silently fail to match the thing the model naturally writes. A name that contains a brace is refused by the prompt parser long before it reaches a page.

### 5.2 `SiteFile` carries bytes

```ts
export interface SiteFile {
  path: string
  sha256: string
  contentType: string
  content: Uint8Array
}
```

`content: string` becomes `content: Uint8Array`, and `contentType` is added so the upload can label the part. A union of `string | Uint8Array` was the alternative and is rejected because every consumer would have to branch on it and the branching would be the same two lines in four files. `sha256` is the hash of exactly the bytes that are uploaded, which is the invariant that has to hold, and it is unchanged for text because `createHash('sha256').update(str)` already hashes the UTF-8 encoding of the string. Every slice-2 and slice-3 site hash therefore keeps its value, and the existing hash tests keep passing without edit. That is not a coincidence to be relied on; the plan carries a test that asserts a known text-only site hash is byte-identical before and after the refactor.

Two helpers keep the text lane readable: `siteTextOf(file)` decodes, and `resolveSite` encodes. `src/marketing/pixel-injection.ts` decodes, injects, re-encodes and recomputes the hash, and still matches on `.html` paths so it can never touch an image.

### 5.3 Paths, extensions, and what gets published

A referenced image publishes at `${slug}/assets/${documentId}.${ext}`, under the same one-segment slug prefix that already keeps one bundle off another bundle's page (`site.ts:118`). The document id is in the path rather than the title because a title is a phrase an agent wrote and a hosted path must not be re-derived from prose on every read.

`ext` comes from a closed mime table: `image/png` to `png`, `image/jpeg` to `jpg`, `image/webp` to `webp`. Anything else is refused with `asset_mime_unsupported`. Refusing rather than falling back to a generic extension is the slice-3 rule from `pageHostConfigFromEnv`'s `nonBlank`, applied to bytes: a guessed type is a file the browser may not render, and nobody reviewing a page can tell from the outside.

An image the page does not reference is not published and not hashed. It is reported to the stage tool's output as `assetsUnreferenced` so the funnel builder gets told. Publishing it would put bytes on a public host that no reviewer placed anywhere, and the preview URL is indexable by anyone who finds it.

### 5.4 Where the bytes are read

`loadSiteArtifacts(tenantId, bundleId, slug)` in `src/db/marketing-assets.ts`, in two reads:

1. artifact rows for the three kinds the site can carry, joined to their document title and mime, no `data` column touched;
2. `document_files.data` for exactly the document ids that step one found referenced by a placeholder in a page.

The scan that produces those names is `assetNamesReferenced(html)` in `site.ts`, because the placeholder grammar belongs with the resolver that substitutes it. `resolveSite` stays pure: it receives artifacts that already carry `bytes` and `mime` on the images they name.

This is why `deriveActions` stays synchronous. It already receives artifacts from its caller, so the caller does the I/O and the derivation stays a function of data in memory. Three callers gain the loader call: `marketing.stage_bundle`, `commitBundleApproval` (which reads artifacts inside its transaction today, at `outbox.ts` in the block that starts "The bytes the reviewer approved are identified by a hash"), and `readSiteFiles` in `page-host.ts`. The transactional shape does not change: the artifacts, and now the bytes, are re-read inside the approval transaction because the `FOR UPDATE` lock covers the bundle row and nothing else.

For testability, `commitBundleApproval` gains an injected reader rather than calling the DB module directly, defaulting to the real one. Its existing `client` parameter exists because the lock must ride the caller's transaction, and the byte read has to ride the same one.

### 5.5 The problems, in text first

`siteProblem(artifacts)` answers, as a sentence, everything about the asset lane that `slotProblem` answers for the slot lane, and it is called by the stage tool before it creates a draft:

| Reason token | Sentence covers |
|---|---|
| `asset_name_missing` | the page names `{{ASSET:x}}` and the bundle holds no image titled `x` |
| `asset_name_ambiguous` | two image artifacts in the bundle share the title `x`, so the placeholder has two answers |
| `asset_mime_unsupported` | the bytes behind `x` are not png, jpeg or webp |
| `asset_bytes_missing` | the artifact claims a document that has no file row, or an empty one |
| `asset_too_large` | one image over 8 MiB, or the site over 24 MiB, or more than 12 images |
| `asset_unresolved` | after substitution a `{{ASSET:` fragment still survives in a page, which is malformed by construction |

`resolveSite` throws an `AssetProblemError` carrying the same token, and `commitBundleApproval` translates it to `BundleNotApprovableError` exactly the way it already translates `SlugProblemError`, so a moved asset answers the reviewer with a refusal rather than a 500.

The ceilings are in the same list rather than a separate guard because a page that cannot be uploaded is a page that must not be approved, and the publish-time failure `page-host.ts` documents as "the failure spec section 6 exists to prevent" is the one we are avoiding here.

### 5.6 The upload labels its parts

`buildUploadForm` in `page-host.ts` currently sets every part to `type: 'text/html'`. It becomes `new Blob([file.content], { type: file.contentType })`. Cloudflare serves the content type from the manifest upload, so an image uploaded as `text/html` is an image the browser is told to parse as markup. This is a two-line change that is only correct once `contentType` exists, which is why it is in R1 and not in a cleanup commit.

### 5.7 What the reviewer sees

No console change for R1. The bundle screen already lists artifacts with the images inline through the gated bytes route, and the reviewer's job on a placeholder is to check that the name matches a picture they can see and that the alt text is honest. The published page is checked at its preview URL after the drain, which is the walkthrough step that R1 finally makes meaningful.

## 6. R2, an asset change kills the open approval

### 6.1 The decision

Hard invalidation. When the assets of a staged bundle move, the open `marketing_stage` draft for that bundle is rejected in the database and the bundle returns to `draft`. There is no "stale, review anyway" state, no banner that leaves the approval live, and no attempt to re-hash the draft in place.

The reason is the prediction gate from slice 4. A reviewer who wrote a prediction against the old bytes has made a statement about a proposal that no longer exists. Leaving the approval open and updating its hash would let the reviewer approve the new bundle on the strength of a prediction written about the old one, which is precisely the drift the gate exists to catch. Making the reviewer write a new prediction costs them one paragraph, and the schema already wants that: `reviewer_predictions` is keyed `UNIQUE (pending_write_id)` (`0021`), so a fresh draft is automatically a fresh prediction with no new code.

### 6.2 The mechanics

`invalidateOpenStageDraft(tenantId, bundleId, reason)` in `src/db/pending-writes.ts`, reusing the reject statement at `:851` widened with a `RETURNING id`:

```sql
UPDATE pending_writes
   SET rejected_at = now(), rejection_reason = $3
 WHERE tenant_id = $1 AND object_type = 'marketing_stage' AND target_id = $2
   AND receipt_id IS NULL AND rejected_at IS NULL
```

An open draft has no representation other than those two nulls, which is how `getOpenStageDraft` already finds one. It then sets `marketing_bundles.status = 'draft'` for that bundle, because `staged` means "an approval is waiting" and none is. `marketing.stage_bundle` accepts both `draft` and `staged` (`src/db/marketing.ts:427`, where the status update carries `status IN ('draft','staged')`, and the `bundle_not_stageable` guard at `src/mastra/tools/marketing-writes.ts:411`), so nothing about re-staging changes.

The reason string is a token, `assets_changed_after_staging`, matching the refusal-token style `REFUSAL_PROSE` in `marketing-writes.ts:899` already uses for the same audience.

### 6.3 Three call sites, and why not a fourth

`marketing.generate_assets` calls it after any image artifact lands. `marketing.save_bundle` calls it when a save replaces artifacts on a bundle that has an open stage draft. The document review route (`reviewDocument` in `src/db/documents.ts`) calls it for every bundle returned by `listBundleIdsForDocument` when the document is a `marketing_asset`, because a flip from `needs_review` to `ready` changes whether the bundle can be approved at all, and `stage_bundle` refuses on exactly that field.

A fourth site was considered and rejected: invalidating when the spend ledger moves. Spend is not a property of the proposal, and a run that costs money without producing bytes must not silently invalidate a bundle someone is mid-review on.

Every call site is inside the same transaction as its own write where one exists, and the invalidation is idempotent. Two invalidations for one change produce one rejected draft.

## 7. R3, two ceilings

### 7.1 The arithmetic

| Check | Window | Source | Config |
|---|---|---|---|
| Per bundle | lifetime, all days | `SUM(cost_minor) WHERE tenant_id = $1 AND bundle_id = $2` | `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE`, default 200 minor ($2.00) |
| Per tenant | today | existing `committedSpendMinor` | `CRUM_IMAGE_SPEND_CEILING_MINOR`, default 2000 minor ($20) |

The per-bundle number is lifetime rather than daily on purpose. Its job is to stop one runaway loop on one bundle, and a bundle that has already had 40 images paid for does not deserve a second 40 tomorrow. The tenant ceiling keeps its day window because its job is the invoice, which arrives daily.

At `CRUM_IMAGE_COST_MINOR_PER_IMAGE` = 4 (that is $0.04 an image, the admission estimate in `env.ts:206`), $2.00 admits 50 images into one bundle. No campaign page needs 50. The default is therefore loose enough that a legitimate run never trips it and tight enough that a loop dies at 50 rather than at the tenant's $20.

### 7.2 The order

`marketing.generate_assets` checks the bundle ceiling first, then the day ceiling, then admits the image. Bundle first because the tighter and more specific refusal gives the owner a better next action: "this bundle is at its cap" tells them to revise the creative, while "today is spent" tells them to wait for midnight. Both tokens are distinct (`image_bundle_ceiling_reached`, existing `image_spend_ceiling_reached`) and both appear in the run's refusal list, so one run reports both if both bind.

`recordImageSpend` gains `bundleId` (`src/marketing/image-spend.ts:72`) and `committedBundleSpendMinor(tenantId, bundleId)` is added beside `committedSpendMinor`. The existing day sum is not touched, because a ceiling that reads a window nobody asked it to change is a ceiling that still passes its own tests.

## 8. R4, a provider registry with no fallback

### 8.1 The change

`src/marketing/image-provider.ts` replaces `setImageAdapter` / `getImageAdapter` with:

```ts
registerImageAdapter(adapter: ImageAdapter): () => void
selectImageAdapter(): ImageAdapter | null
listImageProviders(): string[]
__imageProviderRegistry: Map<string, ImageAdapter>
```

Keyed by `adapter.provider`. `selectImageAdapter()` reads `CRUM_IMAGE_PROVIDER` (default `replicate`) and returns that one adapter or null. An unknown name returns null, and `marketing.generate_assets` refuses with `image_provider_unknown` naming what is registered, which `listImageProviders` supplies.

No automatic fallback, which was the ruling taken as option A. A provider that fails gets its failure reported, its spend row recorded, and no second provider charged. The reasoning is the same one behind `pageHostConfigFromEnv` refusing half-configured hosts and `blockedActions` refusing to sign a receipt for an action with no adapter: CRUM does not make a purchase decision on the owner's behalf at runtime. A retry chain would also make the ceiling arithmetic a lie, because two providers failing one image would bill one image twice.

### 8.2 Registration

`src/mastra/index.ts` registers the Replicate adapter as `replicate` when `CRUM_REPLICATE_API_TOKEN` is present, keeping the existing condition in `imageProviderFromEnv` and the same all-or-nothing shape `makePublishPageAdapter` uses. `CRUM_REPLICATE_MODEL` and the ceilings stay as they are. A second provider in this slice is a non-goal (section 14); the registry exists so that adding one is a registration and an env default, not a refactor.

## 9. R6, the campaign status decision becomes reachable

### 9.1 The tool

`setCampaignStatusTool`, `id: 'marketing.set_campaign_status'`, added to `crumToolRegistry` in `src/mastra/agent.ts` as the 41st key. It wraps the existing `stageCampaignStatusChange` and copies the shape of `promoteBundleTool` (`marketing-writes.ts:910`): a synchronous `requireApproval` that scores a placeholder view, an `execute` that recomputes on the real payload, an input schema of `{bundleId, campaignExternalId, status, reason}` and the `StageOutputSchema` output. `policy/tools.yaml:281` already declares it with `class: approval` and `scope: marketing:status`, and `write-claim-guard.ts:25` already lists it, so the governance triangle only needs the registry edge.

This is what makes the analyst's scale and kill recommendations reachable from chat rather than only from the cron, which is what slice 3 intended and never shipped.

### 9.2 Two insert bugs, and the fix for each

`stageCampaignStatusChange` currently writes a draft with `targetId: args.campaignExternalId` and `requestedBy: 'analyst-cron'` into `uuid` columns. Fixes:

`target_id` becomes `uuidFromSeed('campaign:' + campaignExternalId)` from `src/marketing/hash.ts:47`, the same trick `snapshotIdFor` in `src/mastra/tools/prospect-writes.ts:438` uses to put a non-uuid external identity into a uuid column. It is deterministic, so a re-ask lands on the same draft. The real Meta id stays in the payload, which is where `applyDraft` reads it, because the payload is what the adapter is handed.

`requestedBy` becomes a resolved uuid. The signature gains a required `userId`, and `scripts/analyst-cron.ts` supplies `CRUM_ANALYST_USER_ID`, a new optional uuid setting. When it is unset the cron skips staging with a log line rather than writing a draft that cannot be attributed. `run_id` stays `'analyst-cron'`, which is a text column and honest. The alternative, a synthetic system user seeded by a migration, was rejected because it invents a person to satisfy a column whose real meaning is "who asked", and on the cron path the answer is a configured owner.

### 9.3 The applyDraft branch

`marketing_set_campaign_status` in `applyDraft`, beside the three marketing branches at `:459`, `:489` and `:570`, following the `marketing_promote` shape because it is the same kind of thing: one work order and no content change.

1. Require `operation === 'update'` (the draft is a state change on an external campaign, not a new CRUM row).
2. Read `campaignId` and `status` from the payload. Require `status` in `'ACTIVE' | 'PAUSED'`. A payload that is not one of these refuses rather than passing through to Meta.
3. Re-read under the transaction: the campaign must still be the product of a succeeded `create_campaign` action in this tenant, and the query returns its `bundle_id`, which the action row needs and the payload does not carry. This is the `marketing_promote` precedent applied to this branch's own claim: the payload asserts something about another row, and only a read inside the transaction can check it.
4. Re-check the no-op rule at approval time, not only at staging time. If the latest `set_campaign_status` action for that campaign already succeeded with the requested status, refuse. The state of a campaign is not something CRUM owns, so this is the last CRUM-side moment the question can be asked.
5. `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, receipt_id) VALUES ($1, $2, 'set_campaign_status', $3, 'queued', NULL)`, `RETURNING id`, and return that id as the committed record. `receipt_id` null for the reason `marketing_stage` and `marketing_promote` both give: the receipt is signed after `applyDraft` returns and the drainer back-fills it.
6. The branch returns the action row id rather than a bundle id, because the thing the receipt covers is the work order. `marketing_promote` returns a bundle id because its receipt covers a bundle decision.

No `COMMIT_TARGETS` entry, for the same reason `marketing_stage` and `marketing_promote` have none: they are not content rows in a CRM table.

## 10. R5, the generated images are browsable where the other documents are

Slice 4 closed the intake lane so a generated asset could not be uploaded through the document API, and the asset then had no browse surface at all: `src/api/documents.ts:188` answers 400 for any `kind` outside `invoice`, `contract`, `other`, and `listDocuments` (`src/db/documents.ts:389`) excludes `marketing_asset` from the default list. The images exist, they cost money, and the only way to see them is to be already inside the bundle screen that produced them.

### 10.1 The door that opens

The `?kind=` whitelist at `src/api/documents.ts:188` gains `marketing_asset`, the view type at `:30` widens to match, and `listDocuments` is asked by kind. With no `kind` the default stays exactly what it is, so nobody's invoice list fills up with PNGs. That is the whole API change: one admission to a whitelist that already does the filtering, and the exclusion logic already written for it.

No new route, no new scope, no new table. A generated image is a document, which slice 4 decided in section 4.1 of its own spec, and the document manager is where documents are browsed.

### 10.2 The thumbnails go through the gate that already exists

`console/components/DocumentManager.tsx` gains an Assets tab that lists `kind=marketing_asset` with title, review status, mime, created date and a thumbnail from the existing gated route `/api/marketing/assets/:documentId/bytes` (`src/api/marketing.ts:186`). When that route answers 409 because the owning bundle is staged and unpredicted, the tab renders an "awaiting review" placeholder rather than the picture.

This is a decision with a cost, and the cost is recorded here rather than discovered in review. The tempting alternative is a browse-only byte route with no prediction check, which would make the asset library pleasant and the cognitive forcing gate a joke: a reviewer who wants to peek before writing a prediction would open a different tab. Withholding in the review flow and serving in the browse flow is not one rule with two contexts, it is no rule. So the browse surface inherits the gate, and an owner who wants to browse freely browses assets whose bundles are already decided, which is most of them most of the time.

## 11. RV1 and RV2, the two review items

### 11.1 The type lie

`src/db/reviewer-predictions.ts:26` declares `createdAt: string` and `rowToPrediction` passes `row.created_at` through, which node-pg hands back as a `Date`. Two house patterns already exist, a cast (`pending-writes.ts:91`) and a normalise (`marketing-metrics.ts:68`, `billing.ts:113`). The normalise wins because the cast keeps the lie and the whole point of the review comment was that the type says something the runtime does not. So:

```ts
function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new Error(`reviewer_predictions.created_at is neither a Date nor a string: ${typeof value}`)
}
```

The throw is deliberate and matches the reasoning in `getAssetBytes`' deleted fallback (`src/db/marketing-assets.ts:119`): a silent `String(value)` on a malformed driver value produces a timestamp nobody can trust, and a 500 on data this corrupt is the honest answer.

The same lie is in the mapper that feeds the gate. `rowToPendingWrite` in `src/db/pending-writes.ts` casts three `timestamptz` columns `as string`, at `:86` (`rejectedAt`), `:91` (`createdAt`) and `:92` (`expiresAt`), and `getOpenStageDraft` (`:773`) hands that shape straight to the prediction gate. It is invisible today only because `JSON.stringify(new Date())` already emits an ISO string, so the console prints the right thing past a type that says the wrong thing. Both files use one helper rather than two copies of five lines:

```ts
// src/db/timestamps.ts
export function toIsoString(value: unknown, label: string): string
```

A unit test for the helper feeds a `Date`, a string and a number, and asserts the two accepted shapes plus the one crash. A second test asserts `rowToPrediction` and `rowToPendingWrite` return strings for a row whose driver value is a `Date`, which is the shape node-pg actually hands them.

The normalisers already working in `src/db/marketing-metrics.ts:68` and `src/db/billing.ts:113` are left alone. They are correct, they have no consumer bug, and rewriting code that works to match code that does not is how a slice loses the review argument. The new helper is what the two broken sites use and what future row mappers reach for.

### 11.2 The literal count

`tests/mastra/processors/write-claim-guard.test.ts:58` asserts `MUTATING_TOOL_IDS` has length 16. Nothing derives 16, and nothing connects the list to either of the two things it must agree with, which is the exact drift that produced residual R6: `marketing.set_campaign_status` sat in the guard list and in `policy/tools.yaml` and in the object-type CHECK while being absent from the registry and unreachable from `applyDraft`.

Deriving the list is not a tidiness exercise. Doing it finds a live bug in four lanes. `ranMutatingTool` (`src/mastra/processors/write-claim-guard.ts:80`) answers true only for ids in `MUTATING_TOOLS`, and four tools that mutate and are callable are not on the list: `crm.draft_outreach`, `crm.send_outreach`, `crm.save_prospect_snapshot` and `crm.resolve_merge_candidate`, declared `auto`, `approval`, `auto` and `approval` in `policy/tools.yaml` and writing outreach drafts, sends, evidence snapshots and merge resolutions. So a turn that really did send an outreach and then says "I've sent it" looks, to this processor, exactly like a turn that hallucinated the send. That is the false-positive class the file's own comment says killed the earlier guard, still present one level up, and one of the four is an email lane.

Three derived assertions replace the literal, in the same file:

1. `MUTATING_TOOL_IDS` equals the tools `policy/tools.yaml` declares with a class other than `read-only` that are also keys of `crumToolRegistry`. The intersection does the work that a hand-written exception list would otherwise do: `run.side-effect` is a workflow label rather than a callable tool, and `crm.bulk_import` is declared in the policy and implemented nowhere, so neither can appear in a turn's tool calls and neither belongs in the guard. Adding the four prospect-lane ids is the change this assertion forces.
2. Every id in `MUTATING_TOOL_IDS` is a key of `crumToolRegistry`. This is the one that would have caught R6 by itself, and it is the reason this item is not cosmetic.
3. The declared mutating tools that are not in the registry equal the explicit backlog `{crm.bulk_import}`. A gap that is named in a test stays a known hole; a gap that is excluded by a filter nobody checks becomes a permanent blind spot.

Assertion 1 reads the policy through the existing loader rather than a second parser, so the test and the runtime ask the same source the same question. Adding four ids to `MUTATING_TOOLS` widens what the processor accepts as evidence of a write, which loosens the guard in one direction and tightens the user experience in the other. That is the correct trade: the guard's job is to catch a claim with no tool behind it, and a tool that ran is evidence.

`crumToolRegistry` is currently a module-local `const` in `src/mastra/agent.ts`, so it gains an `export` on the object it already builds, which is a one-word change and does not widen what the module publishes to other processes.

## 12. Error handling

| Failure | Where caught | What the owner gets |
|---|---|---|
| Page names an asset the bundle does not have | `siteProblem`, before the stage draft exists | A refusal naming the placeholder and the titles it does have |
| Two images share a name | `siteProblem`, before the stage draft exists | A refusal naming the title and both artifact ids |
| Asset bytes move between staging and approval | `commitBundleApproval` via `AssetProblemError` | `BundleNotApprovableError`, so the approval answers "no" in a sentence |
| Asset over a size ceiling | `siteProblem`, before the stage draft exists | A refusal naming the byte count and the ceiling |
| Image uploaded with the wrong content type | impossible by construction: `contentType` travels with the file | n/a |
| Bundle ceiling reached | `generate_assets`, before any provider call | `image_bundle_ceiling_reached` in the run's refusal list |
| Provider named in config is not registered | boot, and `generate_assets` | `image_provider_unknown` naming what is registered |
| Selected provider fails | `generate_assets`, no second attempt | the provider's own error, one spend row, no fallback |
| Asset change after staging | the write path that moved it | the draft is `rejected` with `assets_changed_after_staging`, bundle back to `draft` |
| Campaign status approved while its campaign is gone | `applyDraft` re-read | `UnsupportedCommitError` naming the campaign id |
| Analyst cron with no configured user | `runAnalystCron` | a log line, recommendations still reported, nothing staged |

One principle runs through the table: the refusal is asked at the last moment it can still be answered cheaply. Stage-time refusals cost a conversation. Approval-time refusals cost a review that has to be redone. Publish-time refusals cost the owner a live page that is not the page they approved, which is why R1 pushes every asset question it can to stage time.

## 13. Testing

Unit, in the existing projects:

`tests/marketing/site.test.ts` extended for the placeholder grammar (single reference, repeated reference to one image, two names, a name with spaces, a malformed token), for image files in the hash, for `sha256` equality between the old string path and the new byte path on a text-only site, and for every token in the 5.5 table.

`tests/marketing/pixel-injection.test.ts` extended so injection into a byte `SiteFile` recomputes the hash and leaves image files untouched.

`tests/marketing/page-host.test.ts` extended so `buildUploadForm` labels an html part `text/html` and an image part `image/png`, and so `readSiteFiles` refuses when the stored image bytes move.

`tests/marketing/image-spend.test.ts` and `tests/marketing/image-provider.test.ts` for the bundle sum and the registry, including no-fallback: a registered `replicate` that throws is called once and its error surfaces.

`tests/mastra/marketing-write-tools.test.ts` extended for the invalidation call sites, for the new tool's scoring and gate, and for `stageCampaignStatusChange` writing a uuid `target_id` and a uuid `requestedBy`.

`tests/mastra/processors/write-claim-guard.test.ts` rewritten to the three derived assertions in 11.2, and a new guard test case for the outreach lane: a turn that called `crm.send_outreach` and claims the send is not flagged.

Console, `console/components/DocumentManager.test.tsx` for the assets tab, its filter, and a 409 thumbnail rendering as awaiting review.

Integration, against the throwaway cluster on 5455 with `CRUM_INTEGRATION_DATABASE_URL`:

1. A page with one placeholder, one real document with real bytes, staged, approved, and drained to a local stub Pages server, asserts the uploaded manifest carries `slug/index.html` plus `slug/assets/<uuid>.png`, that the HTML the stub received contains the resolved path and not the placeholder, and that the site hash the approval signed equals the hash recomputed from the uploaded bytes. This is the proof R1 is real, and it is the test that the slice-4 walkthrough could not write because the page had no picture on it.
2. `generate_assets` on a staged bundle rejects its open draft, moves the bundle to `draft`, and a re-stage creates a second draft whose prediction row does not exist yet.
3. Two ceiling tests, one per layer, and one asserting the day ceiling does not fire when the bundle ceiling does.
4. `marketing.set_campaign_status` end to end: stage, approve, assert one queued action row with the payload the adapter wants, then run the adapter against a stubbed Meta fetch and assert the campaign id it PATCHed.
5. A spend row written with a `bundle_id` and the per-bundle sum reading it back, plus a dedup case that proves the join path 4.1 rejected would have been wrong.

Manual walkthrough, on a real bundle with a real Replicate image: generate, stage, predict, approve, publish, then open the preview URL in a browser and look at the picture. This is the step that closes the residual, and per the standing rule no claim about R1 is made without it.

A skipped integration test is never reported as a pass.

## 14. Non-goals

No second image provider, no video, no audio. No automatic fallback between providers. No re-hash of an existing draft in place of invalidation. No change to what the pixel injects or when (its post-hash deviation stays, documented, and is not extended). No drag-and-drop page editor, no asset library screen beyond the document manager tab, no public asset index. No campaign status other than `ACTIVE` and `PAUSED`. No migration that backfills `bundle_id` on old spend rows.

## 15. Where the code lands

| File | Change |
|---|---|
| `migrations/0022_crum_marketing_assets_reachable.sql` | new: `bundle_id` on the ledger, one index |
| `src/marketing/site.ts` | byte `SiteFile` with `contentType`, placeholder grammar, `siteProblem`, `AssetProblemError`, image paths |
| `src/db/marketing-assets.ts` | `loadSiteArtifacts`, `getAssetBytesByIds` |
| `src/marketing/pixel-injection.ts` | decode, inject, re-encode, re-hash |
| `src/marketing/page-host.ts` | per-part content type, `readSiteFiles` through the loader |
| `src/marketing/outbox.ts` | enriched artifacts at approval, injected reader, `AssetProblemError` translation |
| `src/marketing/image-spend.ts` | `bundleId` on the row, `committedBundleSpendMinor` |
| `src/marketing/image-provider.ts` | named registry, no singleton |
| `src/config/env.ts` | `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE`, `CRUM_IMAGE_PROVIDER`, `CRUM_ANALYST_USER_ID` |
| `src/mastra/tools/marketing-writes.ts` | asset refusals and `assetsUnreferenced`, invalidation calls, uuid fixes, `setCampaignStatusTool`, ceiling order |
| `src/mastra/agent.ts` | registry gains `marketing.set_campaign_status`, `crumToolRegistry` exported |
| `src/db/pending-writes.ts` | `invalidateOpenStageDraft`, the `marketing_set_campaign_status` branch |
| `src/db/documents.ts` | `reviewDocument` invalidation for a `marketing_asset`, `listDocuments` kind widened in type only |
| `src/api/documents.ts` | `?kind=` admits `marketing_asset` |
| `src/db/reviewer-predictions.ts` | `toIsoString` on `createdAt` |
| `src/db/timestamps.ts` | new: the shared normaliser, and the crash on a value that is neither |
| `src/mastra/processors/write-claim-guard.ts` | four prospect-lane mutating ids join the list |
| `scripts/analyst-cron.ts` | configured user, skip-with-log when unset |
| `console/components/DocumentManager.tsx` | assets tab and thumbnails |

## 16. Delivery slices

Four reviewable chunks, each with its own tests and commit, executed through the same brief, fresh implementer, independent review loop as slices 2 to 4.

**S5a, the byte lane (R1).** `site.ts`, `marketing-assets.ts`, `pixel-injection.ts`, `page-host.ts`, `outbox.ts`, plus the integration proof 1. The largest and the riskiest. It lands first because R2's invalidation is only worth having once a moved asset changes a hash, which is only true once assets are in the hash.

**S5b, the ceilings and the registry (R3, R4).** Migration 0022, `image-spend.ts`, `image-provider.ts`, `env.ts`, `marketing-writes.ts`, `index.ts`, integrations 3 and 5.

**S5c, invalidation (R2).** `pending-writes.ts`, the three call sites, the console's rejected-draft surface if it needs a line, integration 2.

**S5d, the browse surface, reachability and the review items (R5, R6, RV1, RV2).** `?kind=` admission and the assets tab, the `applyDraft` branch, the new tool, the uuid fixes, the cron config, `reviewer-predictions.ts` and `pending-writes.ts` through the timestamp helper, the guard list and its rewritten test, integration 4. Independent of S5a to S5c and last so that the governance assertions in RV2 run against the registry that R6 has just widened.

Then the whole-branch review, the walkthrough with a real image on a real page, and the verification report.
