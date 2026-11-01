# CRUM Marketing Team, Slice 4 Design

**Date:** 2026-11-01
**Status:** self-reviewed against the code, ready for the implementation plan
**Scope:** Designer image generation stored through `documents`, an asset production pass with a hard spend ceiling, and the cognitive forcing gate on the bundle review screen

**Parent spec:** `docs/superpowers/specs/2026-10-30-marketing-team-design.md`, section 10 slice 4, which says slice 4 ships "Designer image generation into `documents`, the cognitive forcing field on the bundle screen", makes "Original creative instead of stock" real, and gates on "Image key required".

## 1. What we are building

Slices 1 to 3 made the marketing team real but mute: the designer writes image prompts, and a stranger has to take them somewhere else and pay for them. Slice 4 closes that gap. The prompts the designer already returns become the images themselves, stored inside CRUM, attached to the bundle a human then reviews.

The second half is the part the pre-mortem asked for. `docs/PreMortem-crum-agent-system-2026-10-28.md` tiger T1 names rubber-stamping as the failure mode, and slices 1 to 3 give the reviewer an approve button and a page of AI-written copy, which is precisely the setup where a human clicks yes without reading. Tiger T1's prescribed device is that the reviewer commits to a prediction *before* seeing the proposal. Slice 4 builds that device.

**What this slice makes real:**
- Generated images that exist as bytes in CRUM, deduplicated by sha256, held at `needs_review`
- An asset production pass that spends cents up to a stated ceiling and refuses past it
- A prediction the reviewer types before the bundle renders, stored next to the receipt
- The two halves a later report needs to compare expectation against result, both now stored in the same database

**What this slice does not do:**
- Generate video or audio. Images only.
- Let a subagent hold a tool. The six agents keep `tools: {}`.
- Auto-publish an image anywhere. An image is a file inside CRUM until a bundle carrying it is approved and published.
- Score the reviewer's accuracy automatically. Slice 4 stores predictions next to metrics; the report that joins them is a later slice.
- Add a second image provider. One adapter, one provider, swappable later.

## 2. The rule that keeps this survivable

Unchanged: **a subagent may spend tokens and cents, but may never change anything outside CRUM.**

Slice 4 spends real money on an external API, which is the first time this build pays a provider that is not the model. The rule holds in a specific way here. Calling Replicate *is* an outbound HTTP request, so it needs a home, and the question is whether it belongs in the outbox.

It does not, and the reason is the difference between *buying a file* and *changing the world*. The outbox exists because an approved bundle must not be able to sign a receipt for a page the host never received. Generating an image creates no external state that anyone downstream depends on: the image sits in a bucket at Replicate for an hour and then the bytes are ours. Nothing outside CRUM learns that the campaign exists. So `marketing.generate_assets` is an auto-committed content write, the same class as `marketing.save_bundle`, and it is not approval gated.

What does need gating is the money. Three consequences carry the whole design:

| Consequence | Why it is acceptable |
|---|---|
| Asset production runs in code, not in an agent turn | The prompt is the agent's job, the payment is the harness's job, and a number that must not be exceeded cannot be enforced by prose in a system prompt |
| A daily ceiling is checked before the first call, not after the last | Spending past a ceiling and then reporting it is not a ceiling. Past the ceiling the tool refuses and opens a `human_tasks` row |
| Every generated image lands at `status = 'needs_review'` | A generated face with six fingers is a marketing asset the owner must look at before it means anything. `POST /api/documents/:id/review` (`src/api/documents.ts:250`) and `reviewDocument` (`src/db/documents.ts:524`) are already the human flip, built for invoices, so slice 4 adds the review state and the gate but not a new review screen |
| The reviewer's prediction is required before the bundle renders | The forcing is only real if the alternative is not "just scroll past it". No prediction, no bundle |

## 3. Architecture

Two independent halves, which means they can ship in either order and one can be reverted without touching the other.

**Half one: images.**

```
creative-designer (unchanged, tools: {})
  ↓ returns assets[] of {name, purpose, prompt, negativePrompt, aspectRatio}
the primary agent stores that JSON as a marketing_artifacts row
(role 'creative-designer', kind 'script', text_content = the JSON)
  ↓
marketing.generate_assets  (new tool, crm-assistant only, auto-committed)
  ↓ reads the asset prompts back out of that stored artifact row
  ↓ checks the daily ceiling in marketing_image_spend
  ↓ POST https://api.replicate.com/v1/predictions  (per asset)
  ↓ fetches the returned output URL bytes
  ↓ INSERT INTO documents (kind='marketing_asset', status='needs_review')
  ↓ INSERT INTO document_files (the bytes, through the existing byte lane)
  ↓ INSERT INTO marketing_artifacts (the bundle now carries the image)
  ↓ records spend in marketing_image_spend
  ↓
owner reviews the bundle, sees the images inline
  ↑ GET /api/marketing/assets/:documentId/bytes (new, gated the same way)
```

`marketing_bundles` has no designer column and gets none. Its five role columns are `strategy`, `copy`, `media_plan`, `funnel_plan` and `analysis` (`migrations/0018_crum_marketing.sql:25-29`), and the table's own comment says why the designer is absent: "The designer has no column: its output is bytes, so it lands in `marketing_artifacts`." So the prompt set the money is spent on is one `role = 'creative-designer', kind = 'script'` artifact row, which slice 1's `save_bundle` already accepts without change: `ArtifactInputSchema` allows any role with any non-image kind as long as `textContent` is present, which is exactly what a prompt set is.

No CRUM route serves raw document bytes today: `src/api/documents.ts` has `/:id`, `/:id/invoice` and `/:id/contract`, all of which read the parsed representation, and nothing that returns `document_files.data`. A stored image nobody can display is a stored image nobody can review, so slice 4 adds the one route the byte lane exists for. It is tenant-scoped, it returns the stored `mime`, and it refuses any `kind` other than `marketing_asset`, so it cannot be pointed at an invoice.

`marketing_artifacts` already has a `kind = 'image'` value whose `document_id` is required by the table's own `marketing_artifacts_payload_shape` CHECK (`migrations/0018_crum_marketing.sql:73`), and its `role` CHECK already lists `creative-designer`. The image attach path is therefore an insert into a table that was built for it in slice 1, not a schema change.

**Half two: the forcing gate.**

```
console bundle screen
  ↓ GET /api/marketing/bundles/:id  (existing)
  ↓ is there a reviewer_predictions row for this staged draft?
  ↓ NO  → render only the prediction textarea. The bundle stays hidden.
  ↓ YES → render the bundle as slices 1 to 3 do
  ↓
POST /api/marketing/bundles/:id/prediction
  ↓ INSERT INTO reviewer_predictions (pending_write_id, predicted_outcome)
  ↓
bundle renders
```

**New env vars:**
- `CRUM_REPLICATE_API_TOKEN`
- `CRUM_REPLICATE_MODEL` (default `black-forest-labs/flux-1.1-pro`)
- `CRUM_IMAGE_SPEND_CEILING_MINOR` (default `2000`, which is $20 a day in cents)
- `CRUM_IMAGE_COST_MINOR_PER_IMAGE` (default `4`, the admission estimate described in §4.2)

Four vars, and none of them written to `.env.example`, for the reason §14 gives.

## 4. Data model

### 4.1 Widening `documents` to hold a generated image

`migrations/0009_crum_documents.sql` built `documents` for invoices and contracts, and its two CHECK constraints do not admit a generated image:

```sql
kind   CHECK (kind IN ('invoice', 'contract', 'other'))
source CHECK (source IN ('upload', 'email'))
```

The parent spec section 8 chose `documents` on purpose, because a generated image inherits the sha256 dedup at `uq_document_hash`, the provenance columns, and a review status a human can flip. So the constraints widen. Migration `0021_crum_marketing_assets.sql`, in the `DROP CONSTRAINT IF EXISTS` style 0015, 0018 and 0019 use:

```sql
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('invoice', 'contract', 'other', 'marketing_asset'));

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('upload', 'email', 'generated'));

CREATE INDEX IF NOT EXISTS idx_documents_assets
  ON documents (tenant_id, kind, status)
  WHERE kind = 'marketing_asset';
```

**No new column, and this is the finding that changed the design.** An earlier draft of this spec added `content_bytes bytea` to `documents`. It was wrong, and `migrations/0011_crum_document_parse.sql:27` is why: `document_files` already is the byte lane, one row per document with `mime`, `size_bytes` and `data bytea NOT NULL`, cascaded with the parent, and `insertDocument` already writes it from `PersistDocumentInput.file` (`src/db/documents.ts:284`). A second place to put bytes on the same entity is two sources of truth about whether a document has a file, and every future reader would have to check both. An image is a document with a `document_files` row whose mime is `image/png`, exactly like an invoice is.

The column mapping, and why each one is the honest choice:

| Where | What a generated image puts in it | Why |
|---|---|---|
| `documents.kind` | `marketing_asset` | The widened value. Keeps the CRM ledger query `kind = 'invoice'` untouched |
| `documents.title` | the asset name from the designer, e.g. `hero-image` | Matches how the bundle refers to it |
| `documents.content_hash` | sha256 of the **image bytes** | This is the point of using `documents`. A re-run on the same seed produces the same bytes, and `uq_document_hash` stops paying twice. The 0009 comment defines the column as "sha256 of the extracted text"; for an image there is no extracted text, so the bytes are the content being fingerprinted, which is the same rule with a different input |
| `documents.content_text` | the prompt that produced it | The column is `NOT NULL`, and the prompt is exactly the provenance a reviewer needs |
| `documents.mime` | `image/png` | Already exists, and `document_files.mime` repeats it the way an upload does |
| `documents.status` | `needs_review` | Never `ready` on arrival. A human flips it |
| `documents.source` | `generated` | The widened value |
| `documents.owner_id` | the user who ran the asset pass | `owner_id` is `NOT NULL` (`migrations/0009_crum_documents.sql:27`) with no default, so every asset insert must name a person. It is `requestedBy` from the tool context, never a synthetic uuid: an image nobody can be traced to is an image nobody can be asked about |
| `documents.raw_extract` | `{ replicateId, model, aspectRatio, negativePrompt, costMinor, seed, prompt }` | The jsonb column already exists for "full model output plus provenance". The prompt is repeated here as well as in `content_text` because `raw_extract` is what a re-run reads to prove the seed, and `negativePrompt` has no other home: FLUX 1.1 Pro takes no negative prompt, so the field is recorded for a future model rather than sent |
| `document_files.data` | the bytes | The existing byte lane, written through `PersistDocumentInput.file` |

`PersistDocumentInput`'s two literal unions at `src/db/documents.ts:159-181` are the TypeScript half of the CHECK widening: `kind` gains `'marketing_asset'` and `source` gains `'generated'`, or the database will accept a row the compiler forbids building.

One real change to `insertDocument` is needed, and it is small. The file insert sits inside `if (row.is_new && input.parse)` (`src/db/documents.ts:283`), so a document with bytes but no parse run silently drops them. The guard becomes `if (row.is_new && (input.file ?? false || input.parse))`, with the `document_files` write hoisted out of the `input.parse` block and the parse and block writes kept inside it. A generated image has no parse and no blocks, so today it would store the metadata row and lose the bytes, which is the failure this whole slice exists to avoid. The test is a document written with `file` and without `parse`, asserting the `document_files` row exists.

The generated image must never reach the vector index. The real path is not a query in `src/db/documents.ts`: embedding happens when `src/api/documents.ts` enqueues the `crum-document-intake` workflow, whose `ingestStep` (`src/mastra/workflows/ingest.ts:40`) chunks and embeds supplied text. The asset path writes the `documents` row directly and never enqueues that workflow, so an image is un-indexed by construction rather than by a filter. Two guards make that construction permanent, and both get their own test:

- `src/api/documents.ts` refuses to run intake on a document whose `kind` is `marketing_asset`, so a future re-index cannot embed bytes.
- `listDocuments` (`src/db/documents.ts:364`) gains a default exclusion for `kind = 'marketing_asset'`. Without it, every generated hero image appears in the owner's CRM document list between their invoices, which is not a marketing decision and reads like a bug to whoever is hunting for a bill.

### 4.2 `marketing_image_spend`, the ceiling ledger

`CRUM_IMAGE_SPEND_CEILING_MINOR` is only real if there is a number to compare against. A new table in the same migration:

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid NOT NULL | |
| document_id | uuid | nullable, because a prediction that failed to produce bytes still cost money |
| provider | text NOT NULL | `replicate`, so a second provider does not need a new column |
| cost_minor | integer NOT NULL | cents. Replicate bills per image for FLUX, so this is exact, not estimated |
| spent_on | date NOT NULL | the day the ceiling is per-day over |
| created_at | timestamptz | |

The check reads `SELECT COALESCE(SUM(cost_minor), 0) FROM marketing_image_spend WHERE tenant_id = $1 AND spent_on = CURRENT_DATE` and compares against the ceiling before the first call, and again before each subsequent call inside the loop. A run that would cross the ceiling stops at the boundary and returns the assets it did make plus a refusal naming the asset it did not.

The per-image price used in the pre-run check is one configured number, not a guess per prompt: `CRUM_IMAGE_COST_MINOR_PER_IMAGE` (default `4`, being $0.04 for a FLUX 1.1 Pro 1024px output). The pre-run check multiplies it by the number of assets, so a 6-asset bundle asks for 24 minor units of headroom before spending anything. The recorded spend stays the real figure Replicate reports on the prediction, because an estimated ledger is how a ceiling drifts from reality without anyone noticing; the estimate is only ever the admission test.

`document_id` is not a foreign key with cascade, because a spend row must outlive a deleted document. Deleting the bytes cannot retroactively un-pay the invoice.

The table has no `updated_at`, and therefore no `trg_*_touch` trigger. It is append-only: a spend that happened is never edited, which is the same reason `audit_receipts` has no `updated_at` either.

### 4.3 `reviewer_predictions`, the forcing record

A new table, same pattern as `audit_receipts`: one row per staged draft, forever.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid NOT NULL | |
| pending_write_id | uuid NOT NULL REFERENCES pending_writes(id) ON DELETE CASCADE | the draft, not the bundle, so a re-staged bundle is a fresh prediction |
| predicted_outcome | text NOT NULL | free prose, e.g. `about 6 booked calls a week` |
| created_at | timestamptz NOT NULL DEFAULT now() | |
| CONSTRAINT uq_prediction_draft | UNIQUE (pending_write_id) | one prediction per decision, so a reviewer cannot revise after seeing the copy |

The unique constraint is the whole device. A prediction written after the fact is not a prediction, and the constraint is what makes "type it before you look" a fact about the database rather than an instruction on screen.

**Which draft, exactly.** A bundle can hold four kinds of open approval draft (`marketing_stage`, `marketing_promote`, `marketing_retry`, `marketing_set_campaign_status`), so "this staged draft" needs one definition, not a phrase. The prediction attaches to the bundle's open `marketing_stage` draft: `object_type = 'marketing_stage' AND target_id = <bundle id> AND receipt_id IS NULL AND rejected_at IS NULL AND expires_at > now()`, newest first. A new helper `getOpenStageDraft(tenantId, bundleId)` in `src/db/pending-writes.ts` owns that predicate, because no query by `target_id` exists there today and the route must not invent one inline.

That predicate is also what turns the gate off, and the direction matters. **A bundle with no open stage draft renders exactly as slices 1 to 3 made it, with no gate at all.** The alternative, gating every bundle view, would lock a `draft` bundle away from its author, who is the only person who can stage it, and the screen would be unreadable by construction. The gate exists to make one approval honest, so it applies when there is an approval to make. Slice 4 does not gate the promote, retry or status drafts; they are the same device applied to three later decisions, and §11 says so.

## 5. Replicate integration

`src/marketing/replicate.ts`, hand-written `fetch` like every other adapter in this repo, because adding the official SDK would put a browser-flavoured dependency in a server for no gain.

### 5.1 The calls

Two requests per image. First, create the prediction:

```
POST https://api.replicate.com/v1/predictions
Authorization: Token {CRUM_REPLICATE_API_TOKEN}
Content-Type: application/json

{
  "model": "black-forest-labs/flux-1.1-pro",
  "input": {
    "prompt": "...",
    "aspect_ratio": "16:9",
    "output_format": "png",
    "seed": 4217
  }
}
```

Replicate answers with `status: "starting"` and an `id`. Then poll, because generation takes seconds:

```
GET https://api.replicate.com/v1/predictions/{id}
```

until `status` is `succeeded` (read `output`, a URL) or `failed` (record the error) or the poll budget runs out. Poll ceiling: 20 attempts, 2 second spacing, so 40 seconds per image, then a timeout refusal rather than a hung request.

The `fetchImpl` parameter is injected on both calls, which is what makes every test in this slice a mock. No automated test touches Replicate.

`negativePrompt` is accepted from the designer and **not** sent. FLUX 1.1 Pro has no negative prompt input. Sending an unknown field is how an adapter starts returning 400s nobody predicted. The field is stored in `raw_extract` so a future model that takes one can use the recorded value.

The aspect ratio set the adapter accepts is the set FLUX 1.1 Pro actually takes, held as a constant in `src/marketing/replicate.ts` rather than re-derived at runtime: `auto`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`. The designer's prompt guidance in §7 names the same list, so a media plan written for a vertical story ad and an asset pass that refuses to render it cannot coexist.

`seed` is a per-asset deterministic value derived from the bundle id and the asset name, so the same asset on the same bundle reproduces the same bytes and the sha256 dedup can catch it. A random seed would make §6's idempotency claim untestable.

`cost` comes back on the prediction response as a decimal USD string (for example `"0.04"`). The adapter converts it to integer minor units and refuses to run on a response where the field is absent, because a silently estimated ledger is the drift this slice is trying not to create.

### 5.2 Fetching the bytes

`output` is a URL on `replicate.delivery` that expires. The adapter downloads it immediately and hands the bytes to `insertDocument` as `PersistDocumentInput.file`, because the whole promise of "stored through `documents`" is that CRUM holds the asset. The download goes through the same `fetchImpl`.

### 5.3 Refusals and the one non-refusal, checked in this order

| Condition | Error code |
|---|---|
| No `CRUM_REPLICATE_API_TOKEN` | the adapter never registers, and the tool refuses at call time. Same pattern as slices 2 and 3 |
| Daily ceiling already reached before the first asset | `image_spend_ceiling_reached` |
| A prompt longer than 2000 characters | `prompt_too_long`. Replicate truncates silently, and a truncated prompt is a different image |
| `aspectRatio` not in the model's allowed set | `unsupported_aspect_ratio`, listing the valid set |
| Prediction `status: 'failed'` | `image_generation_failed`, with Replicate's error text |
| Poll budget exhausted | `image_generation_timeout` |
| Fetched bytes larger than `MAX_DOCUMENT_BYTES` | `asset_too_large`, checked after the download and before the insert. 15 MB, the same ceiling `src/mastra/workflows/document-intake.ts:22` puts on an upload: one number should govern how big a stored document may be, not one per entry point. The spend is still recorded, because Replicate already charged for the prediction |
| Bytes hash equals an existing `content_hash` for this tenant | not a refusal: no new row and no new spend. Return the existing `document_id` and mark it in the response as `deduplicated: true` |

### 5.4 Cost

FLUX 1.1 Pro bills per image, roughly $0.04 for a 1024px output, so the default ceiling of 2000 minor units is about 50 images a day. The tool records the cost Replicate reports in the prediction response rather than estimating, because an estimated spend ledger is how the ceiling drifts from reality without anyone noticing.

## 6. The `marketing.generate_assets` tool

Declared in `policy/tools.yaml`, added to `MUTATING_TOOL_IDS` in `src/mastra/processors/write-claim-guard.ts`, and added to `SPEC_TOOL_SURFACE`, the policy counts, and `docs/TECHNICAL_PLAN.md` section 4.6.2 **in the same commit**, which is the standing rule for any commit that moves the tool surface.

It is `marketing.generate_assets`, dot-separated and lowercase, because `src/governance/schema.ts:16` rejects a camelCase tool name as a boot failure.

**Auto-committed, not approval gated.** The tool writes `documents` rows and `marketing_image_spend` rows, both inside CRUM. Nothing outside CRUM learns anything. The reasoning is the same one that makes `marketing.save_bundle` auto-committed, and the risk score is low for the same reason: no external state changes, and the money is capped by the ledger rather than by a human reading a number.

**Arguments:**

```ts
{
  tenantId: string
  bundleId: string
  userRole: string
}
```

The tool takes a bundle id and reads the designer's asset array out of the stored `role = 'creative-designer', kind = 'script'` artifact row, parsing its `text_content` as JSON. It does **not** accept prompts as arguments. A tool that takes a free-form prompt from a model would let the primary agent write any image it liked, bypassing the designer whose prompts are recorded in the bundle the reviewer reads. Reading from the stored artifact is what keeps the reviewed thing and the paid-for thing the same thing, and it is why the shape of that JSON in §7 is a contract rather than a suggestion.

**Behaviour:**

1. Load the bundle. Refuse if `status` is `live` or `archived`, because spending on an asset set someone already shipped or discarded is not the job.
2. Read the designer artifact row. Refuse with `no_asset_prompts` if the bundle has none, and with `asset_prompts_unparsable` if its `text_content` is not JSON or its `assets` array is empty or holds an entry with no `prompt`. A bundle whose designer output arrived as prose instead of the §7 shape costs nothing and says so.
3. Check the ceiling. If today's recorded spend plus `CRUM_IMAGE_COST_MINOR_PER_IMAGE` times the number of assets exceeds the ceiling, refuse with `image_spend_ceiling_reached` before any money moves and open a `human_tasks` row. The refusal is a work item, per `migrations/0002_crum_spine.sql:185`.
4. For each asset, in order: re-check the ceiling, call Replicate, hash the bytes, insert or reuse the `documents` row, record the spend.
5. Attach each `document_id` to the bundle through the existing exported `insertMarketingArtifacts` (`src/db/marketing.ts:346`), which already derives the content-addressed id with `artifactIdFor` and writes `ON CONFLICT (id) DO NOTHING`. That function is the whole attach path, so slice 4 adds no second one and a re-run is silent by construction rather than by a check the new code has to remember.
6. Recompute the site hash only if an image changed a published file's bytes. Images attach as separate artifacts, so for a media-only campaign the site hash does not move, and the test proves it does not.
7. Return the list of `{ name, documentId, status, deduplicated, costMinor }` and the total spent.

**Idempotency:** running the tool twice on the same bundle must not pay twice. The sha256 dedup catches a byte-identical regeneration; the `seed` recorded in `raw_extract` and reused from an existing row is what makes the bytes identical the second time. A bundle that already carries all its assets returns the existing list and spends nothing.

### 6.1 The review gate is new, not inherited

The `needs_review` status does not protect anything yet. `assertDocumentsVisible` (`src/mastra/tools/marketing-writes.ts:100`) is the only place the marketing path touches `documents`, and it checks that the id exists in the tenant and nothing more: no read of `documents.status` appears anywhere in `src/marketing/`, `src/db/marketing.ts` or `marketing-writes.ts`. Saying "a bundle cannot carry an unreviewed image" without building that check would be exactly the kind of claim this repository has already been burned by.

So slice 4 adds it, at staging rather than at attaching, and the placement is the whole design:

- `marketing.generate_assets` attaches its own fresh images through `insertMarketingArtifacts` and is the only writer allowed to attach a document that is not `ready`. Refusing there would make the tool unable to attach what it just paid for.
- `marketing.stage_bundle` refuses a bundle carrying an `image` artifact whose document `status` is not `ready`, naming each unreviewed asset title in the refusal. Staging is the last gate before a human can approve, so it is where an unreviewed face becomes somebody's responsibility. The console shows the refusal text on the stage door it already renders.
- The flip itself is not new work. `POST /api/documents/:id/review` and `reviewDocument` (`src/db/documents.ts:524`) were built for invoices in the document intake slice and take a status transition, so a generated image is reviewable the moment it exists. Slice 4 links to that screen from the bundle; it does not rebuild it.

One test per bullet, and the middle one is the load-bearing case: stage a bundle with one `ready` and one `needs_review` image and assert the refusal names the second by title.

## 7. The creative-designer agent

The instruction at `src/mastra/agents/creative-designer.ts:11` currently says "In this build you have no image generation tool, so a prompt is the deliverable and it must be complete enough to run unedited later."

That sentence stays. The designer keeps `tools: {}` and still returns prompts, because the rule is that a subagent cannot act. The instruction gains one sentence naming what happens downstream so the agent can write prompts that survive being machine-executed rather than hand-run:

> "Those prompts are executed by an asset pass outside your control, one call per asset, so a prompt that needs two edits to work is a wasted payment. Keep `aspectRatio` inside the values the model supports and keep any prompt under 2000 characters."

The prompt length limit and the aspect ratio set become real because they cost money, which is the argument for stating them in the instruction instead of trusting a validator to catch them later.

### 7.2 The primary agent has to be told, which it currently is not

`src/mastra/instructions.ts` never says the words marketing, bundle or designer. The five marketing tools reach the assistant through their own descriptions and nothing else, which was survivable while the team only produced text a human could read off the screen. It is not survivable now: the asset pass reads a stored artifact row, and if the primary agent does not know that the designer's JSON must be handed to `save_bundle` as a `creative-designer` / `script` artifact, the row will usually not exist, `marketing.generate_assets` will refuse with `no_asset_prompts`, and the owner will read a refusal for a feature they can see in the menu.

So `CRUM_INSTRUCTIONS` gains one short marketing paragraph, written as a contract rather than a suggestion:

> When a campaign needs creative, delegate to `creative-designer` and pass its JSON object to `marketing.save_bundle` as one artifact with role `creative-designer`, kind `script`, and its full text in `textContent`. That stored prompt set is the only thing `marketing.generate_assets` will spend money on, so a bundle without it cannot have images.

`tests/mastra/marketing-agents.test.ts:25` already asserts substrings of the designer instruction, so the same style of assertion lands on the primary instruction, and the golden dataset gains one item that must produce a designer artifact. This is the half of the slice that makes the other half reachable in the running app rather than only in the tests.

## 8. The cognitive forcing gate

### 8.1 Where it sits

The gate belongs on the bundle screen, not the approval queue, and the split is deliberate. The approval queue shows the staged payload, which by spec section 7 is identifiers and a hash and numbers. There is nothing in it to predict. The bundle screen is where the copy and the images are readable, and reading is the thing being forced.

`console/components/MarketingBundleView.tsx` gains the gate. The five role sections, the rendered page HTML, the campaign table and the two go-live doors all live behind it.

### 8.2 The flow

1. The screen loads the bundle response, which gains two fields: `predictionRequired: boolean` (does this bundle have an open stage draft, per §4.3's predicate) and `prediction: { id, pendingWriteId, predictedOutcome, createdAt } | null`.
2. `predictionRequired` true and `prediction` null: the screen renders **only** a heading, one textarea, and one Button labelled "Record prediction and open bundle". There is nothing else to render, because the route already removed it. The test still asserts the copy is absent from the document rather than merely hidden, because a hidden node is still a node devtools reads, and the device is only honest if the reviewer genuinely has not seen the proposal.
3. Submitting POSTs `/api/marketing/bundles/:id/prediction` with `{ predictedOutcome }`, refetches, and renders the bundle.
4. `predictionRequired` false, or a prediction present: the screen renders the bundle exactly as slices 1 to 3 made it, with the prediction shown as a fixed line at the top in the reviewer's own words when one exists, so the eventual comparison has a visible anchor.

The copy leaves the response, not just the screen. For a bundle whose stage draft is open and undecided and which has no prediction, `GET /api/marketing/bundles/:id` returns the identity fields, the status fields and the dates and drops the prose: `strategy`, `copy`, `mediaPlan`, `funnelPlan`, `analysis`, `audienceNote` and the whole `artifacts` array. `brief` stays, because the owner wrote it and it is what tells them which bundle they are looking at. Its response today is `{ bundle, artifacts, actions }` (`src/api/marketing.ts:76`), and the test asserts those keys are absent from the JSON, not null.

The bytes route from §3 is gated by the same predicate: `GET /api/marketing/assets/:documentId/bytes` refuses with `prediction_required` when the asset's bundle has an open, undecided stage draft and no prediction. An image is the most persuasive half of a proposal and the easiest to rubber-stamp past, so leaving it ungated would let a reviewer skip the textarea and look at the picture.

### 8.3 The API surface

`GET /api/marketing/bundles/:id` gains `predictionRequired` and `prediction` on the response and, for a gated bundle with no prediction, drops the copy-bearing fields. Its response today is `{ bundle, artifacts, actions }` (`src/api/marketing.ts:76`), so the drop is `artifacts` plus the six `plan_*` columns on `bundle`, and the test asserts those keys are absent, not null.

`POST /api/marketing/bundles/:id/prediction` is new:

```ts
// request
{ predictedOutcome: string }
// 200
{ prediction: { id, pendingWriteId, predictedOutcome, createdAt } }
```

Refusals: `prediction_required_text` on an empty or whitespace string, `prediction_exists` on a second attempt (the unique constraint), `prediction_bundle_not_staged` when §4.3's predicate finds no open stage draft. Authenticated and tenant-scoped, the same way the sibling GET route is.

`GET /api/marketing/assets/:documentId/bytes` is new: authenticated, tenant-scoped, returns `document_files.data` with the row's `mime` and a `Cache-Control: private, max-age=3600`, refuses any document whose `kind` is not `marketing_asset` with 404 rather than 403 so the route cannot be used to probe which invoices exist, and refuses with `prediction_required` while the owning bundle is gated.

### 8.4 What it does not do

It does not validate the prediction. A reviewer who types `no idea` has typed a prediction, and the row is written. The device works by making the reviewer commit before looking, not by grading the commit, and a validator that rejected unconfident answers would teach the reviewer to type a plausible number instead of an honest one.

## 9. Error handling

| Failure | Handling |
|---|---|
| Replicate 401, token revoked mid-day | every remaining asset in the run stops at the first 401 rather than 40 more calls against a dead token. The spend ledger keeps what was actually paid. A `human_tasks` row names the token as the cause |
| Replicate 429, rate limited | retry once after 5 seconds, then treat that asset as failed and continue. A rate limit on one image must not lose the images already made |
| A single asset fails | the run returns partial success. The bundle carries the images that worked. Nothing is rolled back, because a paid-for image that is not stored is money spent for nothing |
| Bytes download fails after a successful prediction | the spend is recorded with `document_id` null and the prediction id in `raw_extract`, so the owner can re-fetch from Replicate within its expiry window. This is the case the nullable `document_id` exists for |
| Ceiling crossed mid-run | stop at the boundary, return partial success, name the first asset that would not fit |
| Database rejects a `documents` insert | the spend row still commits. The two inserts are deliberately in separate transactions. An invoice for an image we failed to save is a real cost and must show up |
| Prediction POST races with itself | the unique constraint rejects the second write, and the route returns the existing prediction with 200 rather than an error, because the reviewer's outcome is identical either way |
| Image bytes exceed `MAX_DOCUMENT_BYTES` | refuse before insert with `asset_too_large`. Storing a runaway blob in Postgres is not a marketing decision, and the upload lane already says how big that blob may be |

## 10. Testing

No automated test calls Replicate, calls a model, or hits a real domain. `fetchImpl` is injected everywhere, matching slices 2 and 3.

**Unit:** `tests/marketing/replicate.test.ts` covers the create-then-poll sequence, `succeeded`, `failed`, timeout, the 401 early stop, the 429 retry once then continue, prompt length refusal, aspect ratio refusal, and that `negativePrompt` is stored and never sent.

`tests/marketing/image-spend.test.ts` covers the ceiling arithmetic at the boundary: spend exactly to the ceiling and pass, exceed by one minor unit and refuse, a run that crosses mid-loop stops at the boundary and returns partial success.

`tests/db/marketing-assets.test.ts` covers the sha256 dedup returning the existing id with no new spend, the `document_files` round-trip for an image with no parse row, which is the §4.1 hoist and the case that currently loses bytes silently, the guard that a `marketing_asset` row is never enqueued for intake, and that `listDocuments` omits `marketing_asset` rows when no `kind` filter is given and still returns them when asked for one.

`tests/marketing/generate-assets-tool.test.ts` covers the tool refusing on `live` and `archived` bundles, refusing with `no_asset_prompts` when the designer artifact row is absent, refusing with `asset_prompts_unparsable` on prose instead of JSON, reading prompts from the stored artifact rather than its arguments, and idempotency on a second run.

`tests/mastra/marketing-write-tools.test.ts` covers §6.1: staging a bundle whose images are all `ready` succeeds, staging one with a single `needs_review` image refuses and names that asset's title, and `marketing.generate_assets` attaching a fresh `needs_review` image is not itself refused. A third case proves the flip is the existing one: after `reviewDocument` returns, the same stage call that refused now passes.

**Governance:** `tests/governance/marketing-payload.test.ts` gains the prose hygiene case for the new tool, and `tests/governance/conformance.test.ts` and `tests/governance/policy.test.ts` counts move in the same commit as the tool. `tests/mastra/marketing-agents.test.ts` gains the assertion that `CRUM_INSTRUCTIONS` names the designer artifact contract, and `src/evals/golden-items.ts` gains one item that must produce it.

**API:** `tests/api/marketing-prediction.test.ts` covers the empty string refusal, the duplicate refusal returning the existing row, the not-staged refusal, and the tenant isolation case where tenant B cannot write a prediction on tenant A's draft.

`tests/api/marketing.test.ts` gains the assertion that a gated bundle with no prediction does **not** carry the copy fields or `artifacts` in the GET response and does carry `predictionRequired: true`, that after a prediction it carries them, and that a `draft` bundle with no open stage draft carries them with `predictionRequired: false`. That last case is the one that proves the gate does not lock an author out of their own bundle.

`tests/api/marketing-asset-bytes.test.ts` is new: the bytes route serves a `marketing_asset`, 404s an invoice, 401s without a token, refuses another tenant's document, and refuses with `prediction_required` while the owning bundle is gated.

**Console:** `console/tests/MarketingBundleView.test.tsx` covers the gate: with `predictionRequired` true and no prediction the textarea renders and the copy is absent from the document, submitting posts and refetches, with a prediction the bundle renders and the prediction shows at the top, and with `predictionRequired` false the bundle renders immediately.

**Migration:** `tests/integration/marketing-assets-migration.test.ts` applies the migrations and asserts both widened CHECK constraints admit `marketing_asset` and `generated` while still rejecting `'quote'`, that an existing invoice row is untouched by the re-added constraint, that the partial index exists, that `marketing_image_spend` accepts a null `document_id`, and that `reviewer_predictions` rejects a second row for the same `pending_write_id`.

**Integration:** `tests/integration/marketing-generate-assets.test.ts` runs the tool end to end against a mocked Replicate and asserts the `documents` and `document_files` rows, the spend rows, artifact attachment with a content-addressed id, the `MAX_DOCUMENT_BYTES` `asset_too_large` refusal, and that a re-run spends nothing.

## 11. Non-goals

| Excluded | Reason |
|---|---|
| Video and audio generation | Images cover what the funnel and ad copy need. Video is a separate provider shape with a polling profile long enough to want a queue |
| A tool on any subagent | The rule is the rule. The designer stays `tools: {}` and the payment stays in code |
| Auto-flipping `needs_review` to `ready` | A generated face with six fingers must meet a human before it goes on their domain |
| Grading the reviewer's accuracy | Slice 4 stores the prediction and records metrics; the report joining them is a later slice |
| Gating the promote, retry and campaign-status drafts | §4.3 attaches the device to the one draft that decides whether a campaign exists. The other three are the same device on three later decisions, and each needs its own wording of what a prediction means there |
| Serving asset bytes through `GET /api/documents/:id` | That route returns extracted metadata for an invoice, and it has a live consumer in the bundle screen already. A separate marketing-scoped route keeps a public-shape change off the CRM read path, and §8.3's kind check is what stops it being aimed at a bill |
| A second image provider behind a common interface | One adapter, one provider, with `provider` as a column so the second one is additive rather than a refactor |
| Budget management in Meta | Slice 3 deliberately created campaigns paused and read the ceiling without writing it. That stays |
| Background job queue for asset generation | A synchronous loop under a 40 second poll ceiling per image is honest at this scale. A queue is what you build when an owner generates forty assets in a sitting |

## 12. Where the code lands

| Kind | Path | Responsibility |
|---|---|---|
| Migration | `migrations/0021_crum_marketing_assets.sql` (new) | widen two CHECK constraints, add one partial index, add `marketing_image_spend` and `reviewer_predictions`. No new column on `documents` |
| Provider | `src/marketing/replicate.ts` (new) | create and poll a prediction, download the bytes |
| Spend | `src/marketing/image-spend.ts` (new) | the ceiling ledger and its arithmetic |
| Data | `src/db/documents.ts` (modify) | widen the `kind` and `source` unions in `PersistDocumentInput`, hoist the `document_files` write out of the parse guard, exclude `marketing_asset` from `listDocuments` unless asked for |
| Data | `src/db/marketing-assets.ts` (new) | insert one generated image through `insertDocument`, look one up by content hash, read its bytes from `document_files`, and read the designer artifact row's asset array |
| Data | `src/db/pending-writes.ts` (modify) | `getOpenStageDraft(tenantId, bundleId)`, the §4.3 predicate no other caller has |
| Data | `src/db/reviewer-predictions.ts` (new) | one prediction per staged draft |
| Tool | `src/mastra/tools/marketing-writes.ts` (modify) | `marketing.generate_assets`, and §6.1's unreviewed-image refusal on `marketing.stage_bundle` |
| Agent | `src/mastra/agents/creative-designer.ts` (modify) | one sentence on machine-executed prompts |
| Agent | `src/mastra/instructions.ts` (modify) | the §7.2 paragraph naming the designer artifact contract |
| Governance | `policy/tools.yaml` (modify) | the new tool declared, `scope: marketing:assets`, `class: auto` |
| Guard | `src/mastra/processors/write-claim-guard.ts` (modify) | the new tool id in `MUTATING_TOOL_IDS` |
| Guard | `src/api/documents.ts` (modify) | refuse to run intake on a `marketing_asset` document |
| Boot | `src/mastra/index.ts` (modify) | register the Replicate adapter only when the token is present |
| HTTP | `src/api/marketing.ts` (modify) | the prediction POST, the asset bytes GET, and the bundle GET that withholds copy until a prediction exists |
| Config | `src/config/env.ts` (modify) | four new vars, and the token added to `PRODUCTION_REQUIRED_SECRETS` |
| Console | `console/components/MarketingBundleView.tsx` (modify) | the gate, and the image inline where an `image` artifact already links a bare id |
| Console | `console/lib/types.ts` (modify) | `ReviewerPrediction`, `predictionRequired` and `prediction` on the bundle response |

## 13. Delivery slices

| Sub-slice | Ships | Makes real | Gate |
|---|---|---|---|
| 4a | Migration 0021, the `insertDocument` byte hoist, the Replicate adapter, the spend ledger, `marketing.generate_assets`, the designer and primary-agent instructions, the asset attachment path, the unreviewed-image stage refusal | Original creative inside the bundle instead of prompts on a page | `CRUM_REPLICATE_API_TOKEN` required, and a daily ceiling number |
| 4b | `reviewer_predictions`, `getOpenStageDraft`, the prediction POST, the GET that withholds copy, the asset bytes route, the console gate | A reviewer who committed to a number before looking, and the images that number was about | Nothing external. This half ships without a token |

4b has no external dependency and 4a costs money, so a first pass can build 4b and close the tiger T1 gap while the image key is still being decided. The two halves still share no table and no component, and one deliberate exception to the clean split is worth naming rather than discovering later: **the asset bytes route belongs to 4b, not 4a**, because a route whose first act is to check `reviewer_predictions` cannot ship before that table has a writer. 4a therefore stores images nobody can see yet, and 4b is what makes them appear. The dependency runs 4a → 4b for display only, never for storage, so reverting 4b returns the console to slices 1 to 3 and leaves every paid-for image safely in the database.

## 14. Open questions for the owner

| Question | Why it matters | Default if unanswered |
|---|---|---|
| Which Replicate model | FLUX 1.1 Pro is about $0.04 an image. SDXL is about $0.005. The ceiling means different things in each | `black-forest-labs/flux-1.1-pro` |
| The daily ceiling number | 2000 minor units is about 50 FLUX images. Too high and a bad afternoon costs real money, too low and a campaign cannot finish its assets | 2000 |
| Whether the token goes into `PRODUCTION_REQUIRED_SECRETS` | The parent spec's tiger T2 note says the injection guard fails open when an expected key is absent, and a designer reading prospect copy is exactly where a stray prompt could end up on a bill | Yes, required in production |

`CRUM_REPLICATE_API_TOKEN`, `CRUM_REPLICATE_MODEL`, `CRUM_IMAGE_SPEND_CEILING_MINOR` and `CRUM_IMAGE_COST_MINOR_PER_IMAGE` are recorded here and not written to `.env.example`, because that file still carries another effort's uncommitted edit and staging it would sweep their lines into a marketing commit. The four defaults are usable, so a missing `.env.example` line costs a reader one grep of `src/config/env.ts` rather than a failed boot.

Two of §14's three questions collapse into one if the owner stays quiet, and both defaults are conservative: FLUX 1.1 Pro and a $20 ceiling. The one that cannot be defaulted away without risk is the token, and its default is to require it in production.
