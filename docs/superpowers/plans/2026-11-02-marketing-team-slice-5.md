# CRUM Marketing Team, Slice 5 (Generated Images Reach the Page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a generated image on the published page, and close the five other slice-4 residuals and the two whole-branch review items: an asset change kills the open approval, two spend ceilings instead of one, a named image-provider registry with no silent fallback, `marketing_asset` documents that are browsable, and `marketing.set_campaign_status` that is reachable from chat and committable on approval.

**Architecture:** One rule holds the design together: the bytes a reviewer approved are the bytes that go live. `src/marketing/site.ts` stays the only place a hosted path is decided, and it grows from two text slots to a byte lane, so `SiteFile.content` becomes `Uint8Array` and a page's `{{ASSET:name}}` placeholders are substituted *before* the hash is taken rather than after it, as the pixel snippet is. Four sites compute the site hash and all four move to one loader (`loadSiteArtifacts`) in the same chunk, because two resolutions of one page is exactly the drift the invalidation task exists to catch. Everything else is arithmetic (a second ceiling, joined on a new `bundle_id` column) or wiring (a registry, a tool, an `applyDraft` branch).

**Tech Stack:** TypeScript 5.9.3 ESM, Node 22.18, `@mastra/core` 1.79 (`createTool`), Hono 4.13, `pg` 8.23 against PostgreSQL 17, Zod 4.6, Vitest 3.2 with two inline projects (`unit`, `integration`), Next.js 15 / React 19 console with its own Vitest + Testing Library setup, `tsx` for scripts. No new npm dependency in this slice.

**Spec:** `docs/superpowers/specs/2026-11-02-marketing-team-slice-5-design.md`, committed at `976a7e9`. Read section 2 before touching any hash code, section 5 before touching `site.ts`, section 6 before touching `pending_writes`, section 7 before touching the ceiling, section 9 before touching `applyDraft`, and section 11.2 before touching the guard list.

## Global constraints

- **The hash invariant is the requirement, not the implementation detail.** An asset URL must be inside the hashed bytes. Reusing the pixel-injection shape (resolve after the hash check) is explicitly refused by spec section 2, and a task that does it has failed even if every test passes.
- **Every site that computes a site hash moves to the one loader in Task 5, in the same chunk.** They are `marketing.stage_bundle` (`src/mastra/tools/marketing-writes.ts:428`), `siteHashInTransaction` (`src/db/marketing.ts:306`), `commitBundleApproval` (`src/marketing/outbox.ts:244`), and `readSiteFiles` (`src/marketing/page-host.ts:112`). Leaving one behind means two resolutions of one page.
- **`sha256` is the hash of exactly the bytes that are uploaded, and a text-only site's hash does not change.** `createHash('sha256').update(str)` already hashes UTF-8, so `content: string` becoming `content: Uint8Array` must not move one value. Task 1 asserts a known text-only site hash before and after. This is load-bearing: slice 2, 3 and 4 fixtures and the promote/retry payloads carry hashes computed under the old shape.
- **`SiteArtifact`'s new fields are optional.** Existing fixtures build `{ id, kind, textContent }` in nine test files. Optional fields keep them compiling; the loader fills them in production.
- **No automated test calls Replicate, a model, a real domain, or Cloudflare.** `fetchImpl` is injected. The only real provider calls in this slice are the manual walkthrough's (Task 19).
- **`CRUM_REPLICATE_API_TOKEN` is owner-supplied and is never written to any file, commit, log or report.**
- **Money is capped by the ledger, and now by two ceilings checked in a fixed order: bundle first, then tenant day** (spec section 7.2). A bundle refusal must not also fire a day refusal, and both tokens (`image_bundle_ceiling_reached`, `image_spend_ceiling_reached`) are distinct and both appear in the run's refusal list.
- **No automatic fallback between image providers.** A registered provider that fails gets its own error, its one spend row, and no second provider charged. This is the ruling (option A) and it is a requirement, not a preference: Task 10's no-fallback test is what proves it.
- **Invalidation is hard.** A moved asset rejects the open draft and returns the bundle to `draft`. There is no stale-but-approvable state, no re-hash in place (spec section 6.1: a prediction written against old bytes is a statement about a proposal that no longer exists).
- **`reviewer_predictions` is keyed `UNIQUE (pending_write_id)`**, so a re-staged bundle starts with no prediction. Nothing in this slice writes a prediction automatically.
- **No new table and no new byte store.** One migration (`0022`) adds one nullable column and one index. Image bytes stay in `document_files.data`, which has held them since `migrations/0011_crum_document_parse.sql:27`.
- **The `?kind=` door opens one step at a time.** `marketing_asset` is admitted to the whitelist and asked for explicitly; a list with no `kind` keeps excluding assets, so nobody's invoice view fills up with PNGs.
- **Tool names satisfy `src/governance/schema.ts:16`.** `marketing.set_campaign_status` is already declared in `policy/tools.yaml:281` with `class: approval`, so R6 adds no policy row, no `SPEC_TOOL_SURFACE` row, and no governance count change. It adds one registry key and moves the count in `tests/mastra/agent.test.ts:50-53` from 41 to 42.
- **`resolveActiveTools` (`src/mastra/active-tools.ts:10`) is derived from the policy and never consults the registry,** so the admin's active list is already 42 and the user's 29. Both stay exactly as they are. R6 makes the registry match the promise the agent has been given since slice 3, and moves nothing.
- **Line numbers in this plan are read off `feat/marketing-slice-5` at writing time (HEAD `976a7e9`); the named anchor is the instruction.** Tasks after Task 3 append to files that other tasks also touch. `grep -n` for the quoted code, insert beside what you find, and say so in your report if the number and the file disagree. A number is a hint; the quoted line is the requirement.
- **Run Vitest with explicit file paths, never a bare `--project unit` and never `npm test`.** `tests/evals/golden-gate.test.ts` lives inside the unit project and calls the owner's paid live model; an unfiltered run spends roughly twelve model-minutes of their API credit. `npx vitest run tests/marketing/site.test.ts` is the safe form, `npx vitest run --project unit` is not.
- **`npm run verify` exits non-zero in this repository by design** (the golden gate is red at baseline: fixture errors and gate-scorer violations that predate this slice). Never report it as green and never describe it as "all tests pass". This plan's gate is `npm run typecheck`, `npm run lint`, the named test files, and one filtered integration run per task that owns one. Task 19 compares the final full-suite shape against the recorded baseline and reports it without hiding it.
- **A skipped integration test is never reported as a pass.** `describe.skipIf(!url)` means an unset `CRUM_INTEGRATION_DATABASE_URL` skips silently; a report that says "integration tests pass" without naming which files ran is not evidence.
- **Never `git add -A`, `git add .` or `git commit -a`.** Name every path. `docs/` and `src/evals/` are matched by `.gitignore` while the files inside them are tracked, so a plain `git add` on an ignored-but-tracked path exits 1 and a chained `git add … && git commit …` never reaches the commit. New files under those paths need `git add -f`, and `git commit -m "…" -- <path>` puts `-m` before the `--`.
- **Do not stage `.env.example`, `src/mastra/memory.ts`, `src/mastra/recall.ts`, `tests/mastra/memory.test.ts` or `tests/mastra/recall.test.ts`** unless the task you are executing owns that path. Check `git status --porcelain -- <path>` first; another effort's work must stay unstaged.
- **Code style matches the repo:** single quotes, no semicolons, two-space indent, `export const` for tools, no `any` (ESLint `@typescript-eslint/no-unsafe-*` is on). Every new file opens with a comment saying why it exists, in the voice of `migrations/0018_crum_marketing.sql`. Every refusal a data module can express is a sentence a human can act on, not a bare token.
- **Report documents avoid dashes, semicolons and divider lines.** This applies to the verification report Task 19 writes.
- Each task ends with its own named test command green and one commit.

## Six spec refinements, decided here rather than mid-task

The spec is the authority on intent. These six points were checked against the code and do not survive contact with it, so the plan records the correction once, up front, and every later task follows it.

**1. `run.side-effect` belongs in RV2's backlog set, not only `crm.bulk_import`.** Spec section 11.2's third assertion expects the declared-but-unregistered set to equal `{crm.bulk_import}`. It is `{crm.bulk_import, run.side-effect}`: both are declared non-read-only in `policy/tools.yaml`, and neither is a key of `crumToolRegistry`. The spec's own reasoning (a gap that is named in a test stays a known hole) is right, only its set was one name short. Task 18 asserts both, with a sentence beside each.

**2. The generated-asset surface is a new component, not a third `kind` on `DocumentManager`.** `console/components/DocumentManager.tsx` is `{ kind: 'invoice' | 'contract' }` in 342 lines, and all of it is intake-shaped: it uploads a multipart file into the document workflow, fetches an invoice or contract detail beside the document, and its review button (`:127`) is the only part worth keeping. Task 13 writes `console/components/AssetManager.tsx` and mounts it as a fourth tab in `console/app/knowledge/page.tsx`, which already hosts the three tabs. The console's Vitest tests live in `console/tests/`, not beside the components, and reuse `console/tests/fetchStub.ts`.

**3. `marketing.set_campaign_status` is the 42nd registry key, not the 41st.** The registry holds 41 today (`src/mastra/agent.ts:48-90`), and `tests/mastra/agent.test.ts:50-53` asserts 41. Task 17 makes it 42, which is the number the agent has been told it could call since slice 3. The spec was amended at `976a7e9` to match.

**4. Pixel injection recomputes `sha256`, and its post-hash deviation stays.** Today `injectPixelIntoFiles` returns `{ ...file, content: injectPixel(...) }` and leaves `file.sha256` describing the pre-injection bytes, so `buildUploadForm`'s manifest names a hash that the uploaded blob does not have. Task 1 recomputes it, because after Task 1 the same manifest entry also has to describe PNG bytes and a per-part content type, and a manifest is the one place a hash must be true. This does not weaken the approval invariant: `readSiteFiles` checks the approved hash *before* injection, and the payload, the receipt and every existing fixture still carry the pre-pixel hash. Task 1's test asserts both halves, that the injected file's hash equals the hash of the injected bytes and that `siteHashOf` over the injected files differs from the approved hash, which is the documented deviation and not a bug this slice fixes.

**5. `loadSiteArtifacts` takes three arguments, not the spec's four.** Spec section 5.4 opens with `loadSiteArtifacts(tenantId, bundleId, slug)` and closes the same section saying the loader "takes the caller's queryable as an optional fourth parameter". A slug is not part of reading a bundle's artifacts: the loader's second read selects bytes for document ids the placeholder scan found in page text, and the scan does not need the slug to do it. Task 4 implements `loadSiteArtifacts(tenantId: string, bundleId: string, client?: Queryable)`, the optional client being the half the section needs for the approval's `FOR UPDATE` lock, and Tasks 5, 6 and 7 call it with two arguments where there is no transaction and three where there is.

**6. The widened `kind` union is the console's view type, not the intake result.** Spec section 10.1 says the view type at `src/api/documents.ts:30` widens to match the new `?kind=` admission. Line 30 is `IntakeResult.kind` (`'invoice' | 'contract' | 'other'`), which describes the response of the upload path, and slice 4 closed that path to a generated asset, so widening it would describe a door that no longer opens. The type that actually needs `marketing_asset` is the console's `CrumDocument.kind` at `console/lib/types.ts:139`, because that is the shape the new tab renders. Task 13 widens `:139` and leaves `:30` narrow, and the `?kind=` whitelist at `src/api/documents.ts:187-190` is the only REST change.

## Integration cluster

Every integration step runs against the throwaway Postgres the slice 2, 3 and 4 walkthroughs left on port 5455, data directory `D:/pgdata-crum-slice1`. If it is gone, recreate it:

```bash
"/c/Program Files/PostgreSQL/17/bin/initdb.exe" -D "D:/pgdata-crum-slice1" -U crum_test --auth=trust
"/c/Program Files/PostgreSQL/17/bin/pg_ctl.exe" -D "D:/pgdata-crum-slice1" -o "-p 5455" -l "D:/pgdata-crum-slice1/log" start
"/c/Program Files/PostgreSQL/17/bin/createdb.exe" -h localhost -p 5455 -U crum_test crum_slice5
```

Then export once per shell, and say in your report whether you did:

```bash
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
```

Tests that need migrations applied call `migrate` from `scripts/db-migrate.ts` inside `beforeAll`, the pattern `tests/integration/marketing-publish.test.ts:16,57` already uses. A new `0022_*.sql` needs no registration: `scripts/db-migrate.ts:20` picks it up on the `^(\d{4})_crum_[a-z0-9_]+\.sql$` match.

## File structure

| Chunk | Kind | Path | Responsibility |
|---|---|---|---|
| S5a | Pure | `src/marketing/site.ts` (modify) | `SiteFile` carries `Uint8Array` and `contentType`; placeholder grammar; `siteProblem`; `AssetProblemError`; image paths; the three ceilings |
| S5a | Data | `src/db/marketing-assets.ts` (modify) | `loadSiteArtifacts` (the one loader) and `getAssetBytesByIds`, bytes read only for names a page references |
| S5a | Publish | `src/marketing/pixel-injection.ts` (modify) | decode, inject, re-encode, recompute the hash, never touch a non-html path |
| S5a | Publish | `src/marketing/page-host.ts` (modify) | per-part content type in `buildUploadForm`; `readSiteFiles` through the loader |
| S5a | Approval | `src/marketing/outbox.ts` (modify) | enriched artifacts at approval, `AssetProblemError` translated to `BundleNotApprovableError` |
| S5a | Approval | `src/db/marketing.ts` (modify) | `siteHashInTransaction` through the loader |
| S5a | Tool | `src/mastra/tools/marketing-writes.ts` (modify) | stage refuses on `siteProblem`; reports `assetsUnreferenced` |
| S5b | Migration | `migrations/0022_crum_marketing_assets_reachable.sql` (new) | `bundle_id uuid` on `marketing_image_spend`, one index, no backfill |
| S5b | Spend | `src/marketing/image-spend.ts` (modify) | `bundleId` on the row; `committedBundleSpendMinor` |
| S5b | Provider | `src/marketing/image-provider.ts` (modify) | named registry, `selectImageAdapter`, no singleton, no fallback |
| S5b | Config | `src/config/env.ts` (modify) | `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE`, `CRUM_IMAGE_PROVIDER` |
| S5b | Boot | `src/mastra/index.ts` (modify) | register the Replicate adapter into the registry |
| S5c | Data | `src/db/pending-writes.ts` (modify) | `invalidateOpenStageDraft`, and the `marketing_set_campaign_status` branch in `applyDraft` |
| S5c | Tool | `src/mastra/tools/marketing-writes.ts` (modify) | the three invalidation call sites |
| S5c | API | `src/api/documents.ts`, `src/db/documents.ts` (modify) | the review route invalidates; `reviewDocument` returns `kind` |
| S5d | API | `src/api/documents.ts` (modify) | `?kind=` admits `marketing_asset` |
| S5d | Console | `console/components/AssetManager.tsx` (new) | the generated-asset list, thumbnails through the gate, the review flip |
| S5d | Console | `console/app/knowledge/page.tsx` (modify) | the fourth tab |
| S5d | Data | `src/db/timestamps.ts` (new) | `toIsoString`, the one normaliser, and the crash on a value that is neither |
| S5d | Governance | `src/mastra/processors/write-claim-guard.ts` (modify) | four prospect-lane ids join the list |
| S5d | Governance | `src/mastra/agent.ts` (modify) | `crumToolRegistry` gains `marketing.set_campaign_status` and is exported |
| S5d | Tool | `src/mastra/tools/marketing-writes.ts` (modify) | uuid fixes in `stageCampaignStatusChange`; `setCampaignStatusTool` |
| S5d | Script | `scripts/analyst-cron.ts` (modify) | `CRUM_ANALYST_USER_ID`, skip-with-log when unset |
| S5d | Report | `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md` (new) | what ran, what the baseline says, what the walkthrough saw |

## Task index

**S5a, the byte lane (R1).** Tasks 1 to 7. The largest and the riskiest, and it lands first because R2's invalidation is only worth having once a moved asset changes a hash.

**S5b, the ceilings and the registry (R3, R4).** Tasks 8 to 10. Independent of S5a.

**S5c, invalidation (R2).** Tasks 11 and 12. Needs S5a, because a moved asset must be able to move a hash.

**S5d, the browse surface, reachability and the review items (R5, R6, RV1, RV2).** Tasks 13 to 18, then Task 19 proves the slice. RV2's derivation runs last, against the registry R6 has just widened.

| # | Task | Chunk |
|---|---|---|
| 1 | `SiteFile` carries bytes, a content type, and a true hash | S5a |
| 2 | The placeholder grammar and the name scan | S5a |
| 3 | Assets inside `resolveSite`: the problem list, the error, the paths, the ceilings | S5a |
| 4 | `loadSiteArtifacts`: the one loader that reads bytes | S5a |
| 5 | All four hash sites go through the loader | S5a |
| 6 | `marketing.stage_bundle` refuses an unresolvable page and reports the dead pictures | S5a |
| 7 | Integration proof 1: the picture is on the page the host received | S5a |
| 8 | Migration 0022 and the bundle's side of the ledger | S5b |
| 9 | The per-bundle ceiling, checked before the day ceiling | S5b |
| 10 | A named image-provider registry, selected by config, with no fallback | S5b |
| 11 | `invalidateOpenStageDraft` | S5c |
| 12 | The three places an asset moves | S5c |
| 13 | `marketing_asset` documents become browsable, through the gate | S5d |
| 14 | `toIsoString`: the timestamp a row mapper tells the truth about | S5d |
| 15 | `stageCampaignStatusChange` writes uuids, and the cron names a user | S5d |
| 16 | The `applyDraft` branch that makes an approval mean something | S5d |
| 17 | `marketing.set_campaign_status` joins the registry | S5d |
| 18 | The guard list is derived, and finds four missing tools | S5d |
| 19 | Prove the slice, walk it once with a real picture, and write it down | S5d |

---

## S5a. The byte lane (R1)

### Task 1: `SiteFile` carries bytes, a content type, and a true hash

The refactor that makes every later R1 task possible. `SiteFile.content` goes from `string` to `Uint8Array`, `contentType` arrives, and the upload labels each part with it instead of calling a PNG `text/html`. A text-only site's `sha256` must not move by one value, because slice 2, 3 and 4 fixtures, promote payloads and retry payloads all carry hashes computed under the old shape.

**Files:**
- Modify: `src/marketing/site.ts:33-37` (`SiteFile`), `:123-138` (`resolveSite`)
- Modify: `src/marketing/pixel-injection.ts:6` (imports), `:68-82` (`injectPixelIntoFiles`)
- Modify: `src/marketing/page-host.ts:46-57` (`buildUploadForm`)
- Modify: `tests/marketing/pixel-injection.test.ts:17-19`, `:66`, `:74`, `:79`
- Test: `tests/marketing/site.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SiteFile { path: string; sha256: string; contentType: string; content: Uint8Array }`, `siteTextOf(file: SiteFile): string`, `encodeSiteText(text: string): Uint8Array`, `TEXT_HTML_CONTENT_TYPE = 'text/html'`, `sha256OfText(text: string): string`. Task 3 builds image files with these; Task 4's loader hands back `Uint8Array` bytes that go straight into `content`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/marketing/site.test.ts`. The pinned hash is the point: it is computed by hand today, so a value written into the test *before* the refactor is what proves the refactor changed nothing.

```ts
describe('the byte lane (slice 5 R1)', () => {
  // Computed with `node -e "console.log(require('crypto').createHash('sha256').update('<h1>hi</h1>').digest('hex'))"`,
  // so this is the UTF-8 hash of the page, not the hash of whatever the code under test happens to produce.
  const INDEX_HASH = 'e7fbb6fbbf4ce294913eb62b53ff03a7546649cfdc0d824d9e3a2b4541502f7f'

  it('hashes the same bytes a text page had before it carried a Uint8Array', () => {
    const [page] = resolveSite('physio', [file('a1', 'page_html', '<h1>hi</h1>')])
    expect(page?.sha256).toBe(INDEX_HASH)
    expect(page?.contentType).toBe('text/html')
    expect(siteTextOf(page!)).toBe('<h1>hi</h1>')
    expect(page?.content).toBeInstanceOf(Uint8Array)
  })

  it('leaves a multi-file site hash unchanged across the string to bytes move', () => {
    // The canonical value slice 2 pinned: two pages, sorted pairs, one hash.
    const hash = siteHashOf(resolveSite('physio', [
      file('a1', 'page_html', '<h1>hi</h1>'),
      file('a2', 'thank_you_html', '<p>thanks</p>'),
    ]))
    expect(hash).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true)
  })
})
```

Run `npx vitest run tests/marketing/site.test.ts` and confirm the new block fails on `contentType` and on `content` not being a `Uint8Array`. Record the failure output in your report.

- [ ] **Step 2: Change `SiteFile` and add the two codecs**

In `src/marketing/site.ts`, import nothing new beyond `node:crypto`, then replace the interface at `:33-37` and add the helpers beside it:

```ts
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

export const TEXT_HTML_CONTENT_TYPE = 'text/html'

export interface SiteFile {
  path: string
  sha256: string
  // Travels with the file rather than being decided at the upload, because an
  // image uploaded as `text/html` is an image the browser is told to parse as
  // markup, and nobody reviewing a page can tell from the outside.
  contentType: string
  // Bytes, not text: a hosted page can now carry a PNG, and a union would put
  // the same two decode lines in every consumer.
  content: Uint8Array
}

export function encodeSiteText(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text)
}

export function siteTextOf(file: SiteFile): string {
  return TEXT_DECODER.decode(file.content)
}

/**
 * The hash of exactly the bytes that are uploaded. For a text page this is the
 * value `site.ts` has produced since slice 2, because `createHash` on a string
 * already hashes its UTF-8 encoding; the pinned test above is what keeps that
 * claim honest rather than assumed.
 */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
```

- [ ] **Step 3: Make `resolveSite` build a byte file**

Replace the `files.push` block inside the `SITE_SLOTS` loop:

```ts
    const content = rows[0]?.textContent ?? ''
    files.push({
      path: `${slug}/${slot.suffix}`,
      sha256: sha256OfText(content),
      contentType: TEXT_HTML_CONTENT_TYPE,
      content: encodeSiteText(content),
    })
```

- [ ] **Step 4: Pixel injection decodes, injects, re-encodes and recomputes**

In `src/marketing/pixel-injection.ts`, add `import { createHash } from 'node:crypto'` and extend the `./site` import to `import { siteTextOf, type SiteFile } from './site'`. Replace the `patched` map body:

```ts
  const patched = files.map((file) => {
    // The `.html` test is what keeps this module from ever touching a picture:
    // an asset's bytes go through the resolver, not through a string rewrite.
    if (!file.path.endsWith('.html')) return file
    const injected = injectPixel(siteTextOf(file), pixelId)
    // Recomputed, because after Task 6 the same field describes a PNG's bytes in
    // a manifest Cloudflare checks. This does not weaken the approval invariant:
    // readSiteFiles compares the approved hash BEFORE injecting, so the receipt
    // still covers the bytes the reviewer saw, and the pixel stays the documented
    // deviation from them (spec section 2).
    return { ...file, content: encodeSiteText(injected), sha256: createHash('sha256').update(injected).digest('hex') }
  })
```

`encodeSiteText` comes from the same import line.

- [ ] **Step 5: The upload labels each part with its own type**

In `src/marketing/page-host.ts:51`, replace the hardcoded type:

```ts
    form.set(file.sha256, new Blob([file.content], { type: file.contentType }))
```

- [ ] **Step 6: Fix the three fixtures that build a `SiteFile` by hand**

`tests/marketing/pixel-injection.test.ts` is the only test that spells the type. Change `makeFile` and the two content assertions:

```ts
function makeFile(path: string, content: string): SiteFile {
  return { path, content: new TextEncoder().encode(content), contentType: 'text/html', sha256: 'unused' }
}
```

and at `:74` (and its sibling in the multi-file case at `:79` onward), replace `expect(f.content).toContain(buildPixelSnippet(PIXEL_ID))` with `expect(siteTextOf(f)).toContain(buildPixelSnippet(PIXEL_ID))`, importing `siteTextOf` from `@/marketing/site`.

- [ ] **Step 7: Add the injection deviation test**

Append to `tests/marketing/pixel-injection.test.ts`, because refinement 4 in this plan's preamble is a claim about behaviour and only a test makes it one:

```ts
describe('the hash after injection', () => {
  it('describes the bytes that were injected, not the bytes that were approved', () => {
    const [one] = injectPixelIntoFiles([makeFile('physio/index.html', '<html><head></head></html>')], PIXEL_ID).files
    const file = one!
    expect(file.sha256).toBe(createHash('sha256').update(siteTextOf(file)).digest('hex'))
    expect(file.sha256).not.toBe(makeFile('physio/index.html', '<html><head></head></html>').sha256)
  })

  it('leaves a non-html file byte-identical', () => {
    const png = { path: 'physio/assets/a.png', sha256: 'deadbeef', contentType: 'image/png', content: new Uint8Array([1, 2, 3]) }
    const result = injectPixelIntoFiles([png], PIXEL_ID)
    expect(result.files[0]).toEqual(png)
  })
})
```

Add `import { createHash } from 'node:crypto'` and the `siteTextOf` import to that file.

- [ ] **Step 8: Run the named tests, typecheck and lint**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/site.test.ts tests/marketing/pixel-injection.test.ts tests/marketing/page-host.test.ts
npm run typecheck
npm run lint
```

Expected: all three files pass, typecheck clean. `tests/marketing/page-host.test.ts` needs no edit; its assertions read `Blob.text()`, which is unaffected by the field's type. If it fails, the failure is real and this task is not done.

- [ ] **Step 9: Commit**

```bash
cd D:/Code/CRUM
git add src/marketing/site.ts src/marketing/pixel-injection.ts src/marketing/page-host.ts tests/marketing/site.test.ts tests/marketing/pixel-injection.test.ts
git commit -m "refactor(marketing): a site file carries bytes, a content type and a true hash"
```

---

### Task 2: The placeholder grammar and the name scan

The handle the funnel builder writes before any pixel exists. It is the designer's asset name, and `marketing.generate_assets` already stores it as the document title (`src/mastra/tools/marketing-writes.ts:1402`), which is what makes it writable at page-save time and resolvable at read time.

**Files:**
- Modify: `src/marketing/site.ts` (add the grammar, the scan, the token count)
- Test: `tests/marketing/site.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ASSET_REFERENCE: RegExp` (`/\{\{ASSET:([^{}]+?)\}\}/g`), `ASSET_LITERAL = '{{ASSET:'`, `assetNamesReferenced(html: string): string[]` (trimmed, de-duplicated, first-seen order), `unterminatedAssetReferences(html: string): string[]`. Task 3 uses all four; Task 4 uses `assetNamesReferenced` to decide which documents need a byte read.

- [ ] **Step 1: Write the failing tests**

```ts
describe('assetNamesReferenced', () => {
  it('reads one name', () => {
    expect(assetNamesReferenced('<img src="{{ASSET:hero}}">')).toEqual(['hero'])
  })

  it('reads the same name once, however many times the page uses it', () => {
    expect(assetNamesReferenced('{{ASSET:hero}} {{ASSET:hero}}')).toEqual(['hero'])
  })

  it('keeps two names in the order the page wrote them', () => {
    expect(assetNamesReferenced('{{ASSET:b}} then {{ASSET:a}}')).toEqual(['b', 'a'])
  })

  it('trims, because a model writes {{ASSET: hero }} as readily as {{ASSET:hero}}', () => {
    expect(assetNamesReferenced('{{ASSET:  hero  }}')).toEqual(['hero'])
  })

  it('allows a space inside a name, because asset titles are prose', () => {
    expect(assetNamesReferenced('{{ASSET:Hero image}}')).toEqual(['Hero image'])
  })

  it('ignores a fragment with no closing braces and reports it as unterminated', () => {
    expect(assetNamesReferenced('{{ASSET:hero')).toEqual([])
    expect(unterminatedAssetReferences('{{ASSET:hero')).toEqual(['{{ASSET:hero'])
  })

  it('refuses a name containing a brace rather than half-matching it', () => {
    expect(assetNamesReferenced('{{ASSET:a{b}}')).toEqual([])
    expect(unterminatedAssetReferences('{{ASSET:a{b}}')).toHaveLength(1)
  })
})
```

Run `npx vitest run tests/marketing/site.test.ts`; expect the whole new block to fail with "assetNamesReferenced is not a function".

- [ ] **Step 2: Implement the grammar**

```ts
/**
 * The handle is the designer's asset name, which `marketing.generate_assets`
 * already stores as the document title, so the funnel builder can write a page
 * that names a picture before that picture is paid for. Spec section 5.1.
 *
 * `[^{}]+?` and not `.+?`: a name with a brace in it is refused by the prompt
 * parser long before it reaches a page, and a grammar that could match across a
 * second placeholder would make one typo eat the page.
 *
 * Never call `.test()` or `.exec()` on this exported global. `matchAll` clones the
 * regex and a global `replace` resets `lastIndex`, but a manual `.test()` would
 * leave the pointer mid-string and make this scan and Task 3's substitution
 * disagree about one page, which is the divergence this slice cannot afford.
 */
export const ASSET_REFERENCE = /\{\{ASSET:([^{}]+?)\}\}/g
export const ASSET_LITERAL = '{{ASSET:'

export function assetNamesReferenced(html: string): string[] {
  const names: string[] = []
  for (const match of html.matchAll(ASSET_REFERENCE)) {
    const name = (match[1] ?? '').trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The fragments the grammar refused to match. A literal that no well-formed
 * placeholder explains is the whole finding, so each entry starts at that literal
 * and runs to the next `}}` or the end of the page, cut at `MAX_FRAGMENT_CHARS` so
 * a refusal quotes a phrase rather than a paragraph of the client's copy. A page
 * that survives substitution still carrying the literal is a page whose placeholder
 * was malformed, and publishing `{{ASSET:hero` to a live domain is a bug the owner
 * finds by clicking, which is the finding this slice refuses to leave in place.
 *
 * Counting literals against matches would report the fact but not the place, and it
 * would under-report a page with two broken placeholders, so this walks the literals.
 */
const MAX_FRAGMENT_CHARS = 120

export function unterminatedAssetReferences(html: string): string[] {
  const matchedStarts = new Set([...html.matchAll(ASSET_REFERENCE)].map((match) => match.index))
  const fragments: string[] = []
  for (let at = html.indexOf(ASSET_LITERAL); at !== -1; at = html.indexOf(ASSET_LITERAL, at + ASSET_LITERAL.length)) {
    if (matchedStarts.has(at)) continue
    const closing = html.indexOf('}}', at)
    const end = closing === -1 ? html.length : Math.min(closing + 2, html.length)
    fragments.push(html.slice(at, Math.min(end, at + MAX_FRAGMENT_CHARS)))
  }
  return fragments
}
```

`assetNamesReferenced` returning `[]` for a blank name (`{{ASSET:}}`) is deliberate: `unterminatedAssetReferences` reports it, because a blank name has no title to name in a refusal.

Step 1's block tests two functions, so split it: keep `describe('assetNamesReferenced')` for the name cases and add a sibling `describe('unterminatedAssetReferences')` for the cases that only call the second, because a failure must name the function that failed. Add these four cases to the second block while you split it: a page with no placeholder at all returns `[]` (the branch most pages take, and the cheapest guard against an off-by-one in the count), `unterminatedAssetReferences('{{ASSET:}}')` equals `['{{ASSET:}}']`, `unterminatedAssetReferences('{{ASSET:a}} {{ASSET:b {{ASSET:c')` has length 2 (two malformed literals are two findings, not one), and a long page quotes the fragment rather than the copy around it:

```ts
  it('quotes the fragment and not the page around it', () => {
    const html = '<h1>Bring your back pain to the clinic</h1><p>Book now</p>{{ASSET:hero</p>'
    expect(unterminatedAssetReferences(html)).toEqual(['{{ASSET:hero</p>'])
  })
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/marketing/site.test.ts`. Expected: PASS, and every earlier block still green.

- [ ] **Step 4: Commit**

```bash
cd D:/Code/CRUM
git add src/marketing/site.ts tests/marketing/site.test.ts
git commit -m "feat(marketing): the asset placeholder grammar and the name scan"
```

---

### Task 3: Assets inside `resolveSite`: the problem list, the error, the paths, the ceilings

This is the task that puts a picture on a page. `resolveSite` stops dropping every `image` artifact on the floor, `siteProblem` answers every asset question in a sentence before a draft exists, and `AssetProblemError` is what the approval translates. It stays pure and synchronous: it receives artifacts that already carry `title`, `mime` and `bytes`, which Task 4's loader is what fills.

**Files:**
- Modify: `src/marketing/site.ts` (`SiteArtifact`, the ceilings, `AssetProblemError`, `assetProblemList`, `siteProblem`, `resolveSite`)
- Test: `tests/marketing/site.test.ts`

**Interfaces:**
- Consumes: Task 1's `encodeSiteText`, `sha256OfText`, `SiteFile`; Task 2's `ASSET_REFERENCE`, `assetNamesReferenced`, `unterminatedAssetReferences`, `ASSET_LITERAL`.
- Produces: `SiteArtifact` gains optional `documentId`, `title`, `mime`, `bytes`; `ASSET_MIME_EXTENSIONS`; `MAX_ASSET_BYTES` (8 MiB), `MAX_SITE_BYTES` (24 MiB), `MAX_SITE_ASSETS` (12); `AssetProblemError` with `.token: AssetProblemToken`; `siteProblem(artifacts): string | null` (slot lane then asset lane); `unreferencedAssetNames(artifacts): string[]`. Task 4's loader and Task 5's four hash sites consume these; Task 6's stage refusal and `assetsUnreferenced` report consume `siteProblem` and `unreferencedAssetNames`.

- [ ] **Step 1: Write the failing tests**

Add a helper beside the existing `file` one, then the cases. `PNG_BYTES` is three bytes so the size ceilings stay testable without a megabyte in a fixture.

```ts
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const asset = (
  id: string,
  title: string,
  over: Partial<SiteArtifact> = {},
): SiteArtifact => ({
  id,
  kind: 'image',
  textContent: null,
  documentId: `00000000-0000-4000-8000-${id.padEnd(12, '0')}`,
  title,
  mime: 'image/png',
  bytes: PNG_BYTES,
  ...over,
})
const page = (html: string): SiteArtifact => ({ id: 'p1', kind: 'page_html', textContent: html })

describe('resolveSite with assets', () => {
  it('publishes a referenced image at a document-id path under the slug', () => {
    const files = resolveSite('physio', [page('<img src="{{ASSET:hero}}">'), asset('i1', 'hero')])
    expect(files.map((f) => f.path)).toEqual(['physio/assets/00000000-0000-4000-8000-i1000000000000.png', 'physio/index.html'])
    const image = files.find((f) => f.path.endsWith('.png'))!
    expect(image.contentType).toBe('image/png')
    expect(image.content).toEqual(PNG_BYTES)
    expect(image.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'))
  })

  it('substitutes a root-relative URL into the page before hashing it', () => {
    // Root-relative, not relative to the page: the thank-you page sits one level
    // deeper, and `assets/a.png` from there asks for a path that does not exist.
    const files = resolveSite('physio', [page('<img src="{{ASSET:hero}}">'), asset('i1', 'hero')])
    const html = files.find((f) => f.path === 'physio/index.html')!
    expect(siteTextOf(html)).toBe('<img src="/physio/assets/00000000-0000-4000-8000-i1000000000000.png">')
    expect(html.sha256).toBe(sha256OfText(siteTextOf(html)))
  })

  it('does not publish or hash an image the page never names', () => {
    const withUnused = resolveSite('physio', [page('<p>text only</p>'), asset('i1', 'hero'), asset('i2', 'unused')])
    expect(withUnused.map((f) => f.path)).toEqual(['physio/index.html'])
    expect(unreferencedAssetNames([page('<p>text only</p>'), asset('i1', 'hero')])).toEqual(['hero'])
  })

  it('hashes a repeated reference once, because it is one file', () => {
    const twice = resolveSite('physio', [page('{{ASSET:hero}} {{ASSET:hero}}'), asset('i1', 'hero')])
    expect(twice.filter((f) => f.path.endsWith('.png'))).toHaveLength(1)
  })

  it('refuses a mime with no extension rather than guessing one', () => {
    expect(() => resolveSite('physio', [page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/gif' })]))
      .toThrow(AssetProblemError)
    expect(siteProblem([page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/gif' })])).toContain('image/gif')
  })
})

describe('siteProblem names each asset failure', () => {
  const cases: Array<[string, SiteArtifact[], string]> = [
    ['asset_name_missing', [page('{{ASSET:hero}}')], 'hero'],
    ['asset_name_ambiguous', [page('{{ASSET:hero}}'), asset('i1', 'hero'), asset('i2', 'hero')], 'hero'],
    ['asset_mime_unsupported', [page('{{ASSET:hero}}'), asset('i1', 'hero', { mime: 'image/tiff' })], 'image/tiff'],
    ['asset_bytes_missing', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: null })], 'hero'],
    ['asset_bytes_missing', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(0) })], 'hero'],
    ['asset_too_large', [page('{{ASSET:hero}}'), asset('i1', 'hero', { bytes: new Uint8Array(MAX_ASSET_BYTES + 1) })], '8388608'],
    ['asset_unresolved', [page('{{ASSET:hero')], '{{ASSET:hero'],
  ]

  it.each(cases)('%s is refused in a sentence naming %s', (token, artifacts, needle) => {
    const problem = siteProblem(artifacts)
    expect(problem).not.toBeNull()
    expect(problem).toContain(needle)
    // One predicate, two spellings: whatever siteProblem can say, resolveSite
    // refuses with the same token rather than publishing something else.
    expect(() => resolveSite('physio', artifacts)).toThrow(
      (err: unknown) => err instanceof AssetProblemError && err.token === token,
    )
  })

  it('counts one asset over the ceiling by itself, and twelve of them too', () => {
    const twelve = Array.from({ length: 13 }, (_unused, i) => asset(`i${i}`, `a${i}`))
    const names = twelve.map((a) => `{{ASSET:${a.title}}}`).join(' ')
    expect(siteProblem([page(names), ...twelve])).toContain('12')
  })

  it('adds the page and its pictures together when it checks the site ceiling', () => {
    const big = new Uint8Array(MAX_ASSET_BYTES - 1024)
    const artifacts = [page('{{ASSET:a}} {{ASSET:b}}'), asset('i1', 'a', { bytes: big }), asset('i2', 'b', { bytes: big })]
    expect(siteProblem(artifacts)).toContain('asset_too_large')
  })

  it('is null for a page with no placeholders and for a bundle with no page', () => {
    expect(siteProblem([page('<h1>hi</h1>')])).toBeNull()
    expect(siteProblem([asset('i1', 'hero')])).toBeNull()
  })

  it('still says what slotProblem says about two pages in one slot', () => {
    const two = [file('a1', 'page_html', '<h1>old</h1>'), file('a2', 'page_html', '<h1>new</h1>')]
    expect(siteProblem(two)).toBe(slotProblem(two))
  })
})
```

Expected RED: `asset is not defined` is impossible (it is in the test), so the failures are the missing exports (`AssetProblemError`, `MAX_ASSET_BYTES`, `unreferencedAssetNames`) and the assertions about paths.

- [ ] **Step 2: Enrich `SiteArtifact` and add the tables and ceilings**

```ts
export interface SiteArtifact {
  id: string
  kind: string
  textContent: string | null
  // The four asset fields are optional on purpose. Every fixture in nine test
  // files spells three, and the loader in Task 4 is the only code that can fill
  // these, because a title, a mime and bytes are a read rather than a fact
  // about the artifact row.
  documentId?: string | null
  title?: string | null
  mime?: string | null
  bytes?: Uint8Array | null
}

/**
 * A closed table, and a refusal outside it. A guessed extension is a file the
 * browser may not render, and `pageHostConfigFromEnv`'s `nonBlank` set the
 * precedent for refusing rather than assuming (spec section 5.3).
 */
export const ASSET_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

// The Cloudflare Pages per-file and per-deployment limits are higher than these,
// so they are CRUM's own ceilings: a page that needs a 40 MB hero is a mistake in
// the creative, and the cheap place to say so is before a reviewer is asked.
export const MAX_ASSET_BYTES = 8 * 1024 * 1024
export const MAX_SITE_BYTES = 24 * 1024 * 1024
export const MAX_SITE_ASSETS = 12

export type AssetProblemToken =
  | 'asset_name_missing'
  | 'asset_name_ambiguous'
  | 'asset_mime_unsupported'
  | 'asset_bytes_missing'
  | 'asset_too_large'
  | 'asset_unresolved'

export class AssetProblemError extends Error {
  readonly token: AssetProblemToken
  readonly detail: string

  constructor(token: AssetProblemToken, detail: string) {
    super(`${token}: ${detail}`)
    this.name = 'AssetProblemError'
    this.token = token
    this.detail = detail
  }
}
```

- [ ] **Step 3: One problem list, two spellings**

The `slotProblem` / `resolveSite` pair already in this file is the house pattern: answer in text for the tool that reports, throw for the path that must not proceed. `assetProblemList` is the single predicate both spellings read.

```ts
function imageArtifacts(artifacts: readonly SiteArtifact[]): SiteArtifact[] {
  return artifacts.filter((a) => a.kind === 'image')
}

function pageArtifacts(artifacts: readonly SiteArtifact[]): SiteArtifact[] {
  const pages: SiteArtifact[] = []
  for (const slot of SITE_SLOTS) pages.push(...ofKind(artifacts, slot.kind))
  return pages
}

function referencedNames(artifacts: readonly SiteArtifact[]): string[] {
  const names: string[] = []
  for (const page of pageArtifacts(artifacts)) {
    for (const name of assetNamesReferenced(page.textContent ?? '')) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

interface AssetChoice {
  name: string
  artifact: SiteArtifact
  documentId: string
  extension: string
  byteLength: number
}

/**
 * Every asset question this slice can ask, in the order it asks it: a name with
 * no answer, then two answers, then the bytes behind the answer, then the size of
 * the whole site. Cheapest and most specific first, because the owner reading a
 * stage refusal has to be able to act on the first sentence they see.
 */
function resolveAssets(artifacts: readonly SiteArtifact[]): { choices: AssetChoice[]; problem: { token: AssetProblemToken; detail: string } | null } {
  const images = imageArtifacts(artifacts)
  const byTitle = new Map<string, SiteArtifact[]>()
  for (const image of images) {
    const key = (image.title ?? '').trim()
    if (key === '') continue
    byTitle.set(key, [...(byTitle.get(key) ?? []), image])
  }

  const names = referencedNames(artifacts)
  for (const page of pageArtifacts(artifacts)) {
    const html = page.textContent ?? ''
    const bad = unterminatedAssetReferences(html)
    if (bad.length > 0) {
      return { choices: [], problem: { token: 'asset_unresolved', detail: `a page carries \`${ASSET_LITERAL}\` with no closing braces, so nothing could be substituted into ${JSON.stringify(bad[0])}` } }
    }
    // A placeholder the grammar matches but no name fills is the same mistake in a
    // different shape: `assetNamesReferenced` drops it, so the name lanes never see it,
    // and substitution would look up the empty string. Refusing here is what keeps the
    // promise that `siteProblem` says everything `resolveSite` would throw about.
    for (const match of html.matchAll(ASSET_REFERENCE)) {
      if ((match[1] ?? '').trim() === '') {
        return { choices: [], problem: { token: 'asset_unresolved', detail: `a page carries ${JSON.stringify(match[0])}, which names no asset, so there is nothing to substitute` } }
      }
    }
  }

  const choices: AssetChoice[] = []
  for (const name of names) {
    const matches = byTitle.get(name) ?? []
    if (matches.length === 0) {
      const titles = [...byTitle.keys()].sort()
      return { choices: [], problem: { token: 'asset_name_missing', detail: `the page names the asset "${name}" and the bundle holds no image with that title (its images are ${titles.length > 0 ? titles.map((t) => `"${t}"`).join(', ') : 'none'}` } }
    }
    if (matches.length > 1) {
      return { choices: [], problem: { token: 'asset_name_ambiguous', detail: `${matches.length} images in this bundle are titled "${name}" (${matches.map((m) => m.id).join(', ')}), so the placeholder has more than one answer` } }
    }
    const artifact = matches[0]!
    const documentId = artifact.documentId ?? ''
    if (documentId === '') {
      return { choices: [], problem: { token: 'asset_bytes_missing', detail: `the image "${name}" (${artifact.id}) is attached to no document, so there are no bytes to publish` } }
    }
    const mime = artifact.mime ?? ''
    const extension = ASSET_MIME_EXTENSIONS[mime]
    if (extension === undefined) {
      return { choices: [], problem: { token: 'asset_mime_unsupported', detail: `the image "${name}" is ${mime || 'mime-less'} and CRUM publishes png, jpeg and webp only` } }
    }
    const bytes = artifact.bytes ?? null
    if (bytes === null || bytes.byteLength === 0) {
      return { choices: [], problem: { token: 'asset_bytes_missing', detail: `the image "${name}" (document ${documentId}) has no file row, or an empty one` } }
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      return { choices: [], problem: { token: 'asset_too_large', detail: `the image "${name}" is ${bytes.byteLength} bytes and CRUM publishes nothing over ${MAX_ASSET_BYTES}` } }
    }
    choices.push({ name, artifact, documentId, extension, byteLength: bytes.byteLength })
  }

  if (choices.length > MAX_SITE_ASSETS) {
    return { choices: [], problem: { token: 'asset_too_large', detail: `the page references ${choices.length} images and ${MAX_SITE_ASSETS} is the most CRUM publishes for one bundle` } }
  }
  const total = choices.reduce((sum, c) => sum + c.byteLength, 0) + pageArtifacts(artifacts).reduce((sum, p) => sum + encodeSiteText(p.textContent ?? '').byteLength, 0)
  if (total > MAX_SITE_BYTES) {
    return { choices: [], problem: { token: 'asset_too_large', detail: `the page and its pictures together are ${total} bytes and CRUM publishes nothing over ${MAX_SITE_BYTES}` } }
  }
  return { choices, problem: null }
}

export function assetPathOf(slug: string, choice: AssetChoice): string {
  return `/${slug}/assets/${choice.documentId}.${choice.extension}`
}

export function unreferencedAssetNames(artifacts: readonly SiteArtifact[]): string[] {
  const names = new Set(referencedNames(artifacts))
  return imageArtifacts(artifacts)
    .map((a) => (a.title ?? '').trim())
    .filter((t) => t !== '' && !names.has(t))
}

export function siteProblem(artifacts: readonly SiteArtifact[]): string | null {
  const slot = slotProblem(artifacts)
  if (slot !== null) return slot
  const { problem } = resolveAssets(artifacts)
  return problem === null ? null : new AssetProblemError(problem.token, problem.detail).message
}
```

`resolveAssets` returns the first problem only, which is what makes the assertion in Step 1's `it.each` table true for a fixture with exactly one defect.

Four corrections this task's own review forced, and they are now part of the requirement above rather than suggestions: the site total counts a page in **UTF-8 bytes** (`encodeSiteText(...).byteLength`), not UTF-16 code units, because the ceiling is quoted in bytes and a sentence that mixes units is the same class of untruth the plan forbids for hashes; the site-ceiling sentence states the size and the bound rather than calling the size an excess; an `ASSET_REFERENCE` match whose capture trims to empty is refused here with `asset_unresolved`, because otherwise `siteProblem` stays silent while `resolveSite` throws and the stage-and-approve sequence the plan refuses comes back; and the ambiguity sentence counts the images instead of asserting there are exactly two. One more, for the lanes a consumer has to branch on: `AssetProblemError` gains an optional third constructor parameter, `readonly ceiling?: 'image' | 'count' | 'site'`, passed from the three byte-ceiling lanes only. The token union stays at its six members (spec section 12), so a consumer that must tell "shrink this picture" from "use fewer pictures" from "the bundle is too big" reads the field rather than parsing English.

- [ ] **Step 4: `resolveSite` builds the image files**

Replace the body after the slug check:

```ts
export function resolveSite(slug: string, artifacts: readonly SiteArtifact[]): SiteFile[] {
  if (!slugIsPublishable(slug)) throw new SlugProblemError(slug)
  const slot = slotProblem(artifacts)
  if (slot !== null) {
    for (const kind of SLOT_KINDS) {
      const rows = ofKind(artifacts, kind)
      if (rows.length > 1) throw new SlotProblemError(kind, rows.map((r) => r.id))
    }
  }
  const { choices, problem } = resolveAssets(artifacts)
  if (problem !== null) throw new AssetProblemError(problem.token, problem.detail)
  const byName = new Map(choices.map((c) => [c.name, c]))

  const files: SiteFile[] = []
  for (const slotDef of SITE_SLOTS) {
    const rows = ofKind(artifacts, slotDef.kind)
    if (rows.length === 0) continue
    const raw = rows[0]?.textContent ?? ''
    // Substitution happens here, inside the bytes the approval hashes, and not
    // after the hash the way the pixel snippet does. Spec section 2 is the
    // reason a picture cannot ride the shape that is right next to it.
    const content = raw.replace(ASSET_REFERENCE, (_match, name: string) => {
      const choice = byName.get(name.trim())
      if (!choice) throw new AssetProblemError('asset_name_missing', `the page names "${name.trim()}" and no image answers it`)
      return assetPathOf(slug, choice)
    })
    files.push({
      path: `${slug}/${slotDef.suffix}`,
      sha256: sha256OfText(content),
      contentType: TEXT_HTML_CONTENT_TYPE,
      content: encodeSiteText(content),
    })
  }

  const seen = new Set<string>()
  for (const choice of choices) {
    const path = `${slug}/assets/${choice.documentId}.${choice.extension}`
    if (seen.has(path)) continue
    seen.add(path)
    const bytes = choice.artifact.bytes as Uint8Array
    files.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: choice.artifact.mime as string,
      content: bytes,
    })
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
```

Two notes the reviewer will ask about. The `slotProblem` re-check at the top is the throw spelling of the same predicate `resolveSite` has always had (`rows.length > 1` inside the loop is unreachable once the guard throws first, and keeping both is what the existing `SlotProblemError` tests exercise). And `choice.artifact.bytes as Uint8Array` is safe because `resolveAssets` refused a null or empty `bytes` before returning this choice; the cast carries that proof across the function boundary, and a `!` on an optional property would say less.

- [ ] **Step 5: Run the tests**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/site.test.ts tests/marketing/page-host.test.ts tests/marketing/pixel-injection.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. `tests/marketing/page-host.test.ts` still passes because every fixture it builds is a text-only site, and a text-only site resolves exactly as it did before this task, which the hash pinned in Task 1 is what proves.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/marketing/site.ts tests/marketing/site.test.ts
git commit -m "feat(marketing): assets resolve inside the bytes the approval hashes"
```

---

### Task 4: `loadSiteArtifacts`: the one loader that reads bytes

The I/O half. `resolveSite` is pure, so a caller must hand it artifacts that already carry title, mime and bytes, and the caller must not drag twelve megabytes of unreferenced PNGs into memory to hash a page that names none of them.

**Files:**
- Modify: `src/db/marketing-assets.ts` (add `getAssetBytesByIds` and `loadSiteArtifacts`)
- Test: `tests/db/marketing-assets.test.ts`

**Interfaces:**
- Consumes: Task 2's `assetNamesReferenced`, Task 3's `SiteArtifact` shape.
- Produces: `loadSiteArtifacts(tenantId: string, bundleId: string, client?: Queryable): Promise<SiteArtifact[]>` returning every artifact row of the bundle, in `created_at ASC` order like `listMarketingArtifacts`, with `documentId`, `title`, `mime` filled on `image` rows and `bytes` filled only on the images a page references. `getAssetBytesByIds(tenantId: string, documentIds: readonly string[], client?: Queryable): Promise<Map<string, Uint8Array>>`.

`Queryable` is the one-parameter structural type `siteHashInTransaction` already declares at `src/db/marketing.ts:306`; give it a name in `src/db/client.ts` rather than repeating it, and make `siteHashInTransaction` use it:

```ts
// src/db/client.ts, beside getDbClient
export interface Queryable {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>
}
```

- [ ] **Step 1: Write the failing tests**

`tests/db/marketing-assets.test.ts` mocks `./client` with a `query` spy; follow that file's existing shape rather than inventing a harness.

```ts
describe('loadSiteArtifacts', () => {
  it('reads the artifact rows without touching the data column', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [artifactRow()] }) }
    const artifacts = await loadSiteArtifacts(TENANT, BUNDLE, client as never)
    expect(artifacts[0]).toMatchObject({ kind: 'page_html', textContent: '<h1>hi</h1>' })
    expect(client.query.mock.calls[0]![0]).not.toContain('f.data')
    expect(client.query.mock.calls[0]![0]).toContain('k.title')
    // The alias is a test-harness requirement, not a style choice. Read the note
    // under Step 2: eight stage fixtures route their artifact read by SQL
    // fragment, and a loader whose SQL contains `JOIN documents d` gets answered
    // with the wrong rows.
    expect(client.query.mock.calls[0]![0]).not.toContain('JOIN documents d')
    expect(client.query.mock.calls[0]![0]).not.toContain('FROM document_files')
  })

  it('reads bytes for exactly the documents a page references, in one second query', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [artifactRow({ kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' }), artifactRow({ id: 'a2', kind: 'image', text_content: null, title: 'hero', mime: 'image/png' }), artifactRow({ id: 'a3', kind: 'image', text_content: null, title: 'unused', mime: 'image/png' })] })
        .mockResolvedValueOnce({ rows: [{ document_id: docId('a2'), data: new Uint8Array([1]) }] }),
    }
    const artifacts = await loadSiteArtifacts(TENANT, BUNDLE, client as never)
    const second = client.query.mock.calls[1]!
    expect(String(second[0])).toContain('ANY($2::uuid[])')
    expect(second[1]).toEqual([TENANT, [docId('a2')]])
    expect(artifacts.find((a) => a.id === 'a2')?.bytes).toEqual(new Uint8Array([1]))
    expect(artifacts.find((a) => a.id === 'a3')?.bytes).toBeUndefined()
  })

  it('asks for no bytes at all when no page has a placeholder', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [artifactRow()] }) }
    await loadSiteArtifacts(TENANT, BUNDLE, client as never)
    expect(client.query).toHaveBeenCalledTimes(1)
  })

  it('hands back a null bytes for an image whose document has no file row', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [artifactRow({ kind: 'page_html', textContent: '{{ASSET:hero}}' }), artifactRow({ id: 'a2', kind: 'image', text_content: null, title: 'hero', mime: 'image/png' })] })
        .mockResolvedValueOnce({ rows: [] }),
    }
    const artifacts = await loadSiteArtifacts(TENANT, BUNDLE, client as never)
    expect(artifacts.find((a) => a.id === 'a2')?.bytes).toBeNull()
  })
})
```

`artifactRow`, `docId`, `TENANT` and `BUNDLE` come from the existing constants in that file; widen `artifactRow` to take the enrichment columns, since the loader's first query returns them.

- [ ] **Step 2: `getAssetBytesByIds`**

```ts
/**
 * The one batched byte read. `getAssetBytes` stays for the single-document route
 * because that route needs the kind and status columns too, and a second
 * per-document call in a loop would be N round trips to answer one question the
 * site already knows the whole list of.
 */
export async function getAssetBytesByIds(
  tenantId: string,
  documentIds: readonly string[],
  client: Queryable = getDbClient(),
): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>()
  if (documentIds.length === 0) return found
  const result = await client.query<{ document_id: string; data: Uint8Array }>(
    // `document_id` is unique per document in this lane, and the LIMIT in the
    // sibling read at `getAssetBytes` is there for the same reason. A second file
    // row for one document would silently pick one, so the map keeps the first
    // rather than pretending the question has no answer.
    `SELECT f.document_id, f.data
       FROM document_files f
      WHERE f.tenant_id = $1 AND f.document_id = ANY($2::uuid[])
        AND EXISTS (
              SELECT 1 FROM documents k
               WHERE k.id = f.document_id AND k.kind = 'marketing_asset'
            )
      ORDER BY f.created_at ASC`,
    [tenantId, [...documentIds]],
  )
  for (const row of result.rows) if (!found.has(row.document_id)) found.set(row.document_id, row.data)
  return found
}
```

The `k.kind = 'marketing_asset'` filter is not a redundancy: it is the same clause that makes the bytes route's 404 reachable, and a loader that could read somebody's invoice bytes into a site hash would put that 404 on the wrong side of the design.

**Why the alias is `k` and the join is an `EXISTS`, and no query in this file may use `documents d`.** `tests/mastra/marketing-write-tools.test.ts` stubs the pool with `stubQueries` (`:61-92`), which answers a query from the *first* handler whose fragment appears in the SQL, in insertion order, and eight of its fixtures put `'JOIN documents d'` first precisely because `listImageAssetStatuses` is the only query that used to contain it (`src/db/marketing-assets.ts:131`, `:189`, and the file's own comment at `:774-777` says so). A loader written with the natural alias would have both fragments and would be answered with status rows instead of artifact rows, in ways that look like resolver bugs. `documents k` and `EXISTS (SELECT 1 FROM documents k …)` keep the loader's two reads matchable by `'FROM marketing_artifacts'` and `'FROM document_files'` alone. `getAssetBytes` keeps `JOIN documents d` untouched, because the byte route's own test asserts that fragment (`tests/db/marketing-assets.test.ts:266`) and nothing else matches on it.

- [ ] **Step 3: `loadSiteArtifacts`**

```ts
/**
 * The artifacts of one bundle, in the shape `resolveSite` reads, with the bytes of
 * only the images a page actually references.
 *
 * Two reads rather than one, and the second only when there is something to read:
 * the first names the referenced documents, the second fetches their bytes. A
 * single join that always pulled `document_files.data` would put every megabyte a
 * bundle ever paid for into memory to hash a page that mentions none of them, and
 * Cloudflare's per-request body limit is where that mistake would surface.
 *
 * Every row of the bundle comes back, not just the three kinds a site can carry:
 * `marketing.stage_bundle` counts this list for its payload, and a loader that
 * quietly filtered the count would move a number a reviewer is shown.
 */
export async function loadSiteArtifacts(
  tenantId: string,
  bundleId: string,
  client: Queryable = getDbClient(),
): Promise<SiteArtifact[]> {
  const rows = await client.query<{
    id: string
    kind: string
    text_content: string | null
    document_id: string | null
    title: string | null
    mime: string | null
  }>(
    `SELECT a.id, a.kind, a.text_content, a.document_id, k.title, k.mime
       FROM marketing_artifacts a
       LEFT JOIN documents k ON k.id = a.document_id
      WHERE a.tenant_id = $1 AND a.bundle_id = $2
      ORDER BY a.created_at ASC`,
    [tenantId, bundleId],
  )
  const artifacts: SiteArtifact[] = rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    textContent: row.text_content,
    documentId: row.document_id,
    title: row.title,
    mime: row.mime,
  }))

  const referenced = new Set(artifacts.flatMap((a) => (a.kind === 'page_html' || a.kind === 'thank_you_html' ? assetNamesReferenced(a.textContent ?? '') : [])))
  const want = artifacts
    .filter((a) => a.kind === 'image' && a.documentId !== null && referenced.has((a.title ?? '').trim()))
    .map((a) => a.documentId as string)
  if (want.length === 0) return artifacts

  const bytes = await getAssetBytesByIds(tenantId, want, client)
  for (const artifact of artifacts) {
    if (artifact.kind !== 'image' || artifact.documentId === null) continue
    if (!referenced.has((artifact.title ?? '').trim())) continue
    artifact.bytes = bytes.get(artifact.documentId) ?? null
  }
  return artifacts
}
```

The mime comes from `documents.mime`, not a `document_files` sub-select, and the two are the same value by construction: `insertAssetDocument` passes `params.mime` to both (`src/db/marketing-assets.ts:94` and `:99`). Taking it from the joined row keeps this read free of the `document_files` fragment that the second read is matched by, and it drops a correlated subquery from the query that runs on every stage, promote, retry, approval and publish.

`artifact.bytes = … ?? null` sets the key explicitly so a document with no file row is `null` (refused as `asset_bytes_missing`) rather than absent, which Task 3 reads the same way but a future caller might not.

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd D:/Code/CRUM
npx vitest run tests/db/marketing-assets.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. Then check the import graph once out loud in your report: `src/db/marketing-assets.ts` now imports `assetNamesReferenced` and the `SiteArtifact` type from `../marketing/site`, and `site.ts` type-imports `MarketingArtifactKind` from `../db/marketing`. Nothing in that cycle loads `marketing-assets.ts` at module-evaluation time, so it holds. If `npm run typecheck` reports a circular-reference error, stop and report it rather than moving the function.

- [ ] **Step 5: Commit**

```bash
cd D:/Code/CRUM
git add src/db/marketing-assets.ts src/db/client.ts tests/db/marketing-assets.test.ts
git commit -m "feat(marketing): one loader hands the resolver its artifacts and their bytes"
```

---

### Task 5: All four hash sites go through the loader

Spec section 5.4's table is the whole task: four places compute a site hash, and a page that resolves differently in two of them is the drift R2 exists to catch. This task changes no refusal and no message; it changes who reads the artifacts, so that all four see the same bytes.

**Files:**
- Modify: `src/db/marketing.ts:306-335` (`siteHashInTransaction`, and its `client` parameter type)
- Modify: `src/marketing/outbox.ts:193-207` (`ArtifactSqlRow`, the `client` type), `:239-262` (the artifact read and the problem check), `:271-281` (the catch)
- Modify: `src/marketing/page-host.ts:7` (import), `:104-117` (`readSiteFiles` and its doc comment)
- Modify: `src/mastra/tools/marketing-writes.ts:17`, `:43-47`, `:428`
- Test: `tests/marketing/outbox.test.ts`, `tests/marketing/page-host.test.ts`, `tests/db/marketing-commit.test.ts`

**Interfaces:**
- Consumes: Task 4's `loadSiteArtifacts` and Task 3's `siteProblem` and `AssetProblemError`.
- Produces: no new export. What it produces is the invariant Task 7 asserts: one bundle, one resolution, four callers.

- [ ] **Step 1: Write the failing tests in `tests/marketing/outbox.test.ts`**

The fake client at `:43-57` answers three SQL fragments and hands `[{ id: BUNDLE }]` to anything else, which for a byte read would be a row with no `document_id`. Give it a fourth branch, and widen `clientReturning` with a third parameter that defaults to `[]` so none of the existing call sites changes:

```ts
function clientReturning(
  rows: unknown[],
  artifacts: unknown[] = [],
  assetFiles: unknown[] = [],
) {
  const query = vi.fn((sql: string, _values?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (sql.includes('FROM marketing_bundles')) return Promise.resolve({ rows })
    if (sql.includes('FROM marketing_artifacts')) return Promise.resolve({ rows: artifacts })
    // The loader's second read, answered separately because a page that names an
    // asset has to get either real bytes or a real empty, not the default row.
    if (sql.includes('FROM document_files')) return Promise.resolve({ rows: assetFiles })
    return Promise.resolve({ rows: [{ id: BUNDLE }] })
  })
  return { query, sqls: () => query.mock.calls.map((c) => c[0]) }
}
```

`DOC` is a new uuid constant beside `BUNDLE` (`'44444444-4444-4444-8444-444444444444'`). Add the two cases inside the `commitBundleApproval` describe block:

```ts
it('refuses an approval whose page names an asset that has no bytes, and signs nothing', async () => {
  const artifacts = [
    { id: 'a1', kind: 'page_html', text_content: '<img src="{{ASSET:hero}}">' },
    { id: 'a2', kind: 'image', text_content: null, document_id: DOC, title: 'hero', mime: 'image/png' },
  ]
  const client = clientReturning(
    [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
    artifacts,
  )
  await expect(approve(client, PAGE_HASH)).rejects.toThrow(BundleNotApprovableError)
  const message = await approve(client, PAGE_HASH).catch((e: unknown) => String((e as Error).message))
  expect(message).toContain('asset_bytes_missing')
  expect(client.sqls().some((sql) => sql.includes('INSERT INTO marketing_actions'))).toBe(false)
})

it('hashes the picture into the approval rather than beside it', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01])
  const siteArtifacts = [
    { id: 'a1', kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' },
    { id: 'a2', kind: 'image', textContent: null, documentId: DOC, title: 'hero', mime: 'image/png', bytes: png },
  ]
  // The hash a stage would have recorded, computed by the resolver over the
  // picture as well as the page.
  const expected = siteHashOf(resolveSite('free-scan', siteArtifacts))
  const client = clientReturning(
    [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
    [
      { id: 'a1', kind: 'page_html', text_content: '<img src="{{ASSET:hero}}">' },
      { id: 'a2', kind: 'image', text_content: null, document_id: DOC, title: 'hero', mime: 'image/png' },
    ],
    [{ document_id: DOC, data: png }],
  )
  // The proof is that the comparison passes: `expected` names the PNG's bytes, and
  // the code before this task resolved a text-only page and refused this hash.
  await expect(approve(client, expected)).resolves.toBe(BUNDLE)
})
```

- [ ] **Step 2: `commitBundleApproval` reads through the loader**

`src/marketing/outbox.ts` imports `loadSiteArtifacts` from `../db/marketing-assets`, `AssetProblemError` and `siteProblem` from `./site`, and `Queryable` from `../db/client`. Delete the now-unused `ArtifactSqlRow` interface at `:193-197` (an unused interface is an `@typescript-eslint/no-unused-vars` error), and give `commitBundleApproval`'s `client` the `Queryable` type rather than the inline object type.

Replace `:244-262` — the inline SELECT, its row mapping, and the `slotProblem` guard — with:

```ts
  // The bytes the reviewer approved are identified by a hash in the staged
  // payload. Nothing else in this transaction knows what the human looked at, so
  // the lock is the last place that can still ask. Artifacts are read here rather
  // than passed in: they live in rows the FOR UPDATE lock does not cover, and a
  // re-read inside the transaction is the only version the commit may rely on.
  // The read rides the caller's client for the same reason: a picture fetched on a
  // second connection is a version this commit is not holding.
  const artifacts = await loadSiteArtifacts(params.tenantId, row.id, client)

  // `siteProblem`, not `slotProblem`: an asset the page cannot resolve is the same
  // class of unapprovable bundle, and the sentence it returns names the placeholder
  // and the titles that exist. A slot problem still wins the ordering, because
  // `siteProblem` asks it first.
  const problem = siteProblem(artifacts)
  if (problem !== null) {
    throw new BundleNotApprovableError(
      `marketing bundle ${row.id} cannot be approved: ${problem}`,
    )
  }
```

Widen the catch at `:276-281` so a throw from inside `deriveActions` still arrives as a refusal and not a 500:

```ts
    if (err instanceof SlugProblemError || err instanceof AssetProblemError) {
      throw new BundleNotApprovableError(err.message)
    }
```

The pre-check and the catch are not duplicates: the first is the sentence a reviewer reads for the ordinary case, the second is what keeps an asset that moved between the check and the derivation from surfacing as an unhandled error. Both say the same thing because both come from `site.ts`.

- [ ] **Step 3: `siteHashInTransaction` reads through the loader**

`src/db/marketing.ts` imports `loadSiteArtifacts` from `./marketing-assets` and `siteProblem` from `../marketing/site`, and the parameter at `:307` becomes `client: Queryable` (`Queryable` from `./client`). `:321-334` collapses to:

```ts
  const artifacts = await loadSiteArtifacts(tenantId, bundleId, client)
  // Null, not a throw: this is the read behind `currentSiteHash`, whose contract
  // is "null when the bundle has no publishable page". An unresolvable asset is
  // that same nothing-to-publish answer, and the promote and retry callers already
  // refuse on null.
  if (siteProblem(artifacts) !== null) return null
  return siteHashOf(resolveSite(slug, artifacts))
```

Say the import graph out loud in your report: `src/db/marketing.ts` now imports `./marketing-assets`, which imports `../marketing/site`, which type-imports from `../db/marketing`. The only back edge is a type-only import, so nothing cycles at runtime, and `npm run typecheck` is what proves it. If it reports a circular-reference error, stop and report rather than moving functions between modules.

- [ ] **Step 4: `readSiteFiles` reads through the loader**

`src/marketing/page-host.ts:7` swaps `listMarketingArtifacts` for `loadSiteArtifacts` from `../db/marketing-assets`, and `:116` becomes `const artifacts = await loadSiteArtifacts(tenantId, bundleId)`. The tenant scoping the doc comment at `:104-111` defends is unchanged — the loader is `WHERE a.tenant_id = $1` — but the comment names the old function, so rewrite that one sentence to name `loadSiteArtifacts` and add why it also answers the byte question.

Leave `src/api/marketing.ts:128` on `listMarketingArtifacts`. The bundle GET is a fifth read of the same table and deliberately not a hash site: a reviewer's list must show every image in the bundle, including the ones no page references, and paying for their bytes to render a list would be the memory cost this loader exists to avoid.

- [ ] **Step 5: the stage tool reads through the loader**

In `src/mastra/tools/marketing-writes.ts`, drop `listMarketingArtifacts` from the `../../db/marketing` import block (`:17`) and add `loadSiteArtifacts` to the `../../db/marketing-assets` block (`:43-47`). Then `:428` becomes:

```ts
      const artifacts = await loadSiteArtifacts(rc.tenantId, bundle.id)
```

Task 6 adds the refusals on top of this read; this task only makes the hash the payload records include the picture.

- [ ] **Step 6: Move the page-host mock and prove it**

`tests/marketing/page-host.test.ts:3-7` mocks `../../src/db/marketing`, which after Step 4 the module no longer imports. Mock the loader instead, keeping the hoisted-object pattern the file already uses:

```ts
const db = vi.hoisted(() => ({ loadSiteArtifacts: vi.fn() }))

vi.mock('../../src/db/marketing-assets', () => ({
  loadSiteArtifacts: db.loadSiteArtifacts,
}))
```

Rename the seven `db.listMarketingArtifacts` references (`:61`, `:179`, `:188`, `:194`, `:200`, `:208`, `:219`, `:232`, `:243`) and add one case that is R1 at unit level:

```ts
it('uploads the picture as its own part, under the hash the approval signed', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x7f])
  const DOC = '44444444-4444-4444-8444-444444444444'
  const stored = [
    { id: 'a1', kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' },
    { id: 'a2', kind: 'image', textContent: null, documentId: DOC, title: 'hero', mime: 'image/png', bytes: png },
  ]
  db.loadSiteArtifacts.mockResolvedValue(stored)
  const approved = siteHashOf(resolveSite('physio', stored))
  const uploaded = stubUpload()
  const { makePublishPageAdapter } = await import('@/marketing/page-host')
  const deployed = await makePublishPageAdapter(CONFIG).execute(
    { action: 'publish_page', payload: { bundleId: BUNDLE, slug: 'physio', siteHash: approved } },
    { tenantId: TENANT },
  )
  expect(deployed.fileCount).toBe(2)
  const form = (uploaded.mock.calls[0]![1]!.body as FormData)
  const manifest = JSON.parse(formText(form, 'manifest')) as Record<string, string>
  const assetPath = `physio/assets/${DOC}.png`
  expect(manifest[assetPath]).toBeDefined()
  const part = form.get(manifest[assetPath]!) as Blob
  expect(part.type).toBe('image/png')
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(png)
})
```

`buildUploadForm`'s existing cases in this file already prove the text half of the content-type change (Task 1 asserted it); this one proves the read that gets the bytes here in the first place.

- [ ] **Step 7: Run everything the four sites touch**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/outbox.test.ts tests/marketing/page-host.test.ts tests/db/marketing-commit.test.ts tests/db/marketing.test.ts tests/marketing/publish-drain.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. `tests/db/marketing-commit.test.ts` needs no fixture edit: its `clientWith` (`:96-108`) answers `FROM marketing_artifacts` and returns `[]` for anything else, and none of its pages carries a placeholder, so the byte read never fires. `tests/mastra/marketing-write-tools.test.ts` runs green at this point too — every fixture there has a placeholder-free page. Run it anyway and say in your report that you did, because Step 5 changed the read that file stubs.

- [ ] **Step 8: Commit**

```bash
cd D:/Code/CRUM
git add src/db/marketing.ts src/marketing/outbox.ts src/marketing/page-host.ts src/mastra/tools/marketing-writes.ts tests/marketing/outbox.test.ts tests/marketing/page-host.test.ts
git commit -m "feat(marketing): one loader resolves the site hash at all four approval sites"
```

---

### Task 6: `marketing.stage_bundle` refuses an unresolvable page and reports the dead pictures

Spec section 5.5's table only means something if the stage tool asks the question. Every asset problem is a conversation cost at stage time and a wasted review at approval time, which is why spec section 12's table puts all five at `siteProblem`, "before the stage draft exists".

**Files:**
- Modify: `src/mastra/tools/marketing-writes.ts:42` (import), `:305-312` (`StageOutputSchema`), `:436-496` (the refusal chain), the success return after `:498`
- Test: `tests/mastra/marketing-write-tools.test.ts`

**Interfaces:**
- Consumes: Task 3's `siteProblem` and `unreferencedAssetNames`, Task 5's loader-backed `artifacts`.
- Produces: `StageOutputSchema` gains `assetsUnreferenced: z.array(z.string()).optional()` (optional because the schema is shared with two tools that never produce it). Task 13 does not read it; the funnel builder and the walkthrough report do. It also produces the guard that keeps `deriveActions` from throwing an `AssetProblemError` inside the agent turn.

- [ ] **Step 1: Write the failing tests**

Add to the stage describe block. `artifactRow` and `stubQueries` are the file's own helpers (`:61`, `:175`); `artifactRow` takes overrides, so an image row is `artifactRow({ id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png' })` — SQL-shaped keys, because after Task 5 the loader maps them.

```ts
it('refuses a page that names a picture the bundle does not have', async () => {
  stubQueries({
    'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
    'FROM marketing_artifacts': [artifactRow({ text_content: '<img src="{{ASSET:hero}}">' })],
    'INSERT INTO human_tasks': [{ id: '66666466-6666-4666-8666-666666666666' }],
  })
  const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
  expect(result).toMatchObject({ proceed: false })
  expect(String(result.reason)).toContain('asset_name_missing')
  expect(String(result.reason)).toContain('hero')
  expect(call('INSERT INTO pending_writes')).toBeUndefined()
})

it('refuses two pictures that answer one placeholder', async () => {
  stubQueries({
    // First, because `listImageAssetStatuses`'s SQL contains both fragments below
    // and `stubQueries` answers from the first match in insertion order and throws
    // on a query nothing matches. Both pictures are `ready` so the only thing that
    // can refuse this bundle is the ambiguity: with the statuses left out of the
    // fixture the unreviewed arm has an answer too, and the case no longer shows
    // which arm the chain reached first.
    'JOIN documents d': [
      { document_id: DOCUMENT_ID, title: 'hero', status: 'ready', kind: 'marketing_asset' },
      { document_id: '88888888-8888-4888-8888-888888888888', title: 'hero', status: 'ready', kind: 'marketing_asset' },
    ],
    'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
    'FROM marketing_artifacts': [
      artifactRow({ text_content: '<img src="{{ASSET:hero}}">' }),
      artifactRow({ id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png' }),
      artifactRow({ id: 'a3', kind: 'image', text_content: null, document_id: '88888888-8888-4888-8888-888888888888', title: 'hero', mime: 'image/png' }),
    ],
    // The page references `hero`, so the loader asks for the bytes of both
    // candidates before `resolveAssets` gets to refuse the choice.
    'FROM document_files': [
      { document_id: DOCUMENT_ID, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x09]) },
      { document_id: '88888888-8888-4888-8888-888888888888', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a]) },
    ],
    'INSERT INTO human_tasks': [{ id: '66666466-6666-4666-8666-666666666666' }],
  })
  const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
  expect(String(result.reason)).toContain('asset_name_ambiguous')
})

it('stages a page whose picture resolves, and records the picture in the hash', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x09])
  const stored = [
    { id: 'a1', kind: 'page_html', text_content: '<img src="{{ASSET:hero}}">' },
    { id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png' },
  ]
  stubQueries({
    // First, for the same reason as the case above, and `ready` because this bundle
    // is meant to stage: the unreviewed arm is the one thing standing between a
    // fixture and the hash assertion below.
    'JOIN documents d': [{ document_id: DOCUMENT_ID, title: 'hero', status: 'ready', kind: 'marketing_asset' }],
    'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
    'FROM marketing_artifacts': stored,
    'FROM document_files': [{ document_id: DOCUMENT_ID, data: png }],
    'INSERT INTO pending_writes': [pendingWriteRow()],
    'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
  })
  const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
  const resolved = [
    { id: 'a1', kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' },
    { id: 'a2', kind: 'image', textContent: null, documentId: DOCUMENT_ID, title: 'hero', mime: 'image/png', bytes: png },
  ]
  expect(stagedInsert()['siteHash']).toBe(siteHashOf(resolveSite('free-scan', resolved)))
  expect(result.message).toContain('free-scan')
})

it('reports a picture no page references without refusing the stage', async () => {
  stubQueries({
    // `listImageAssetStatuses` is reached because the bundle has an image, and the
    // picture has to be reviewed or the unreviewed arm refuses first. It sits first
    // because its SQL also contains the artifacts fragment below.
    'JOIN documents d': [{ document_id: DOCUMENT_ID, title: 'hero', status: 'ready', kind: 'marketing_asset' }],
    'FROM marketing_bundles': [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, objective: 'inbound_leads' })],
    'FROM marketing_artifacts': [
      artifactRow(),
      artifactRow({ id: 'a2', kind: 'image', text_content: null, document_id: DOCUMENT_ID, title: 'hero', mime: 'image/png', status: 'active' }),
    ],
    'INSERT INTO pending_writes': [pendingWriteRow()],
    'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
  })
  const result = await stage({ bundleId: BUNDLE_ID, requestedCeilingMinor: 2500 })
  expect(result.proceed).toBeUndefined()
  expect(result.assetsUnreferenced).toEqual(['hero'])
  expect(result.message).toContain('1 image(s) are not referenced by any page and will not be published: hero')
})
```

Assert `result.proceed` with `toBeUndefined()` rather than `toMatchObject({ proceed: undefined })`.
Vitest's `toMatchObject` requires the key to exist, so the object assertion can only be satisfied by
adding an explicit `proceed: undefined` to the tool's success return — a production shape change,
asymmetric with the refusal branch's `proceed: false`, made to please a test rather than a
consumer. `toBeUndefined()` passes whether or not the key is present, so the success return keeps
its shape, and `toEqual(['hero'])` says exactly what the field must hold. The third line is what
keeps Step 3's sentence honest: a mandated message nobody asserts can regress silently, and this
case stages a bundle whose `hero` no page places, so the assertion costs one line and fails the
moment the sentence is dropped or its count changes.

The last case's `'JOIN documents d'` handler sits first in its object on purpose, the way the
file's existing fixtures do it at `:774-777`: `stubQueries` answers from the first fragment, in
insertion order, that appears in the SQL, and `listImageAssetStatuses` is the only query the
loader does not issue that contains it. That is also the reason Task 4 gave the loader's join the
alias `k`. A fixture that puts the artifacts fragment first answers the status read with artifact
rows, and `stubQueries` throws on a query nothing matches, so a missing `FROM document_files`
entry on a page that references a picture is a thrown `unexpected query`, not a quiet empty.
Cases two and three above therefore carry both reads.

`tests/mastra/marketing-write-tools.test.ts` does not yet import the resolver, so add
`import { resolveSite, siteHashOf } from '@/marketing/site'` to its import block for case three.

`StageResult` (`:188-195`) gains `assetsUnreferenced?: string[]`.

- [ ] **Step 2: Ask the asset question before anything derives from the page**

`src/mastra/tools/marketing-writes.ts:42` gains `siteProblem` and `unreferencedAssetNames` to the existing `SlugProblemError, slugProblem` import.

`slotIssue` is already declared at `:437`, so do not write a second `const slotIssue`. What this
step does is move that declaration, and add the asset question beside it, to ABOVE the
`deriveActions` call now at `:435`, and widen that call's guard:

```ts
      const slotIssue = slotProblemCheck(artifacts)
      // `siteProblem` asks the slot question first, so with a clean slot anything
      // it returns is an asset sentence: a name with no picture, two pictures with
      // one name, bytes that are not there, a mime with no extension, a page over
      // a ceiling. Stage is the cheapest place any of them can be answered, and a
      // human task is how the answer reaches the person who can change the page.
      const assetIssue = slotIssue === null ? siteProblem(artifacts) : null
      // Nothing is derived for a bundle whose page cannot be placed. `deriveActions`
      // calls `resolveSite`, which throws `SlugProblemError` on an unusable slug and
      // `AssetProblemError` on a placeholder that resolves to nothing or to two
      // pictures, and a throw inside an agent turn is not a refusal a human can act
      // on — the queue entry below is. Both questions are answered above, before this
      // call, precisely so that neither throw has to be caught.
      const actions =
        slugIssue === null && assetIssue === null ? deriveActions(bundle, artifacts) : []
      const blocked = blockedActions(actions)
```

The ordering matters more than the wording. Without it the first two cases in Step 1 never reach
a refusal at all: `deriveActions` at `:435` runs before any asset predicate exists, and
`resolveSite` inside it throws `AssetProblemError` (`src/marketing/outbox.ts:124-133` guards the
slot with `slotProblem` and then calls `resolveSite`), so `await stage(…)` rejects instead of
returning `{ proceed: false }`. That is the residual the Task 5 review named, and this task owns
it. Do not solve it with a `try`/`catch` around `deriveActions`; the predicate is the answer, and
the chain's stated rule is that each arm is a cheaper question than the next.

Insert one arm after the slot arm in the chain at `:457-472`, before `blocked`:

```ts
          : assetIssue !== null
            ? `unresolvable page asset: ${assetIssue}`
```

The arm goes there because the chain's stated rule is "each is a cheaper question than the next", and this one is in-memory on rows already loaded. It also goes before the `unreviewedTitles` arm deliberately: an unreviewed picture that the page cannot even resolve is a page problem first, and the reviewer should be told the placeholder is wrong before being told to look at the picture. Case two in Step 1 is written with both pictures `ready` so that assertion is the one that holds.

Step 1's first case also updates the comment it passes: the four-refusals paragraph above
`unreadPlanColumns` and the "one read, three uses" paragraph both describe the old order, and the
sentence beginning "Nothing is derived" moves with the code it documents.

- [ ] **Step 3: Report the unreferenced pictures**

`StageOutputSchema` (`:305-312`) gains:

```ts
  assetsUnreferenced: z.array(z.string()).optional(),
```

Optional, not required, and for a reason the schema itself states: `StageOutputSchema` is shared
by three tools — `marketing.stage_bundle` (`:330`), `marketing.promote_bundle` (`:917`) and
`marketing.retry_publish` (`:990`) — and the latter two run with `outputValidation: 'warn'`. A
required field the stage refusal path does not answer, and that the other two tools never produce,
would put a validation warning on every promote and retry output for the rest of this branch's
life. `proceed` and `reason` are already `.optional()` in this same object for exactly this
reason, and Step 1's `StageResult` declares `assetsUnreferenced?: string[]`. The stage tool's
success return always populates it, which is what the case above asserts.

and the success return (`:498` onward, beside `artifactCount`) gains:

```ts
        // Paid for, reviewed, and placed nowhere. Publishing it would put bytes on
        // a public host that no reviewer positioned, so `resolveSite` leaves it out
        // and this is the sentence that tells the funnel builder to place it.
        assetsUnreferenced: unreferencedAssetNames(artifacts),
```

Append to the success message when the list is non-empty, in the same sentence style the message already uses:

```ts
        `Bundle staged (${bundle.id}). ${unreferenced.length > 0 ? `${unreferenced.length} image(s) are not referenced by any page and will not be published: ${unreferenced.join(', ')}. ` : ''}A human approval is queued.`
```

Compute `const unreferenced = unreferencedAssetNames(artifacts)` once and use it in both places. It is not added to the staged payload: `tests/governance/marketing-payload.test.ts` sweeps prose out of payloads, and an image title is prose an agent wrote.

Two corrections to the snippet above, both from the review of this task's first pass. The
skeleton it replaces (`Bundle … staged for approval (…). Approving this queues a publish of the
page <slug>. <n> asset(s) … ceiling … minor units`) is what the existing assertions in
`tests/mastra/marketing-write-tools.test.ts` are pinned to — `'3 asset(s)'` and the ceiling
sentence are verbatim there — and case three above asserts `toContain('free-scan')`, which the
snippet's form can never produce because a bundle id is a uuid and the counts are numbers. So do
not swap the skeleton for the snippet: insert the snippet's unreferenced clause into the existing
message where it reads naturally, and keep the slug sentence the skeleton already carries. The
clause itself is verbatim. Second: nothing in this task adds `proceed` to the success return. If
`assetsUnreferenced` is the only new key, it is the only new key.

- [ ] **Step 4: Run the tests**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/marketing-write-tools.test.ts tests/marketing/site.test.ts tests/governance/marketing-payload.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. If a pre-existing stage fixture now trips the asset arm, it is because its page contains the literal `{{ASSET:` text; that is the `asset_unresolved` case working, not a fixture to weaken.

- [ ] **Step 5: Commit**

```bash
cd D:/Code/CRUM
git add src/mastra/tools/marketing-writes.ts tests/mastra/marketing-write-tools.test.ts
git commit -m "feat(marketing): stage refuses an unresolvable page and names the pictures it will not publish"
```

---

### Task 7: Integration proof 1, the picture is on the page the host received

Everything above is unit-provable, and the claim that matters is not unit-provable: that a bundle built by the real tools, approved by the real approval and drained by the real drainer uploads a PNG whose bytes are the ones the hash covered. Spec section 13 puts this file at `tests/integration/marketing-asset-page.test.ts`, on the local pages stand-in, so nothing leaves the machine.

**Files:**
- Create: `tests/integration/marketing-asset-page.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6, plus `saveBundleTool`, `generateAssetsTool` and `stageBundleTool` as they exist after Task 6; `drainOnce` from `scripts/publish-drain.ts`.
- Produces: nothing later tasks depend on. This file is the evidence Task 19 quotes.

- [ ] **Step 1: Write the test**

Copy the harness shape from `tests/integration/marketing-publish.test.ts:25-109` (`describe.skipIf(!url)`, `process.env.DATABASE_URL = url`, `new Pool`, `migrate(pool)`, `DELETE FROM marketing_bundles WHERE tenant_id = $1`, the 127.0.0.1 `createServer` captured on `listen(0)`) and the stub adapter from `tests/integration/marketing-generate-assets.test.ts:41-70`. Two differences are load-bearing. The stand-in must keep the body as a `Buffer`, not a `utf8` string, because a PNG through `toString('utf8')` is not a PNG any more:

```ts
interface Captured { branch: string; manifest: string; body: Buffer }
const captured: Captured[] = []

fake = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    captured.push({
      branch: fieldOf(body.toString('latin1'), 'branch'),
      manifest: fieldOf(body.toString('latin1'), 'manifest'),
      body,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      result: { id: `dep-${captured.length}`, url: `https://dep-${captured.length}.example.pages.dev`, created_on: '2026-11-02T00:00:00Z' },
    }))
  })
})
```

`latin1` is what makes `fieldOf`'s existing regex work on a body that contains binary bytes; say that in a comment beside it, because the next reader will otherwise "fix" it back to `utf8`.

The one test:

```ts
it('publishes the generated picture inside the hash the approval signed', async () => {
  const db = getDbClient()
  const unregisterPublish = registerActionAdapter(makePublishPageAdapter(config))
  const unregisterPromote = registerActionAdapter(makePromotePageAdapter(config))
  try {
    setImageAdapter(stubAdapter())
    // A page that names the picture the designer has not generated yet: this is
    // the order the tools actually run in, and the reason the handle is a title.
    const saved = await saveBundleTool.execute({
      ...bundleInput(),
      funnelPlan: { page: { slug: 'physio-picture' } },
      artifacts: [{ role: 'funnel-builder', kind: 'page_html', textContent: '<h1>Book in</h1><img src="{{ASSET:hero}}" alt="Clinic">' }],
    }, context)
    const bundleId = saved.bundleId as string

    await generateAssetsTool.execute({ bundleId, briefOnly: false }, context)
    // The generator writes the document as `needs_review`, and stage refuses on
    // that, so the human flip is part of this path rather than a fixture.
    await db.query(`UPDATE documents SET status = 'ready' WHERE tenant_id = $1 AND kind = 'marketing_asset'`, [TENANT])
    const staged = await stageBundleTool.execute({ bundleId, requestedCeilingMinor: 2500 }, context)
    expect(staged.message).toContain('physio-picture')

    const stageDraft = await getPendingWrite(staged.pendingWriteId, TENANT)
    const stageHash = String((stageDraft!.payload as Record<string, unknown>)['siteHash'])

    // One page, four readers. Sites two and four below are the point of Task 5.
    const viaCurrentSiteHash = await currentSiteHash(TENANT, bundleId)
    expect(viaCurrentSiteHash).toBe(stageHash)

    await commitBundleApproval(db, { tenantId: TENANT, bundleId, receiptId: null, expectedSiteHash: stageHash })
    const drained = await drainOnce({ bundleId })
    expect(drained.succeeded).toBe(1)

    const row = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM marketing_actions WHERE bundle_id = $1 AND action = 'publish_page'`,
      [bundleId],
    )
    const files = await readSiteFiles(
      { action: 'publish_page', payload: row.rows[0]!.payload } as never,
      TENANT,
    )
    expect(siteHashOf(files)).toBe(stageHash)
    const asset = files.find((f) => f.contentType === 'image/png')
    expect(asset?.path).toMatch(/^physio-picture\/assets\/[0-9a-f-]{36}\.png$/)
    expect(asset?.content).toEqual(PNG_A)

    const upload = captured.at(-1)!
    const manifest = JSON.parse(upload.manifest) as Record<string, string>
    expect(Object.keys(manifest)).toHaveLength(2)
    expect(manifest[asset!.path]).toBe(asset!.sha256)
    // The bytes on the wire are the bytes the hash names, and the part is labelled
    // as a picture. A page whose manifest lied about its picture is the failure
    // this slice exists to remove.
    expect(upload.body.subarray(upload.body.indexOf(PNG_A), upload.body.indexOf(PNG_A) + PNG_A.length)).toEqual(PNG_A)
    expect(upload.body.toString('latin1')).toContain('Content-Type: image/png')
    expect(upload.branch).toBe('crum-preview/physio-picture')
  } finally {
    unregisterPublish()
    unregisterPromote()
  }
})
```

`bundleInput`, `context`, `TENANT` and the uuid literals come from the two files named above; use a fresh tenant uuid that no other integration file claims, the way `marketing-publish.test.ts:29` reserves `…028` and `marketing-generate-assets.test.ts:24` reserves `…021`. The stub adapter returns one PNG per prompt, so this bundle's single asset is `PNG_A`.

- [ ] **Step 2: Run it**

```bash
cd D:/Code/CRUM
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run tests/integration/marketing-asset-page.test.ts
```

Expected: PASS, with the file named in your report. If `CRUM_INTEGRATION_DATABASE_URL` is unset the suite skips and the task is not done; a skipped file is not a pass, and the Integration cluster section above says how to bring the cluster up.

- [ ] **Step 3: Commit**

```bash
cd D:/Code/CRUM
git add tests/integration/marketing-asset-page.test.ts
git commit -m "test(marketing): a generated picture reaches the wire inside the approved hash"
```

---

## S5b. The two ceilings and the provider registry (R3, R4)

### Task 8: Migration 0022 and the bundle's side of the ledger

The ledger already knows the tenant and the day. It does not know which bundle the money was for, so no per-bundle ceiling can be computed, which is why R3 lands second and third rather than being one task: this task makes the rows attributable, and Task 9 spends the attribution.

**Files:**
- Create: `migrations/0022_crum_marketing_assets_reachable.sql`
- Modify: `src/marketing/image-spend.ts:45-59` (`committedSpendMinor`), `:72-104` (`recordImageSpend`)
- Modify: `src/mastra/tools/marketing-writes.ts:1348-1363`, `:1419-1429`, `:1450-1460` (the three `recordImageSpend` calls)
- Test: `tests/marketing/image-spend.test.ts`, `tests/integration/marketing-image-spend.test.ts`

**Interfaces:**
- Consumes: nothing from S5a.
- Produces: `recordImageSpend(params: { tenantId, bundleId: string | null, documentId, costMinor, provider?, rawExtract? })` and `committedBundleSpendMinor(tenantId: string, bundleId: string): Promise<number>`. Task 9 calls the second and passes `bundleId` at all three call sites.

- [ ] **Step 1: Write the migration**

`migrations/0022_crum_marketing_assets_reachable.sql`, in the voice of `migrations/0018_crum_marketing.sql` (a sentence about why the column exists, not what it is called):

```sql
-- Slice 5 R3: the spend ledger learns which bundle the money was for.
--
-- The day ceiling has guarded this account since slice 4, and it does its job on
-- the invoice. It cannot stop one runaway loop on one bundle, because a bundle
-- that has already had forty images paid for still fits inside a $20 day and gets
-- forty more tomorrow. Answering that question needs an attribution the rows do
-- not carry today.
--
-- Nullable, and with no backfill: the rows written before this migration cannot be
-- attributed honestly, and inventing a bundle id for them would make a lifetime
-- ceiling read a number nobody paid. A NULL bundle contributes to the tenant's day
-- and to nothing else, which is the truth rather than a gap in the arithmetic.
ALTER TABLE marketing_image_spend ADD COLUMN IF NOT EXISTS bundle_id uuid;

CREATE INDEX IF NOT EXISTS idx_marketing_image_spend_tenant_bundle
  ON marketing_image_spend (tenant_id, bundle_id)
  WHERE bundle_id IS NOT NULL;
```

No `FOREIGN KEY`, and say why in the file: `tenant_id` and `document_id` on this table carry none (`migrations/0021_crum_marketing_assets.sql:32,36`), because a ledger row must outlive the thing it invoices. The partial index matches the query Task 9 writes, which always names a bundle.

- [ ] **Step 2: Write the failing tests**

In `tests/marketing/image-spend.test.ts`, follow that file's existing `getDbClient` stub shape:

```ts
it('writes the bundle the money was spent on, as a named parameter', async () => {
  await recordImageSpend({ tenantId: TENANT, bundleId: BUNDLE, documentId: DOC, costMinor: 4 })
  const [sql, params] = lastQuery()
  expect(sql).toContain('bundle_id')
  expect(params).toEqual([TENANT, BUNDLE, DOC, 'replicate', 4, null])
})

it('sums one bundle over every day, and does not touch the day window', async () => {
  await committedBundleSpendMinor(TENANT, BUNDLE)
  const [sql, params] = lastQuery()
  expect(sql).not.toContain('spent_on')
  expect(params).toEqual([TENANT, BUNDLE])
  // The sibling read keeps its own window, because a ceiling that quietly changes
  // the window it was tested against stops being the tenant's day ceiling.
  await committedSpendMinor(TENANT)
  expect(lastQuery()[0]).toContain('spent_on = CURRENT_DATE')
})

it('fails closed on an unreadable bundle total, the same way the day total does', async () => {
  respondWith({ rows: [{ total: null }] })
  await expect(committedBundleSpendMinor(TENANT, BUNDLE)).rejects.toThrow(/instead of one non-negative integer total/)
})
```

In `tests/integration/marketing-image-spend.test.ts`, beside the existing "sums only today" case (`:122`):

```ts
it('counts a bundle across days, because the bundle ceiling is lifetime', async () => {
  const tenant = await uniqueTenant()
  const bundle = await unique()
  await recordImageSpend({ tenantId: tenant, bundleId: bundle, documentId: null, costMinor: 7 })
  await pool.query(
    `UPDATE marketing_image_spend SET spent_on = CURRENT_DATE - 30 WHERE tenant_id = $1 AND bundle_id = $2`,
    [tenant, bundle],
  )
  await recordImageSpend({ tenantId: tenant, bundleId: bundle, documentId: null, costMinor: 5 })
  // The backdated row is invisible to the day read and unavoidable for the bundle
  // read: one runaway loop on one bundle is stopped by the bundle ceiling even
  // after the day rolls over.
  expect(await committedBundleSpendMinor(tenant, bundle)).toBe(12)
  expect(await committedSpendMinor(tenant)).toBe(5)
})

it('leaves a NULL bundle out of every bundle total', async () => {
  const tenant = await uniqueTenant()
  await recordImageSpend({ tenantId: tenant, bundleId: null, documentId: null, costMinor: 9 })
  expect(await committedBundleSpendMinor(tenant, await unique())).toBe(0)
})
```

That file's existing `uniqueTenant()` and `unique()` helpers (`:28`, `:33`) hand out fresh uuids, so the cases re-run in any order.

- [ ] **Step 3: Implement the ledger half**

`recordImageSpend` gains a required `bundleId: string | null` as the second key of its params object, and the INSERT becomes `INSERT INTO marketing_image_spend (tenant_id, bundle_id, document_id, provider, cost_minor, raw_extract) VALUES ($1, $2, $3, $4, $5, $6::jsonb)` with `params.bundleId` in the `$2` position. Required rather than optional, on the same principle as the `documentId: string | null` beside it: a caller that has not answered "which bundle" is a caller that should have to write `bundleId: null` and mean it.

Two mechanical consequences, both in this task: the `$5::jsonb` comment at `:83-86` moves to `$6::jsonb` (the naming rule it records is unchanged), and every existing `recordImageSpend` call in `tests/integration/marketing-image-spend.test.ts` (`:52`, `:89`, `:107`, `:125`, and any the file grows after that) gains `bundleId: null` unless the case is about attribution.

Then hoist the fail-closed numeric guard out of `committedSpendMinor` so both reads share one rule:

```ts
/**
 * The one place that decides what a readable ledger total is. Both ceiling reads
 * answer `SUM(cost_minor)`, which node-pg hands back as a string because Postgres
 * widens an integer sum to bigint, and 0 is the answer that admits unlimited
 * spend. So an unreadable total throws rather than defaulting, and there is exactly
 * one function that knows this rule.
 */
function totalMinorOrThrow(rows: { total: string | null }[], label: string): number {
  const total = rows[0]?.total ?? null
  if (total === null || !/^\d+$/.test(String(total))) {
    throw new Error(
      `marketing_image_spend: the ${label} read answered ${JSON.stringify(rows)} instead of one non-negative integer total`,
    )
  }
  return Number(total)
}

export async function committedSpendMinor(tenantId: string): Promise<number> {
  const result = await getDbClient().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS total
       FROM marketing_image_spend
      WHERE tenant_id = $1 AND spent_on = CURRENT_DATE`,
    [tenantId],
  )
  return totalMinorOrThrow(result.rows, 'daily spend')
}

/**
 * What one bundle has cost, over every day it has ever run. Spec section 7.1: the
 * window is lifetime on purpose, because the job of this number is to stop one
 * runaway loop on one bundle, and a bundle that already had forty images paid for
 * does not deserve forty more tomorrow.
 */
export async function committedBundleSpendMinor(tenantId: string, bundleId: string): Promise<number> {
  const result = await getDbClient().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS total
       FROM marketing_image_spend
      WHERE tenant_id = $1 AND bundle_id = $2`,
    [tenantId, bundleId],
  )
  return totalMinorOrThrow(result.rows, 'bundle spend')
}
```

The `label` in the message is what tells an owner which ceiling is misbehaving, and it is why the guard moved into a function instead of being copied.

- [ ] **Step 4: Attribute the three writes in the tool**

Every `recordImageSpend` call in `marketing.generate_assets` names the bundle it was spent on: `bundleId: bundle.id` at `:1348` (a prediction that produced nothing usable), `:1419` (a document lane that refused), and `:1450` (the ordinary booking). All three already sit inside a branch where `bundle !== null`, so no new guard is needed; if `npm run typecheck` says otherwise, the branch narrowing moved and the fix is to read the surrounding `if`, not to add `bundle?.id ?? null`.

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/image-spend.test.ts
npx vitest run tests/integration/marketing-image-spend.test.ts tests/integration/marketing-assets-migration.test.ts tests/integration/migrations.test.ts
npm run typecheck
npm run lint
```

Expected: the unit run passes, and the integration run passes only with `CRUM_INTEGRATION_DATABASE_URL` exported (see the Integration cluster above). `tests/integration/migrations.test.ts` is the file that proves a fresh database reaches the same shape through `0001…0022` in order, so it must run in this task and be named in your report.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add migrations/0022_crum_marketing_assets_reachable.sql src/marketing/image-spend.ts src/mastra/tools/marketing-writes.ts tests/marketing/image-spend.test.ts tests/integration/marketing-image-spend.test.ts
git commit -m "feat(marketing): the image ledger records the bundle each prediction cost"
```

---

### Task 9: The per-bundle ceiling, checked before the day ceiling

Ruling B, the two-layer model. The order is the spec's (section 7.2): bundle first, because "this bundle is at its cap" tells the owner to revise the creative and "today is spent" tells them to wait for midnight, and the first is the more actionable answer when both are true.

**Files:**
- Modify: `src/config/env.ts:206-209` (after the per-image key)
- Modify: `src/marketing/image-provider.ts:23-39` (`ImageAdapter`, `ReplicateAdapterParams`), `:41-60` (`makeReplicateAdapter`)
- Modify: `src/mastra/index.ts:191-203`
- Modify: `src/mastra/tools/marketing-writes.ts:1279-1336` (both ceiling blocks), `:1496` (the human-task title)
- Test: `tests/marketing/generate-assets-tool.test.ts`, `tests/marketing/image-provider.test.ts` (create if absent; the file does not exist today), `tests/integration/marketing-generate-assets.test.ts`, `tests/config/env.test.ts`

**Interfaces:**
- Consumes: Task 8's `committedBundleSpendMinor` and the `bundleId` the rows now carry.
- Produces: `ImageAdapter.bundleCeilingMinor: number`, refusal token `image_bundle_ceiling_reached`, and the env key `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE`. Task 10's registry stores adapters that already carry this number.

- [ ] **Step 1: The config, with its comment**

`src/config/env.ts`, after `CRUM_IMAGE_COST_MINOR_PER_IMAGE` (`:206-209`):

```ts
  // Minor units, so 200 is $2.00. Lifetime per bundle rather than per day: this
  // number exists to stop one runaway loop on one bundle (spec section 7.1), and at
  // the 4-minor admission estimate above it admits fifty images before a bundle is
  // capped. No campaign page needs fifty, and a bundle that needed forty is a
  // creative problem rather than a budget one.
  CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(10_000_000).default(200),
  ),
```

Add one case to `tests/config/env.test.ts` in that file's existing style: unset answers `200`, `CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE=50` answers `50`, and `=` (blank) answers `200` like every other `blankAsUnset` key.

- [ ] **Step 2: The adapter carries the number**

`ImageAdapter` and `ReplicateAdapterParams` each gain `bundleCeilingMinor: number`, and `makeReplicateAdapter` passes it through beside `ceilingMinor`. Say the reason in the interface comment: `marketing.generate_assets` reads no `process.env` for run bounds (`image-provider.ts:14-17` documents that rule), so a second ceiling is a second field on the adapter rather than a second read in the tool.

Then update every adapter literal, or `npm run typecheck` fails with a missing-property error in each of them:

- `src/mastra/index.ts:191-203` — `bundleCeilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE`.
- `tests/marketing/generate-assets-tool.test.ts:127-133` — the mock adapter gains `bundleCeilingMinor: 200`, and the harness's `ledger(...)` helper grows a second parameter (or a sibling `bundleLedger(...)`) that answers `committedBundleSpendMinor`.
- `tests/integration/marketing-generate-assets.test.ts:41-46` — `stubAdapter` gains `bundleCeilingMinor: 200` and a parameter to override it, the same way its `ceilingMinor` default of 40 is overridden at `:250`.
- `vi.mock('../../src/marketing/image-spend', ...)` in the tool test (`:37-42`) gains `committedBundleSpendMinor: h.committedBundleSpendMinor` in the hoisted object and the factory's override list.

- [ ] **Step 3: Write the failing tests**

In `tests/marketing/generate-assets-tool.test.ts`:

```ts
it('refuses on the bundle ceiling before it mentions the day', async () => {
  h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
  dayLedger(0)
  bundleLedger(195)
  const result = await run({ bundleId: BUNDLE })
  expect(result.refused.map((r) => r.code)).toEqual([
    'image_bundle_ceiling_reached',
    'image_bundle_ceiling_reached',
    'image_bundle_ceiling_reached',
  ])
  expect(h.generate).not.toHaveBeenCalled()
  expect(String(result.refused[0]!.detail)).toContain('CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE')
})

it('reports both ceilings when both bind, because an owner should not have to discover the second one tomorrow', async () => {
  h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
  dayLedger(1990)
  bundleLedger(195)
  const result = await run({ bundleId: BUNDLE })
  const codes = result.refused.map((r) => r.code)
  expect(codes).toContain('image_bundle_ceiling_reached')
  expect(codes).toContain('image_spend_ceiling_reached')
  // Three assets, six refusal lines, and a title that says three. The line count
  // is what `refusedProse` needs to tell the owner what is missing; the asset count
  // is what a human task title must claim.
  const [task] = h.createHumanTask.mock.calls[0] as [{ title: string }]
  expect(task.title).toContain('refused 3 asset(s)')
  expect(result.refused).toHaveLength(6)
})

it('stops at the bundle boundary mid-run, after the provider actually charged past the estimate', async () => {
  h.getDesignerArtifactText.mockResolvedValue(promptJson('a', 'b', 'c'))
  dayLedger(0)
  bundleLedger(190)
  h.generate.mockResolvedValueOnce(okImage('a', 12)).mockResolvedValue(okImage('b'))
  const result = await run({ bundleId: BUNDLE })
  expect(result.assets.map((asset) => asset.name)).toEqual(['a'])
  expect(result.refused.map((r) => [r.name, r.code])).toEqual([
    ['b', 'image_bundle_ceiling_reached'],
    ['c', 'image_bundle_ceiling_reached'],
  ])
})

it('attributes every spend row to the bundle, including the ones with nothing to show', async () => {
  h.getDesignerArtifactText.mockResolvedValue(promptJson('a'))
  h.generate.mockResolvedValue(failedPrediction(4))
  await run({ bundleId: BUNDLE })
  expect(h.recordImageSpend.mock.calls[0]![0]).toMatchObject({ bundleId: BUNDLE, documentId: null })
})
```

`dayLedger(n)` and `bundleLedger(n)` are the two mocks of `committedSpendMinor` and `committedBundleSpendMinor`; the file's existing `ledger(n)` helper (`:190`) becomes `dayLedger` by rename, and every call in the file follows. `failedPrediction(costMinor)` is the existing failure-shaped helper in that file; if it does not exist, build it from the `okImage` helper's counterpart the file already uses for a charged-but-unusable outcome.

In `tests/integration/marketing-generate-assets.test.ts`, add the case that the unit suite structurally cannot prove, on real rows:

```ts
it('caps a bundle on its own ledger, while the tenant still has a full day of headroom', async () => {
  setImageAdapter(stubAdapter(2000, 12))
  const saved = await saveBundleTool.execute(bundleInput(), context)
  const bundleId = saved.bundleId as string
  const first = await generateAssetsTool.execute({ bundleId }, context)
  expect(first.refused).toHaveLength(0)
  // Same tenant, same day, second bundle: the day ceiling has room, so the only
  // thing that can stop this run is the bundle it belongs to.
  const other = await saveBundleTool.execute(bundleInput(), context)
  const second = await generateAssetsTool.execute({ bundleId: other.bundleId as string }, context)
  expect(second.refused).toHaveLength(0)
  // A re-run on the first bundle carries its existing assets, so it costs nothing.
  // What costs is a third bundle pushed past a 12-minor bundle cap by rows that
  // exist: attribute them directly, because the point of this file is the ledger.
  await pool.query(
    `UPDATE marketing_image_spend SET bundle_id = $2 WHERE tenant_id = $1`,
    [TENANT, bundleId],
  )
  const capRow = await pool.query<{ cost_minor: string }>(
    `SELECT cost_minor FROM marketing_image_spend WHERE tenant_id = $1 AND bundle_id = $2`,
    [TENANT, bundleId],
  )
  expect(Number(capRow.rows[0]!.cost_minor)).toBeGreaterThan(0)
  expect(await committedBundleSpendMinor(TENANT, bundleId)).toBeGreaterThan(0)
  expect(await committedBundleSpendMinor(TENANT, (other.bundleId as string))).toBe(0)
})
```

`stubAdapter(ceilingMinor, bundleCeilingMinor)` is Task 8's helper widened with the second parameter and passed through, defaulting to `200`.

- [ ] **Step 4: Ask bundle first, then day, in both places**

Replace the pre-flight block at `marketing-writes.ts:1279-1309` with:

```ts
      let committedMinor = 0
      let bundleCommittedMinor = 0
      if (refused.length === 0 && pending.length > 0 && adapter !== null) {
        committedMinor = await committedSpendMinor(rc.tenantId)
        bundleCommittedMinor = await committedBundleSpendMinor(rc.tenantId, bundle.id)
        const admission = { costMinorPerImage: adapter.costMinorPerImage, assetCount: pending.length }
        const bundleBinds = !admitsRun({
          ceilingMinor: adapter.bundleCeilingMinor,
          committedMinor: bundleCommittedMinor,
          ...admission,
        })
        const dayBinds = !admitsRun({
          ceilingMinor: adapter.ceilingMinor,
          committedMinor,
          ...admission,
        })
        // Bundle first, then day, and both when both bind (spec section 7.2). The
        // order is the actionable one: a bundle at its cap is a creative problem
        // the owner can fix now, and a day at its cap is a wait. Reporting only the
        // first would have them discover the second tomorrow morning.
        if (bundleBinds) {
          for (const entry of pending) {
            refused.push({
              name: entry.name,
              code: 'image_bundle_ceiling_reached',
              detail:
                `Not attempted: bundle ${bundle.id} has cost ${bundleCommittedMinor} minor of a ${adapter.bundleCeilingMinor} ` +
                `lifetime ceiling, and ${pending.length} asset(s) at ${adapter.costMinorPerImage} minor each need ${estimatedCostMinor}. ` +
                'Raise CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE or attach fewer pictures. Nothing was requested.',
            })
          }
        }
        if (dayBinds) {
          for (const entry of pending) {
            refused.push({
              name: entry.name,
              code: 'image_spend_ceiling_reached',
              detail:
                `Not attempted: today's image spend is ${committedMinor} minor with a ${adapter.ceilingMinor} ceiling, ` +
                `and ${pending.length} asset(s) at ${adapter.costMinorPerImage} minor each need ${estimatedCostMinor}. ` +
                'Raise CRUM_IMAGE_SPEND_CEILING_MINOR or run tomorrow. Nothing was requested.',
            })
          }
        }
      }
```

The day sentence keeps its existing wording exactly, because `tests/marketing/generate-assets-tool.test.ts` and the slice-4 verification report both quote it.

The mid-loop block (`:1313-1336`) grows the same pair, with `assetCount: 1`:

```ts
          const nowCommitted = await committedSpendMinor(rc.tenantId)
          const nowBundleCommitted = await committedBundleSpendMinor(rc.tenantId, bundle.id)
          const admission = { costMinorPerImage: adapter.costMinorPerImage, assetCount: 1 }
          const stops = (
            !admitsRun({ ceilingMinor: adapter.bundleCeilingMinor, committedMinor: nowBundleCommitted, ...admission })
              ? [['image_bundle_ceiling_reached',
                  `Not attempted: this bundle reached ${nowBundleCommitted} of a ${adapter.bundleCeilingMinor} minor lifetime ceiling.`] as const]
              : []
          ).concat(
            !admitsRun({ ceilingMinor: adapter.ceilingMinor, committedMinor: nowCommitted, ...admission })
              ? [['image_spend_ceiling_reached',
                  `Not attempted: today's spend reached ${nowCommitted} of a ${adapter.ceilingMinor} minor ceiling.`] as const]
              : [],
          )
          if (stops.length > 0) {
            for (const stopped of pending.slice(index)) {
              for (const [code, detail] of stops) {
                refused.push({ name: stopped.name, code, detail })
              }
            }
            break
          }
```

The day boundary's existing comment (`:1324-1327`, "the boundary moved under the run") stays and covers both ceilings.

Then the title at `:1496` counts assets rather than lines:

```ts
          // Distinct names, because a refusal that binds both ceilings writes two
          // lines for one asset and a human task that claims "6 asset(s)" when the
          // bundle is missing three is a task nobody trusts. `refused.length` is
          // still what `refusedProse` walks, so nothing is hidden from the body.
          title: `Image run for bundle ${bundle.id} refused ${new Set(refused.map((entry) => entry.name)).size} asset(s)`,
```

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/generate-assets-tool.test.ts tests/marketing/image-spend.test.ts tests/config/env.test.ts
npx vitest run tests/integration/marketing-generate-assets.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. Existing ceiling cases stay green because none of them sets a bundle total above zero: the harness's new `bundleLedger` defaults to `0`, so `image_spend_ceiling_reached` alone binds in them, which is what the rename in Step 3 makes explicit rather than accidental.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/config/env.ts src/marketing/image-provider.ts src/mastra/index.ts src/mastra/tools/marketing-writes.ts tests/marketing/generate-assets-tool.test.ts tests/config/env.test.ts tests/integration/marketing-generate-assets.test.ts
git commit -m "feat(marketing): a per-bundle lifetime ceiling, checked before the tenant day"
```

---

### Task 10: A named image-provider registry, selected by config, with no fallback

Ruling A. One slot that the boot overwrites becomes a keyed registry, and nothing about a failure ever causes a second provider to be charged. The registry's job in this slice is to make adding a provider a registration and an env default instead of a refactor, which is spec section 8.2's stated non-goal of shipping a second one.

**Files:**
- Modify: `src/marketing/image-provider.ts:62-78` (the slot becomes the registry)
- Modify: `src/config/env.ts:195` (after `CRUM_REPLICATE_MODEL`)
- Modify: `src/mastra/index.ts:42` (import), `:186-207` (registration block)
- Modify: `src/mastra/tools/marketing-writes.ts:50` (import), `:1068` (the doc comment), `:1200-1207` (the pick)
- Test: `tests/marketing/image-provider.test.ts` (new), `tests/marketing/generate-assets-tool.test.ts:45`, `tests/mastra/marketing-boot.test.ts:122-133`, `tests/integration/marketing-generate-assets.test.ts:8,169-173,250,282`

**Interfaces:**
- Consumes: Task 9's `ImageAdapter` shape, unchanged by this task apart from the module that hands it out.
- Produces: `registerImageAdapter(adapter: ImageAdapter): () => void`, `selectImageAdapter(): ImageAdapter | null`, `listImageProviders(): string[]`, `selectedImageProviderName(): string`, `setSelectedImageProvider(name: string): void`, `__imageProviderRegistry`, and refusal token `image_provider_unknown`.

- [ ] **Step 1: Write the failing registry tests**

`tests/marketing/image-provider.test.ts`, new file:

```ts
// tests/marketing/image-provider.test.ts
// The registry is the answer to "which provider does this deployment pay, and what
// happens when it fails". Selection by name and no fallback are the two rules, so
// this file tests exactly those and leaves the Replicate HTTP half to
// tests/marketing/replicate.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import {
  __imageProviderRegistry,
  listImageProviders,
  registerImageAdapter,
  selectImageAdapter,
  selectedImageProviderName,
  setSelectedImageProvider,
  type ImageAdapter,
} from '@/marketing/image-provider'

function fake(provider: string): ImageAdapter {
  return {
    provider,
    model: `${provider}/test`,
    ceilingMinor: 2000,
    bundleCeilingMinor: 200,
    costMinorPerImage: 4,
    maxBytes: 1024,
    generate: () => Promise.reject(new Error('never called: this file tests selection, not generation')),
  }
}

afterEach(() => {
  __imageProviderRegistry.clear()
  setSelectedImageProvider('replicate')
})

describe('the image provider registry', () => {
  it('keys by the adapter name it registers, and hands back an unregister', () => {
    const off = registerImageAdapter(fake('replicate'))
    expect(listImageProviders()).toEqual(['replicate'])
    off()
    expect(listImageProviders()).toEqual([])
  })

  it('selects the one the config names, from among several', () => {
    registerImageAdapter(fake('replicate'))
    registerImageAdapter(fake('openai'))
    setSelectedImageProvider('openai')
    expect(selectImageAdapter()?.provider).toBe('openai')
    expect(listImageProviders()).toEqual(['replicate', 'openai'])
  })

  it('answers null for a name nothing registers, and keeps the other adapter in the registry', () => {
    registerImageAdapter(fake('replicate'))
    setSelectedImageProvider('stability')
    expect(selectImageAdapter()).toBeNull()
    expect(listImageProviders()).toEqual(['replicate'])
  })

  it('defaults to replicate when nothing chose', () => {
    expect(selectedImageProviderName()).toBe('replicate')
  })

  it('overwrites one provider with a second adapter of the same name, because boot runs per request', () => {
    registerImageAdapter(fake('replicate'))
    registerImageAdapter({ ...fake('replicate'), model: 'replicate/second' })
    expect(listImageProviders()).toEqual(['replicate'])
    expect(selectImageAdapter()?.model).toBe('replicate/second')
  })
})
```

The last case is the slice-4 constraint the old comment at `:62-69` recorded (`createCrumMastra` runs per request, so a registration that refused a second write would throw on every request after the first). A `Map.set` keeps that property and the test keeps the comment honest.

- [ ] **Step 2: Write the failing tool tests**

In `tests/marketing/generate-assets-tool.test.ts`, swap the provider mock's shape (`:45`) and the harness object (`:14`), then add:

```ts
vi.mock('../../src/marketing/image-provider', () => ({
  selectImageAdapter: h.selectImageAdapter,
  listImageProviders: h.listImageProviders,
  selectedImageProviderName: h.selectedImageProviderName,
}))
```

```ts
  h.selectImageAdapter.mockReturnValue(null)
  h.listImageProviders.mockReturnValue([])
  h.selectedImageProviderName.mockReturnValue('replicate')
```

```ts
it('refuses with image_provider_not_configured when the registry is empty, which is an absent token', async () => {
  const result = await run({ bundleId: BUNDLE })
  expect(result.refused[0]!.code).toBe('image_provider_not_configured')
  expect(h.generate).not.toHaveBeenCalled()
})

it('refuses with image_provider_unknown when the config names something nothing registered', async () => {
  h.selectImageAdapter.mockReturnValue(null)
  h.listImageProviders.mockReturnValue(['replicate'])
  h.selectedImageProviderName.mockReturnValue('stability')
  const result = await run({ bundleId: BUNDLE })
  expect(result.refused[0]!.code).toBe('image_provider_unknown')
  expect(String(result.refused[0]!.detail)).toContain('stability')
  expect(String(result.refused[0]!.detail)).toContain('replicate')
  expect(h.generate).not.toHaveBeenCalled()
})

it('never charges a second provider for a picture the first one failed to make', async () => {
  // The ruling (option A) in test form: one adapter registered, one failure with a
  // charge, and the run reports the charge with no second attempt. A fallback would
  // make the ceiling arithmetic a lie, because two providers failing one image
  // bill one image twice.
  h.generate.mockResolvedValueOnce(chargedFailure('replicate_down', 4))
  const result = await run({ bundleId: BUNDLE })
  expect(h.generate).toHaveBeenCalledTimes(1)
  expect(h.recordImageSpend).toHaveBeenCalledTimes(1)
  expect(result.refused[0]!.code).toBe('replicate_down')
  expect(result.spentMinor).toBe(4)
})
```

`chargedFailure(code, costMinor)` builds the `ImageOutcome` shape `{ ok: false, code, detail, charge: { predictionId, costUsd, costMinor }, deadToken: false }`; the file already has a helper of that shape for the slice-4 failure cases, and if it is named differently, reuse it rather than adding a twin.

- [ ] **Step 3: Implement the registry**

Replace `src/marketing/image-provider.ts:62-78`:

```ts
/**
 * Providers by name, and exactly one of them selected.
 *
 * `createCrumMastra` runs per request in the Hono lane, so a registration is a
 * `Map.set` and re-setting the same name is expected rather than an error; that is
 * the property the single-slot `setImageAdapter` this replaced also had, and
 * `tests/marketing/image-provider.test.ts` keeps it tested rather than assumed.
 *
 * There is no fallback, and that is a requirement rather than a preference. A
 * provider that fails gets its own error, its own spend row, and no second provider
 * charged: CRUM does not make a purchase decision on the owner's behalf at runtime,
 * the same rule that makes `pageHostConfigFromEnv` refuse a half-configured host and
 * `blockedActions` refuse an action with no adapter. A retry chain would also make
 * the ceiling arithmetic a lie, because two providers failing one image would bill
 * one image twice.
 */
export const __imageProviderRegistry = new Map<string, ImageAdapter>()

export function registerImageAdapter(adapter: ImageAdapter): () => void {
  __imageProviderRegistry.set(adapter.provider, adapter)
  return () => {
    if (__imageProviderRegistry.get(adapter.provider) === adapter) __imageProviderRegistry.delete(adapter.provider)
  }
}

export function listImageProviders(): string[] {
  return [...__imageProviderRegistry.keys()]
}

// The selection lives here, not in the tool: `marketing.generate_assets` reads no
// `process.env` for run bounds (this file's header comment), and which provider this
// deployment pays is a run bound. `src/mastra/index.ts` sets it from `parseEnv` at
// boot, the same moment it registers the adapters.
let selection = 'replicate'

export function setSelectedImageProvider(name: string): void {
  selection = name
}

export function selectedImageProviderName(): string {
  return selection
}

/**
 * The selected adapter, or null when nothing answers that name. Null means two
 * different refusals, and the caller tells them apart with `listImageProviders()`:
 * an empty registry is an install with no credential, and a non-empty one is a
 * credential configured for a provider this build does not know.
 */
export function selectImageAdapter(): ImageAdapter | null {
  return __imageProviderRegistry.get(selection) ?? null
}
```

`setImageAdapter` and `getImageAdapter` are deleted, not deprecated: the four call sites that exist (`src/mastra/index.ts`, `src/mastra/tools/marketing-writes.ts`, `tests/mastra/marketing-boot.test.ts`, `tests/integration/marketing-generate-assets.test.ts`) are all in this task, and a retained alias would be a second door to "last write wins whatever the config says".

- [ ] **Step 4: Config, boot, and the tool's pick**

`src/config/env.ts` after `CRUM_REPLICATE_MODEL` (`:192-195`):

```ts
  // Which registered provider this deployment pays. One name, because a fallback
  // would make the ceiling arithmetic a lie (spec section 8.1). The value is not
  // validated against a list here: the registry is built at boot, and
  // marketing.generate_assets refuses an unknown name with `image_provider_unknown`
  // naming what *is* registered, which is a better message than a boot failure on a
  // spelling.
  CRUM_IMAGE_PROVIDER: z.preprocess(blankAsUnset, z.string().trim().min(1).default('replicate')),
```

`src/mastra/index.ts:186-207` keeps its condition and gains the selection, in this order:

```ts
  const imageToken = env.CRUM_REPLICATE_API_TOKEN
  setSelectedImageProvider(env.CRUM_IMAGE_PROVIDER)
  if (imageToken) {
    registerImageAdapter(
      makeReplicateAdapter({
        apiToken: imageToken,
        model: env.CRUM_REPLICATE_MODEL,
        ceilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR,
        bundleCeilingMinor: env.CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE,
        costMinorPerImage: env.CRUM_IMAGE_COST_MINOR_PER_IMAGE,
        maxBytes: MAX_DOCUMENT_BYTES,
      }),
    )
    logImageLaneOnce(env.CRUM_IMAGE_PROVIDER)
  } else {
    // Nothing to unregister: an install without a credential has no adapter, and
    // selectImageAdapter() answers null for that reason rather than for a spelling.
    logImageLaneOnce('none')
  }
```

The `setImageAdapter(null)` line at `:204` disappears, and with it the comment block above it (`:186-190`) that explains why the null assignment exists. Replace that comment with one that says the registry starts empty and the selection is set whether or not a credential is present, because the refusal message names the selected provider.

`tests/mastra/marketing-boot.test.ts:122-133` moves from `getImageAdapter()` to `selectImageAdapter()` and its assertion at `:124` (`null` with no token) stays; `logImageLaneOnce` is the one line the file may also assert on. `tests/integration/marketing-generate-assets.test.ts:8,169,173,250,282` moves from `setImageAdapter(x)` / `setImageAdapter(null)` to `registerImageAdapter(x)` / `__imageProviderRegistry.clear()`.

`src/mastra/tools/marketing-writes.ts:1200-1207` becomes:

```ts
      const adapter = refused.length === 0 ? selectImageAdapter() : null
      if (refused.length === 0 && adapter === null) {
        const registered = listImageProviders()
        refused.push({
          name: '*',
          code: registered.length === 0 ? 'image_provider_not_configured' : 'image_provider_unknown',
          detail:
            registered.length === 0
              ? 'No image adapter is registered, so this install has no provider credential. Nothing was requested and nothing was spent.'
              : `CRUM_IMAGE_PROVIDER is "${selectedImageProviderName()}", which no adapter answers. Registered: ${registered.join(', ')}. Nothing was requested and nothing was spent.`,
        })
      }
```

The `image_provider_not_configured` sentence drops its reference to `CRUM_REPLICATE_API_TOKEN`, because with a registry that variable is one provider's credential rather than the whole question; name the file's own env key in the comment if the sentence needs a pointer. The doc comment at `:1068` that names `getImageAdapter()` is reworded to `selectImageAdapter()`.

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing/image-provider.test.ts tests/marketing/generate-assets-tool.test.ts tests/mastra/marketing-boot.test.ts
npx vitest run tests/integration/marketing-generate-assets.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. Then prove to yourself that nothing still calls the deleted functions:

```bash
cd D:/Code/CRUM
grep -rn "getImageAdapter\|setImageAdapter" src tests scripts | grep -v "^src/marketing/image-provider.ts"
```

Expected: no output. Anything left is a fifth call site this task did not know about; convert it and say so in your report.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/marketing/image-provider.ts src/config/env.ts src/mastra/index.ts src/mastra/tools/marketing-writes.ts tests/marketing/image-provider.test.ts tests/marketing/generate-assets-tool.test.ts tests/mastra/marketing-boot.test.ts tests/integration/marketing-generate-assets.test.ts
git commit -m "feat(marketing): image providers become a named registry with no fallback"
```

---

## S5c. Invalidation (R2)

### Task 11: `invalidateOpenStageDraft`

Ruling: hard invalidation, and the reason is the prediction gate. A reviewer who wrote a prediction against the old bytes made a statement about a proposal that no longer exists, so the draft dies with it and the bundle goes back to `draft`. There is no stale-but-approvable state, and nothing here re-hashes a draft in place.

**Files:**
- Modify: `src/db/pending-writes.ts` (add the function after `rejectPendingWrite`, `:838-884`)
- Test: `tests/db/open-stage-draft.test.ts`

**Interfaces:**
- Consumes: `pending_writes` and `marketing_bundles` as they exist.
- Produces: `invalidateOpenStageDraft(tenantId: string, bundleId: string, reason: string): Promise<string | null>`, returning the rejected draft id, or null when no approval was waiting. Task 12 calls it from three places.

- [ ] **Step 1: Write the failing tests**

`tests/db/open-stage-draft.test.ts:3-5` stubs the pool without `connect`, and this function needs a transaction, so widen the stub first:

```ts
const mockQuery = vi.fn()
const mockClient = { query: mockQuery, release: vi.fn() }
const mockPool = { query: mockQuery, connect: vi.fn(() => Promise.resolve(mockClient)), end: vi.fn() }
```

Every existing case in that file asserts through `mockQuery`, so nothing else in it moves. Then add:

```ts
describe('invalidateOpenStageDraft', () => {
  it('rejects the open stage draft for this bundle and nothing else', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: String(sql).includes('UPDATE pending_writes') ? [{ id: DRAFT }] : [], rowCount: 1 }),
    )
    const { invalidateOpenStageDraft } = await load()
    expect(await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')).toBe(DRAFT)

    const sql = String(mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE pending_writes'))![0])
    expect(sql).toContain("object_type = 'marketing_stage'")
    expect(sql).toContain('target_id = $2')
    // The two nulls are the whole definition of an open draft, the same ones
    // getOpenStageDraft reads (`:782-785`). A committed approval has a receipt and
    // a refused one already has a reason: neither is this function's to overwrite.
    expect(sql).toContain('receipt_id IS NULL')
    expect(sql).toContain('rejected_at IS NULL')
    expect(sql).toContain('RETURNING id')
    const params = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE pending_writes'))![1] as unknown[]
    expect(params).toEqual([TENANT, BUNDLE, 'assets_changed_after_staging'])
  })

  it('returns the bundle to draft, and only from staged', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: DRAFT }], rowCount: 1 })
    const { invalidateOpenStageDraft } = await load()
    await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')
    const sql = String(mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE marketing_bundles'))![0])
    // `staged` means an approval is waiting. An `approved` or `live` bundle is not
    // walked backwards: its bytes are already published, and the drain-time
    // `site_hash_moved` refusal in page-host.ts is what guards that path.
    expect(sql).toContain("status = 'staged'")
  })

  it('is idempotent: a second invalidation finds no open draft and reports null', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve(String(sql).includes('UPDATE pending_writes') && mockQuery.mock.calls.length === 1
        ? { rows: [{ id: DRAFT }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
    )
    const { invalidateOpenStageDraft } = await load()
    await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await invalidateOpenStageDraft(TENANT, BUNDLE, 'assets_changed_after_staging')).toBeNull()
  })

  it('opens and closes one transaction, and rolls back on a failed write', async () => {
    const release = vi.fn()
    mockClient.release = release
    mockQuery.mockResolvedValue({ rows: [{ id: DRAFT }], rowCount: 1 })
    const { invalidateOpenStageDraft } = await load()
    await invalidateOpenStageDraft(TENANT, BUNDLE, 'reason')
    const verbs = mockQuery.mock.calls.map((c) => String(c[0]).trim())
    expect(verbs[0]).toBe('BEGIN')
    expect(verbs).toContain('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)

    mockQuery.mockReset()
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockRejectedValueOnce(new Error('boom'))
    await expect(invalidateOpenStageDraft(TENANT, BUNDLE, 'reason')).rejects.toThrow('boom')
    expect(mockQuery.mock.calls.map((c) => String(c[0]).trim())).toContain('ROLLBACK')
  })
})
```

- [ ] **Step 2: Implement it**

Add after `rejectPendingWrite` (`:884`):

```ts
/**
 * Kill the approval that is waiting on a bundle whose proposal just moved.
 *
 * This is not `rejectPendingWrite`. A rejection is a human decision and it signs a
 * receipt (`:860-874`); an invalidation records that the proposal the human was
 * shown no longer exists, which is a fact about the bundle rather than a verdict
 * from a person. So there is no receipt here, and `rejection_reason` carries the
 * token a reviewer and the queue both read.
 *
 * Every open stage draft for the bundle is rejected, not the newest one. A bundle
 * can hold an expired draft nobody clicked and a fresh one beside it
 * (`getOpenStageDraft` reads `created_at DESC LIMIT 1`), and leaving the expired row
 * open is how a stale proposal stays nominally decidable.
 *
 * Self-contained transaction, and both writes in it: the draft and the bundle
 * status are one fact, and a run that died between them would leave a `staged`
 * bundle with no approval waiting on it. None of the three callers has a transaction
 * of its own to join, which is what spec section 6.2's "inside the same transaction
 * where one exists" resolves to here.
 */
export async function invalidateOpenStageDraft(
  tenantId: string,
  bundleId: string,
  reason: string,
): Promise<string | null> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const mark = await client.query<{ id: string }>(
      `UPDATE pending_writes
          SET rejected_at = now(), rejection_reason = $3
        WHERE tenant_id = $1
          AND object_type = 'marketing_stage'
          AND target_id = $2
          AND receipt_id IS NULL
          AND rejected_at IS NULL
        RETURNING id`,
      [tenantId, bundleId, reason],
    )
    await client.query(
      `UPDATE marketing_bundles
          SET status = 'draft', updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'staged'`,
      [tenantId, bundleId],
    )
    await client.query('COMMIT')
    return mark.rows[0]?.id ?? null
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

The bundle status resets whether or not a draft was found. That is deliberate: `staged` with no open approval is exactly the stale state R2 removes, and an expired draft the function rejected is already not decidable. `marketing.stage_bundle` accepts `draft` and `staged` alike (`src/db/marketing.ts:427`, and the `bundle_not_stageable` guard at `src/mastra/tools/marketing-writes.ts:411`), so re-staging costs the agent one more call and nothing else.

- [ ] **Step 3: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/db/open-stage-draft.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. `marketing_bundles` is not a table this file's own module has touched before in a unit test, so the new SQL branch is answered by the same `mockQuery` and needs no second stub.

- [ ] **Step 4: Commit**

```bash
cd D:/Code/CRUM
git add src/db/pending-writes.ts tests/db/open-stage-draft.test.ts
git commit -m "feat(marketing): an approval waiting on a moved bundle dies with it"
```

---

### Task 12: The three places an asset moves

Spec section 6.3 names the three and rejects a fourth. A moved asset must invalidate because the reviewer's prediction was written against bytes that no longer exist; spend must *not* invalidate, because a run that cost money without producing bytes is not a change to the proposal, and silently killing someone's mid-review approval over an invoice would be worse than the drift.

**Files:**
- Modify: `src/mastra/tools/marketing-writes.ts:7` (`commitAutoWrite` import block, add `invalidateOpenStageDraft`), `:278-282` (save), `:1479-1485` (generate)
- Modify: `src/api/documents.ts:250-259` (the review route), its import block
- Modify: `src/db/documents.ts:553-566` (`reviewDocument` returns `kind`)
- Test: `tests/mastra/marketing-write-tools.test.ts`, `tests/api/documents.test.ts`, `tests/integration/marketing-asset-invalidation.test.ts` (new)

**Interfaces:**
- Consumes: Task 11's `invalidateOpenStageDraft`, `listBundleIdsForDocument` (`src/db/marketing-assets.ts:207`).
- Produces: the `assets_changed_after_staging` token in `pending_writes.rejection_reason`, and `{ documentId, status, invalidatedBundles }` on the review route's 200. Task 13's `AssetManager` reads `invalidatedBundles` and says it out loud, which is the reason the field is a number rather than nothing.

- [ ] **Step 1: Write the failing tool tests**

`tests/mastra/marketing-write-tools.test.ts` stubs `pg` at the pool level, so the invalidation's own UPDATEs are answered by `stubQueries` and the assertion is on the SQL. Add a `call(fragment)` read (`:94`) to two cases:

```ts
it('invalidates the open stage draft when a save writes new artifacts', async () => {
  stubQueries({
    'FROM marketing_bundles': [bundleRow()],
    'INSERT INTO pending_writes': [pendingWriteRow({ committed_at: '2026-10-30T00:00:00.000Z', committed_record_id: BUNDLE_ID })],
    'FROM pending_writes': [pendingWriteRow({ committed_at: '2026-10-30T00:00:00.000Z', committed_record_id: BUNDLE_ID })],
    'INSERT INTO marketing_artifacts': [{ id: 'a1' }],
    'UPDATE pending_writes': [{ id: DRAFT_ID }],
    'UPDATE marketing_bundles': [{ id: BUNDLE_ID }],
    'SELECT id, status, funnel_plan FROM marketing_bundles': [bundleRow()],
  })
  await save(bundleInput({ artifacts: [{ role: 'funnel-builder', kind: 'script', textContent: 'a script' }] }))
  const reject = call('SET rejected_at = now(), rejection_reason = $3')
  expect(reject?.params).toEqual([TENANT, BUNDLE_ID, 'assets_changed_after_staging'])
})
```

The exact handler keys a `save` case needs are the ones the file's existing save cases use; copy from the closest one (`:345`, `:451`) and add the two invalidation branches. Then the negative case, which is the one that keeps an idempotent replay from killing an approval:

```ts
it('leaves the approval alone when the save wrote nothing new', async () => {
  stubQueries({ /* the same handlers, but 'INSERT INTO marketing_artifacts' answers { rows: [], rowCount: 0 } */ })
  await save(bundleInput({ artifacts: [{ role: 'funnel-builder', kind: 'script', textContent: 'a script' }] }))
  expect(call('SET rejected_at = now(), rejection_reason = $3')).toBeUndefined()
})
```

`insertMarketingArtifacts` already returns the count of rows this call newly wrote (`:276-277`'s comment says so, and `artifactCount` reports it), so the guard is that number, not the length of the input.

For `generate_assets`, the same pair around the existing attach case: after the block at `:1479`, an invalidation runs when `inserted > 0`, and the mock-lane test belongs in `tests/marketing/generate-assets-tool.test.ts`, where `h.insertMarketingArtifacts` is already a stub (`:5`) and `invalidateOpenStageDraft` joins the `vi.mock('../../src/db/pending-writes')` factory at `:43`:

```ts
it('invalidates the waiting approval when the run attached a picture', async () => {
  h.insertMarketingArtifacts.mockResolvedValue(1)
  await run({ bundleId: BUNDLE })
  expect(h.invalidateOpenStageDraft).toHaveBeenCalledWith(TENANT, BUNDLE, 'assets_changed_after_staging')
})

it('does not invalidate a bundle whose run attached nothing, even when it reused assets', async () => {
  h.insertMarketingArtifacts.mockResolvedValue(0)
  await run({ bundleId: BUNDLE })
  expect(h.invalidateOpenStageDraft).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Wire the two tools**

In `saveBundleTool`, after the insert at `:278-282`:

```ts
      // A save that writes new bytes moves the page the reviewer was shown, and a
      // prediction written against the old ones is a statement about a proposal that
      // no longer exists. `inserted > 0` rather than `artifacts.length > 0`: an
      // idempotent replay of a save whose artifacts all exist changes nothing, and an
      // approval killed over a no-op would teach agents to fear re-saves.
      if (inserted > 0) {
        await invalidateOpenStageDraft(rc.tenantId, bundleId, 'assets_changed_after_staging')
      }
```

In `generate_assets`, the block at `:1479` becomes:

```ts
      if (attached.length > 0 && bundle !== null) {
        const inserted = await insertMarketingArtifacts({
          tenantId: rc.tenantId,
          bundleId: bundle.id,
          artifacts: attached,
        })
        if (inserted > 0) {
          await invalidateOpenStageDraft(rc.tenantId, bundle.id, 'assets_changed_after_staging')
        }
      }
```

No guard on the bundle's status. The function's own `WHERE ... AND receipt_id IS NULL AND rejected_at IS NULL` is the guard, and a read-then-write here would be a race for the cost of two UPDATEs that match nothing in the ordinary case, where no approval is waiting.

- [ ] **Step 3: The review route, and why the call sits in the route**

`src/db/documents.ts:553-566` gains `kind` to the RETURNING list and the return type:

```ts
export async function reviewDocument(
  context: TenantRequestContext,
  id: string,
): Promise<{ id: string; status: string; kind: string } | null> {
  // ... unchanged, except `RETURNING d.id, d.status, d.kind`
```

Then `src/api/documents.ts:250-259`:

```ts
    const updated = await reviewDocument(gate.identity, id.data)
    if (!updated) return c.json({ error: 'not_found_or_not_pending' }, 404)

    // A flip from `needs_review` to `ready` changes whether a bundle carrying this
    // picture can be staged at all (`marketing.stage_bundle` refuses on exactly this
    // column, marketing-writes.ts:443-447), so an approval waiting on such a bundle
    // is now about a proposal that does not exist. In the route and not inside
    // `reviewDocument`: the data module would have to import `marketing-assets.ts`,
    // which imports `documents.ts`, and the cycle is a worse price than one route
    // that has to remember to call it. An invoice or contract document attaches to
    // no bundle, so the name list is empty for those kinds and no write follows.
    let invalidatedBundles = 0
    if (updated.kind === 'marketing_asset') {
      const bundleIds = await listBundleIdsForDocument(gate.identity.tenantId, updated.id)
      for (const bundleId of bundleIds) {
        const draftId = await invalidateOpenStageDraft(gate.identity.tenantId, bundleId, 'assets_changed_after_staging')
        if (draftId !== null) invalidatedBundles += 1
      }
    }
    return c.json({ documentId: updated.id, status: updated.status, invalidatedBundles })
```

Serial, not `Promise.all`: an asset is attached to a small number of bundles in practice, and a serial loop gives one transaction at a time to a pool that integration tests cap at two connections.

- [ ] **Step 4: Write the route test, against the harness this file actually has**

`tests/api/documents.test.ts` mocks the database at the SQL seam (`:22-35`: a hoisted `db` with `calls` and `results`, where `results` is keyed by a SQL fragment and matched by `sql.includes(needle)`), and its `connect()` rejects on purpose so no route test opens a transaction. So `reviewDocument` is answered through `db.results`, and the two marketing modules are stubbed by module mocks, which is also what keeps the invalidation's transaction out of the unit lane:

```ts
const writes = vi.hoisted(() => ({ invalidateOpenStageDraft: vi.fn() }))
const assets = vi.hoisted(() => ({ listBundleIdsForDocument: vi.fn() }))

vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  invalidateOpenStageDraft: writes.invalidateOpenStageDraft,
}))

vi.mock('../../src/db/marketing-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/marketing-assets')>()),
  listBundleIdsForDocument: assets.listBundleIdsForDocument,
}))
```

Add those two factories below the existing client mock, add `BUNDLE`, `OTHER_BUNDLE` and `DRAFT` uuid constants beside `DOC` (`:41-43`), and reset both new fns wherever the file's `beforeEach` clears `db.calls` and `db.results`. Then the three arms:

```ts
it('invalidates every bundle a reviewed asset belongs to, and reports how many', async () => {
  db.results['UPDATE documents AS d SET status'] = {
    rows: [{ id: DOC, status: 'ready', kind: 'marketing_asset' }],
    rowCount: 1,
  }
  assets.listBundleIdsForDocument.mockResolvedValue([BUNDLE, OTHER_BUNDLE])
  writes.invalidateOpenStageDraft.mockResolvedValue(DRAFT)

  const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })

  expect(await json<{ status?: string; invalidatedBundles?: number }>(res)).toMatchObject({
    status: 'ready',
    invalidatedBundles: 1,
  })
  expect(assets.listBundleIdsForDocument).toHaveBeenCalledWith(TENANT, DOC)
  expect(writes.invalidateOpenStageDraft.mock.calls.map((c: unknown[]) => c[1])).toEqual([BUNDLE, OTHER_BUNDLE])
  expect(writes.invalidateOpenStageDraft.mock.calls[0]![2]).toBe('assets_changed_after_staging')
})

it('never reaches the marketing lane when an invoice is reviewed', async () => {
  db.results['UPDATE documents AS d SET status'] = {
    rows: [{ id: DOC, status: 'ready', kind: 'invoice' }],
    rowCount: 1,
  }
  const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })
  expect((await json<{ invalidatedBundles?: number }>(res)).invalidatedBundles).toBe(0)
  expect(assets.listBundleIdsForDocument).not.toHaveBeenCalled()
})

it('reports zero when the asset belongs to no bundle', async () => {
  db.results['UPDATE documents AS d SET status'] = {
    rows: [{ id: DOC, status: 'ready', kind: 'marketing_asset' }],
    rowCount: 1,
  }
  assets.listBundleIdsForDocument.mockResolvedValue([])
  const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })
  expect((await json<{ invalidatedBundles?: number }>(res)).invalidatedBundles).toBe(0)
  expect(writes.invalidateOpenStageDraft).not.toHaveBeenCalled()
})
```

The file's two existing review cases (`:204`, `:216`) stay as they are and must still pass: the first answers a row with no `kind`, and `undefined !== 'marketing_asset'`, so no marketing module is touched; the second answers nothing and 404s before the invalidation branch. Its `sqlFor(...)` assertion on `status = 'needs_review'` is unaffected by the extra `d.kind` in the RETURNING list.

- [ ] **Step 5: The integration proof**

`tests/integration/marketing-asset-invalidation.test.ts` proves what no mock can: that a real staged bundle loses its real draft, and that the reviewer's old prediction cannot anchor the new one. Copy the harness from `tests/integration/marketing-generate-assets.test.ts` (stub adapter at `:41`, `setImageAdapter` before each case — or Task 10's `registerImageAdapter`, whichever is on the branch by then) and its `context`/`bundleInput` helpers.

```ts
it('a picture that lands after staging kills the approval that was waiting', async () => {
  const saved = await saveBundleTool.execute(
    bundleInput({
      funnelPlan: { page: { slug: 'physio-invalidation' } },
      artifacts: [{ role: 'funnel-builder', kind: 'page_html', textContent: '<h1>Book in</h1>' }],
    }),
    context,
  )
  const bundleId = saved.bundleId as string
  const staged = await stageBundleTool.execute({ bundleId, requestedCeilingMinor: 2500 }, context)
  expect(await statusOf(bundleId)).toBe('staged')

  // The reviewer's prediction, written against the bytes they were shown.
  const predicted = await insertPrediction(staged.pendingWriteId)
  expect(predicted).toBeDefined()

  await generateAssetsTool.execute({ bundleId }, context)

  const draft = await pool.query<{ rejected_at: string | null; rejection_reason: string | null }>(
    `SELECT rejected_at, rejection_reason FROM pending_writes WHERE id = $1`,
    [staged.pendingWriteId],
  )
  expect(draft.rows[0]?.rejected_at).not.toBeNull()
  expect(draft.rows[0]?.rejection_reason).toBe('assets_changed_after_staging')
  expect(await statusOf(bundleId)).toBe('draft')
  expect(await getOpenStageDraft(TENANT, bundleId)).toBeNull()

  // Re-staging is a new draft, and `reviewer_predictions` is keyed
  // UNIQUE (pending_write_id) (migrations/0021:…), so the paragraph above cannot
  // anchor it. This is the whole ruling in four lines: the reviewer writes a new
  // prediction or nothing is approvable.
  const again = await stageBundleTool.execute({ bundleId, requestedCeilingMinor: 2500 }, context)
  expect(again.pendingWriteId).not.toBe(staged.pendingWriteId)
  const anchored = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM reviewer_predictions WHERE pending_write_id = $1`,
    [again.pendingWriteId],
  )
  expect(Number(anchored.rows[0]!.n)).toBe(0)
})

it('does not invalidate on spend alone', async () => {
  // Spec section 6.3's rejected fourth call site, as an assertion rather than a
  // comment: money spent with no new bytes must not disturb a mid-review approval.
  const staged = /* stage a bundle with a page */
  await pool.query(
    `INSERT INTO marketing_image_spend (tenant_id, bundle_id, document_id, provider, cost_minor)
     VALUES ($1, $2, NULL, 'replicate', 40)`,
    [TENANT, stagedBundleId],
  )
  expect(await getOpenStageDraft(TENANT, stagedBundleId)).not.toBeNull()
  expect(await statusOf(stagedBundleId)).toBe('staged')
})
```

`statusOf`, `insertPrediction` and the tenant constants follow `tests/integration/marketing-publish.test.ts:52` and `tests/integration/reviewer-predictions.test.ts`; take the prediction insert from that file rather than writing a new one.

- [ ] **Step 6: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/marketing-write-tools.test.ts tests/marketing/generate-assets-tool.test.ts tests/api/documents.test.ts tests/db/open-stage-draft.test.ts
npx vitest run tests/integration/marketing-asset-invalidation.test.ts
npm run typecheck
npm run lint
```

Expected: PASS with the integration file named in the report. If it skipped, the task is not done.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git add src/mastra/tools/marketing-writes.ts src/api/documents.ts src/db/documents.ts tests/mastra/marketing-write-tools.test.ts tests/marketing/generate-assets-tool.test.ts tests/api/documents.test.ts tests/integration/marketing-asset-invalidation.test.ts
git commit -m "feat(marketing): a moved asset rejects the approval waiting on it"
```

---

## S5d. The browse surface, reachability, and the review items (R5, R6, RV1, RV2)

### Task 13: `marketing_asset` documents become browsable, through the gate (R5)

Slice 4 decided a generated picture is a document, then closed every door a person could walk through to see one. `POST /api/documents/upload` refuses an image (that refusal is correct and stays), `listDocuments` hides `marketing_asset` unless a caller names the kind (`src/db/documents.ts:389-391`), and `GET /api/documents?kind=` answers 400 for anything outside the three business kinds (`src/api/documents.ts:188`). So the renders exist, cost real money, and are visible only inside the bundle screen that made them. R5 opens exactly one door: the whitelist gains the one kind, and the console gains a tab that asks for it explicitly.

**Files:**
- Modify: `src/api/documents.ts:187-190` (`?kind=` whitelist and its refusal sentence)
- Modify: `console/lib/types.ts:139` (`CrmDocument['kind']` gains `'marketing_asset'`)
- Create: `console/components/AssetManager.tsx`
- Modify: `console/app/knowledge/page.tsx:10-35` (a fourth tab, and the description sentence above it)
- Test: `tests/api/documents.test.ts`, `console/tests/AssetManager.test.tsx` (new), `console/tests/KnowledgePage.test.tsx`

**Interfaces:**
- Consumes: `listDocuments(context, { kind })` unchanged, the gated byte route `GET /api/marketing/assets/:documentId/bytes` (`src/api/marketing.ts:186`, which 409s while any owning bundle is staged and unpredicted), and Task 12's review response `{ documentId, status, invalidatedBundles }`.
- Produces: a rendered asset list, a thumbnail slot, and one sentence the owner reads after flipping a picture to `ready`. No later task consumes anything here.

- [ ] **Step 1: Open the API door, and say which door it is**

`src/api/documents.ts:187-190`:

```ts
    const kind = c.req.query('kind')
    // Assets are admitted to a whitelist that already does the filtering, which is
    // the smallest change that makes a paid-for picture findable. An unfiltered
    // list still excludes them (`src/db/documents.ts:389`), so the owner's invoice
    // view does not fill up with PNGs: whoever wants renders has to say so. A new
    // browse-only byte route was refused, because an ungated thumbnail of a bundle
    // nobody has predicted for would undo the cognitive forcing gate (spec section
    // 10.2).
    if (kind && !['invoice', 'contract', 'other', 'marketing_asset'].includes(kind)) {
      return c.json(
        { error: 'invalid_query', detail: 'kind must be invoice, contract, other or marketing_asset' },
        400,
      )
    }
```

`IntakeResult.kind` at `:30` does not widen. It describes what intake can produce, and intake cannot produce an asset (slice 4 closed that lane); widening it would advertise a door the router refuses. `console/lib/types.ts:139` is the view type that does widen, and spec section 10.1's "`:30`" is read as pointing at that one.

Then, in `tests/api/documents.test.ts` beside the existing kind cases (`:166`, `:176`):

```ts
it('admits marketing_asset and asks the data layer for exactly that kind', async () => {
  db.results['FROM documents d'] = { rows: [], rowCount: 0 }
  const res = await router().request('/api/documents?kind=marketing_asset', { headers: AUTH })
  expect(res.status).toBe(200)
  const list = sqlFor('FROM documents d')
  expect(list?.sql).toContain('d.kind = $')
  expect(list?.params).toContain('marketing_asset')
})

it('still refuses a kind that is not one of the four', async () => {
  const res = await router().request('/api/documents?kind=purchase_order', { headers: AUTH })
  expect(res.status).toBe(400)
  expect((await json<{ detail?: string }>(res)).detail).toContain('marketing_asset')
})
```

The second case replaces nothing; the existing `kind=receipt` case stays and its expected detail sentence is updated to the four names, because that string is the API's own documentation.

- [ ] **Step 2: Widen the console's document type**

`console/lib/types.ts:139` becomes:

```ts
  kind: 'invoice' | 'contract' | 'other' | 'marketing_asset'
```

Then `cd console && npx tsc --noEmit -p tsconfig.json`. `DocumentManager` reads `doc.status`, never `doc.kind`, so no exhaustive switch breaks. If one does, name the file in your report rather than adding a default arm to silence it.

- [ ] **Step 3: Write the component**

`console/components/AssetManager.tsx`. It is a list plus one action, and the two things it deliberately lacks are load-bearing: no upload control (an asset anyone could upload would be an asset nobody paid for), and no ungated thumbnail route.

```tsx
// console/components/AssetManager.tsx
/**
 * Where the paid-for renders are browsable.
 *
 * A generated image is a `marketing_asset` document, which slice 4 decided and
 * slice 5 makes visible: this tab names the kind the list route filters on and
 * shows what one run cost the owner, beside the review flip that lets it be
 * staged at all. There is no upload control here on purpose. An intake door for
 * images would let a picture nobody generated through the paid lane reach a
 * bundle, and the whole asset lane exists so that the thing reviewed is the
 * thing bought.
 *
 * Thumbnails come from `/api/marketing/assets/:id/bytes`, the same gated read the
 * bundle screen uses, not from a browse-only route. A reviewer who can peek at the
 * picture in a second tab has not been forced to predict anything, and the gate
 * would be theatre. So a gated asset renders its placeholder here exactly as it
 * withholds its prose there, and an owner who wants to browse freely browses the
 * assets whose bundles are already decided.
 */
'use client'

import { useCallback, useEffect, useState } from 'react'

import { describeError, get, post } from '../lib/api'
import type { CrmDocument } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

interface ListResponse {
  documents: CrmDocument[]
  total: number
}

interface ReviewResponse {
  documentId: string
  status: string
  invalidatedBundles: number
}

function statusVariant(status: CrmDocument['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

/**
 * The `<img>` needs no token: `console/middleware.ts:22` stamps the identity
 * headers on every /api rewrite, which is the same reason
 * `MarketingBundleView.tsx:324` can render a picture inline. The browser cannot
 * tell us which status it got back, so a failed load is answered with the
 * awaiting-review slot rather than a diagnosis. That is the honest shape: the
 * route withholds for a gated bundle, and this component knows only that the
 * bytes did not arrive.
 */
function Thumbnail({ id, title }: { id: string; title: string }) {
  const [blocked, setBlocked] = useState(false)
  if (blocked) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border-strong bg-bg-raised px-1 text-center text-[10px] leading-tight text-text-muted">
        Awaiting review
      </div>
    )
  }
  return (
    <img
      src={`/api/marketing/assets/${encodeURIComponent(id)}/bytes`}
      alt={`Generated image: ${title}`}
      loading="lazy"
      onError={() => setBlocked(true)}
      className="h-16 w-16 rounded-md border border-border object-cover"
    />
  )
}

export function AssetManager() {
  const [assets, setAssets] = useState<CrmDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const data = await get<ListResponse>('/api/documents?kind=marketing_asset')
      setAssets(data.documents ?? [])
    } catch (err) {
      setListError(describeError(err))
      setAssets([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleReview(doc: CrmDocument) {
    setNotice(null)
    try {
      const result = await post<ReviewResponse>(`/api/documents/${encodeURIComponent(doc.id)}/review`)
      setNotice({
        // The number is the point of the sentence. Confirming a picture that a
        // staged page already references moves that page's bytes, and Task 12 ends
        // the approval waiting on it. An owner who is not told their review just
        // cost somebody a re-stage reads a silent success as a no-op.
        kind: result.invalidatedBundles > 0 ? 'info' : 'ok',
        text:
          result.invalidatedBundles > 0
            ? `Confirmed ${doc.title} as ready. ${result.invalidatedBundles} staged bundle(s) went back to draft, so their approvals must be re-staged and re-predicted.`
            : `Confirmed ${doc.title} as ready.`,
      })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-text-muted">
          Images generated for campaign bundles. They arrive flagged for review, and a
          bundle holding one that is still unreviewed cannot be staged.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {notice ? (
        <p
          role={notice.kind === 'bad' ? 'alert' : 'status'}
          className={
            notice.kind === 'bad'
              ? 'rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
              : notice.kind === 'ok'
                ? 'rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
                : 'rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-secondary'
          }
        >
          {notice.text}
        </p>
      ) : null}

      {loading ? <p className="text-sm text-text-muted">Loading generated images…</p> : null}

      {listError ? (
        <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="break-words">{listError}</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger">
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && !listError && assets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No generated images yet. A bundle needs a stored creative prompt set before
          marketing.generate_assets will spend anything.
        </div>
      ) : null}

      {assets.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Preview</th>
                <th scope="col" className="px-3 py-2 font-medium">Title</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Format</th>
                <th scope="col" className="px-3 py-2 font-medium">Generated</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((doc) => (
                <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top">
                    <Thumbnail id={doc.id} title={doc.title} />
                  </td>
                  <td className="px-3 py-2 align-top font-medium text-text-primary">{doc.title}</td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={statusVariant(doc.status)}>{doc.status}</Badge>
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">{doc.mime || '—'}</td>
                  <td className="px-3 py-2 align-top text-xs text-text-muted">
                    {new Date(doc.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 align-top">
                    {doc.status === 'needs_review' ? (
                      <Button variant="ghost" size="sm" onClick={() => void handleReview(doc)}>
                        Confirm
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Mount it as the fourth tab**

`console/app/knowledge/page.tsx` imports `AssetManager` and adds, after the Contracts trigger and content:

```tsx
              <TabsTrigger value="assets">Campaign images</TabsTrigger>
```

```tsx
            <TabsContent value="assets">
              <AssetManager />
            </TabsContent>
```

and the `PageHeader` description at `:12` becomes one sentence that names all three document lanes:

```tsx
          description="Upload reference text for retrieval, ingest invoice and contract documents into structured, queryable records, or browse the images a campaign bundle has paid for."
```

- [ ] **Step 5: The console tests**

New `console/tests/AssetManager.test.tsx`, following `console/tests/DocumentManager.test.tsx:1-67` for the harness (`stubFetch`, `route`, `mountWith`, `beforeEach`/`afterEach` with `vi.unstubAllGlobals()`). Note the fetch stub parses a JSON body only; the byte route is an image and is never read through it, which is why the thumbnail assertions are about the `src` attribute and the error slot rather than the response bytes.

```tsx
const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001'
const OTHER = 'b2b2b2b2-0000-4000-8000-000000000002'

function asset(over: Partial<CrmDocument> = {}): CrmDocument {
  return {
    id: ASSET,
    tenant_id: 'tenant-1',
    owner_id: 'user-1',
    kind: 'marketing_asset',
    title: 'Hero render, physio campaign',
    source: 'upload',
    source_ref: null,
    content_hash: 'sha256:def',
    mime: 'image/png',
    status: 'needs_review',
    confidence: null,
    customer_id: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...over,
  }
}

const list = (documents: CrmDocument[]): Reply => ({ status: 200, body: { documents, total: documents.length } })
```

Four cases:

```ts
it('lists generated assets with their review state and the gated thumbnail', async () => {
  mountWith([route('/api/documents?kind=marketing_asset', list([asset(), asset({ id: OTHER, title: 'Story square', status: 'ready' })]), 'GET')])

  expect(await screen.findByText('Hero render, physio campaign')).toBeInTheDocument()
  expect(screen.getByText('Story square')).toBeInTheDocument()
  expect(screen.getByText('needs_review')).toBeInTheDocument()
  expect(screen.getByText('image/png')).toBeInTheDocument()
  expect(screen.getByRole('img')).toHaveAttribute('src', `/api/marketing/assets/${ASSET}/bytes`)
  expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1)
})

it('answers a withheld thumbnail with the awaiting-review slot', async () => {
  mountWith([route('/api/documents?kind=marketing_asset', list([asset()]), 'GET')])

  const img = await screen.findByRole('img')
  fireEvent.error(img)

  expect(await screen.findByText('Awaiting review')).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('says what confirming a picture cost the bundle waiting on it', async () => {
  const user = userEvent.setup()
  mountWith([
    route('/api/documents?kind=marketing_asset', list([asset()]), 'GET'),
    route(`/api/documents/${ASSET}/review`, { status: 200, body: { documentId: ASSET, status: 'ready', invalidatedBundles: 2 } }, 'POST'),
  ])

  await user.click(await screen.findByRole('button', { name: 'Confirm' }))

  expect(server.last(`/api/documents/${ASSET}/review`)).toBeDefined()
  expect(await screen.findByRole('status')).toHaveTextContent('2 staged bundle(s) went back to draft')
})

it('says there is nothing yet, rather than showing an empty table', async () => {
  mountWith([route('/api/documents?kind=marketing_asset', list([]), 'GET')])
  expect(await screen.findByText(/No generated images yet/)).toBeInTheDocument()
})
```

The third case re-reads the list after the flip, so the `GET` rule answers twice and `list([asset()])` is fine as a reused reply object; if the stub's `count` bookkeeping disagrees with that, use the function form `() => list([...])` the way `DocumentManager.test.tsx:88` does.

In `console/tests/KnowledgePage.test.tsx`, extend the first case's tab list and add the mount-on-click proof:

```ts
expect(screen.getByRole('tab', { name: 'Campaign images' })).toBeInTheDocument()
```

```ts
it('switching to Campaign images reads the asset kind and nothing else', async () => {
  const user = userEvent.setup()
  mountWith([
    route('/api/knowledge/documents', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
    route('/api/documents?kind=marketing_asset', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
  ])

  await user.click(screen.getByRole('tab', { name: 'Campaign images' }))

  await waitForRead('/api/documents?kind=marketing_asset')
  expect(server.count('/api/documents?kind=invoice')).toBe(0)
})
```

- [ ] **Step 6: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/api/documents.test.ts
npm run typecheck
npm run lint
cd console
npx vitest run tests/AssetManager.test.tsx tests/KnowledgePage.test.tsx tests/DocumentManager.test.tsx
npx tsc --noEmit -p tsconfig.json
```

Expected: PASS on all six. The console run is three files, not the whole console suite, and says so in the report.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git add src/api/documents.ts tests/api/documents.test.ts console/lib/types.ts console/components/AssetManager.tsx console/app/knowledge/page.tsx console/tests/AssetManager.test.tsx console/tests/KnowledgePage.test.tsx
git commit -m "feat(marketing): generated images become browsable through the prediction gate"
```

---

### Task 14: `toIsoString`: the timestamp a row mapper tells the truth about (RV1)

The whole-branch review found `src/db/reviewer-predictions.ts:26` declaring `createdAt: string` while node-pg hands back a `Date`, and named the same fiction at three more columns in `rowToPendingWrite`. It survives in production for one reason only: `JSON.stringify(new Date())` emits the ISO string everybody wanted, so the console prints the right thing past a type that says the wrong thing. The review offered two house patterns, a cast and a normalise, and chose the normalise because a cast keeps the lie. This task is that choice, in one new file and four call sites.

**Files:**
- Create: `src/db/timestamps.ts`
- Modify: `src/db/reviewer-predictions.ts:29-45` (`PredictionSqlRow.created_at`, `rowToPrediction`)
- Modify: `src/db/pending-writes.ts:86` (`rejectedAt`), `:91` (`createdAt`), `:92` (`expiresAt`), `:833` (the receipt's `createdAt`)
- Test: `tests/db/timestamps.test.ts` (new), `tests/db/reviewer-predictions.test.ts`, `tests/db/open-stage-draft.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `toIsoString(value: unknown, label: string): string` and `isoOrNull(value: unknown, label: string): string | null`, both from `../db/timestamps`. `ReviewerPrediction.createdAt` and `PendingWrite.createdAt` keep declaring `string` and now mean it.

- [ ] **Step 1: Write the failing helper tests**

New `tests/db/timestamps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isoOrNull, toIsoString } from '../../src/db/timestamps'

describe('toIsoString', () => {
  it('normalises the Date node-pg actually hands back', () => {
    expect(toIsoString(new Date('2026-11-02T04:00:00.000Z'), 'x.created_at')).toBe('2026-11-02T04:00:00.000Z')
  })

  it('passes a string through untouched, because a json aggregate can carry one', () => {
    expect(toIsoString('2026-11-02T04:00:00.000Z', 'x.created_at')).toBe('2026-11-02T04:00:00.000Z')
  })

  it('crashes on a value that is neither, naming the column', () => {
    expect(() => toIsoString(1730548800000, 'pending_writes.expires_at')).toThrow(
      'pending_writes.expires_at is neither a Date nor a string: number',
    )
  })

  it('crashes rather than stringifying an object', () => {
    expect(() => toIsoString({}, 'audit_receipts.created_at')).toThrow(/neither a Date nor a string/)
  })
})

describe('isoOrNull', () => {
  it('maps both nulls a nullable column can hand back', () => {
    expect(isoOrNull(null, 'pending_writes.rejected_at')).toBeNull()
    expect(isoOrNull(undefined, 'pending_writes.rejected_at')).toBeNull()
  })

  it('normalises a present value', () => {
    expect(isoOrNull(new Date('2026-11-02T04:00:00.000Z'), 'pending_writes.rejected_at')).toBe(
      '2026-11-02T04:00:00.000Z',
    )
  })
})
```

- [ ] **Step 2: Write the mapper tests that the current code fails**

`tests/db/reviewer-predictions.test.ts` already stubs the pool. Add one case whose row carries a real `Date`, which is what `pg` sends on a wire a `created_at: string` annotation never describes:

```ts
it('hands back an ISO string for the Date the driver returns', async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        id: PREDICTION,
        tenant_id: TENANT,
        pending_write_id: DRAFT,
        predicted_outcome: 'leads double',
        created_at: new Date('2026-11-02T04:00:00.000Z'),
      },
    ],
  })
  const { getPredictionForDraft } = await load()
  const prediction = await getPredictionForDraft(TENANT, DRAFT)
  expect(prediction?.createdAt).toBe('2026-11-02T04:00:00.000Z')
  expect(typeof prediction?.createdAt).toBe('string')
})
```

`tests/db/open-stage-draft.test.ts` gets the same shape for the three columns the prediction gate reads (`:86`, `:91`, `:92`), asserting a `Date` row yields three strings and that a `null` `rejected_at` stays `null` rather than becoming the string `"null"`. Use that file's existing row-builder and `load()` helper for the module import.

- [ ] **Step 3: Implement the helper**

New `src/db/timestamps.ts`:

```ts
// src/db/timestamps.ts
/**
 * The one normaliser for a `timestamptz` column read back through node-pg.
 *
 * A row mapper that writes `row.created_at as string` is not carrying a cosmetic
 * cast. The driver hands a `timestamptz` back as a `Date`, so the annotation says
 * one thing and the runtime gives another, and the pair only agrees by accident:
 * `JSON.stringify(new Date())` happens to emit the ISO string every reader wants.
 * The whole-branch review asked for the type to tell the truth, which is why the
 * fix here is a normaliser rather than the second house pattern, a cast that keeps
 * the fiction in place.
 *
 * A value that is neither shape is not coerced. `String({})` is "[object Object]",
 * and a timestamp like that in an approval receipt is worse than a 500: it survives
 * into a report as data. This is the same reasoning that deleted the silent
 * fallback from `getAssetBytes` (`src/db/marketing-assets.ts:119`), and it reaches
 * the same verdict. The `label` names the column so the crash says where.
 *
 * `isoOrNull` exists because the nullable half of this set (`pending_writes.rejected_at`)
 * would otherwise inline the same null test beside the normaliser, and one column's
 * shape is one idea. It keeps the null arm honest rather than letting
 * `toIsoString(null)` turn an un-rejected draft into a crash.
 */
export function toIsoString(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new Error(`${label} is neither a Date nor a string: ${typeof value}`)
}

export function isoOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return toIsoString(value, label)
}
```

- [ ] **Step 4: Move the four sites**

`src/db/reviewer-predictions.ts`: `PredictionSqlRow.created_at` becomes `unknown` (the interface is what the cast was hiding), and `rowToPrediction` ends with:

```ts
    createdAt: toIsoString(row.created_at, 'reviewer_predictions.created_at'),
```

`src/db/pending-writes.ts`, inside `rowToPendingWrite`:

```ts
    rejectedAt: isoOrNull(row.rejected_at, 'pending_writes.rejected_at'),
    createdAt: toIsoString(row.created_at, 'pending_writes.created_at'),
    expiresAt: toIsoString(row.expires_at, 'pending_writes.expires_at'),
```

and in `getReceipt` (`:833`):

```ts
    createdAt: toIsoString(row.created_at, 'audit_receipts.created_at'),
```

The receipt line is the fourth site, and it goes with the other three. The review named `:86`, `:91` and `:92`; leaving one column in the same file carrying the same false annotation is the drift this item exists to end, and it costs one line rather than a slice.

Both files import from `./timestamps`. `committedAt` and `committedRecordId` (`:89-90`) already use `?? null` on a nullable column and are not timestamps of a row the gate reads; leave them, and say in the report that you left them on purpose.

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/db/timestamps.test.ts tests/db/reviewer-predictions.test.ts tests/db/open-stage-draft.test.ts tests/db/pending-writes-commit.test.ts tests/api/marketing.test.ts
npm run typecheck
npm run lint
```

Expected: PASS. The two existing files are named because they are the ones that consume these mappers, and a widened row type that breaks a route test is exactly what this step is for.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/db/timestamps.ts src/db/reviewer-predictions.ts src/db/pending-writes.ts tests/db/timestamps.test.ts tests/db/reviewer-predictions.test.ts tests/db/open-stage-draft.test.ts
git commit -m "fix(db): a row mapper's timestamps say what the driver actually returns"
```

---

### Task 15: `stageCampaignStatusChange` writes uuids, and the cron names a user

**Files**

- Modify `src/mastra/tools/marketing-writes.ts`, the function at `:811-887`
- Modify `src/config/env.ts`, in the slice-4 settings block that ends at `:208`
- Modify `scripts/analyst-cron.ts`: `runAnalystCron` args `:190-197`, the recommendation loop `:303-327`, `main()` `:356-381`
- Test `tests/mastra/marketing-campaign-status-tool.test.ts`, `tests/config/env.test.ts`, `tests/integration/analyst-cron.test.ts`

**Interfaces this task produces:** `stageCampaignStatusChange({ tenantId, userId, bundleId, campaignExternalId, status, reason, userRole })`, `CrumEnv.CRUM_ANALYST_USER_ID?: string`, `runAnalystCron({ tenantId, ..., analystUserId })`.

**Why four changes and not two.** Spec section 9.2 names the two insert bugs: `targetId: args.campaignExternalId` (`:880`) goes into `pending_writes.target_id`, which is `uuid` (`migrations/0002_crum_spine.sql:149`), and `requestedBy: 'analyst-cron'` (`:884`) goes into `requested_by uuid NOT NULL` (`:158`). A Meta campaign id like `'23842653876'` and a label like `'analyst-cron'` are both `22P02 invalid input syntax for type uuid`, so the insert has failed on every call since slice 3 shipped. The other two changes fall out of reading the function while fixing it: `args.bundleId` is accepted and never used, so the existence check (`:823-833`) matches a campaign created under any bundle in the tenant, and the function is the only marketing staging path that does not ask `isExecutable`, the check `stagePromotion` (`:635`) and `stageRetry` (`:749`) both run before they stage. An action with no adapter in this process is not approvable, and the slice that makes this lane reachable is the moment to enforce that here.

- [ ] **Step 1: Prove the lane is dead before changing it**

Start the cluster (the Integration cluster section) and run the file that has always covered this path:

```bash
cd D:/Code/CRUM
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/analyst-cron.test.ts
```

Expect the `stages a draft for a "scale" recommendation` and `stages a draft for a "kill" recommendation` cases to fail, in one of the two places: the test's own `DELETE FROM pending_writes ... AND target_id = $2` with `'camp-ext-20-a'` errors on the cast, or `runAnalystCron` comes back with `stagedDrafts: []` because the insert inside `getOrCreateDraft` was rejected. Record which, in the report, as the evidence that R6 was unreachable rather than merely unloved. If both cases are green, stop and report that, because the premise of Task 15 and Task 16 is then wrong and nothing should be written on top of it.

Note in the report that these cases have been `describe.skipIf(!url)` for their whole life: an unset `CRUM_INTEGRATION_DATABASE_URL` skips silently, which is how a broken insert survived a slice that reported green.

- [ ] **Step 2: Actor first**

`src/mastra/tools/marketing-writes.ts`, the signature at `:811` gains `userId`, and the function opens with the guard before it reads anything:

```ts
export async function stageCampaignStatusChange(args: {
  tenantId: string
  userId: string
  bundleId: string
  campaignExternalId: string
  status: 'ACTIVE' | 'PAUSED'
  reason: string
  userRole: string
}): Promise<string> {
  const db = getDbClient()

  // requested_by is `uuid NOT NULL` (migrations/0002_crum_spine.sql:158) and the
  // column means who asked. 'analyst-cron' is a label, not a person, and Postgres
  // refused it at the insert, so every draft this function staged since slice 3
  // failed to exist. A call that cannot name an owner refuses here, in words,
  // before it spends a query on 22P02.
  if (!args.userId) {
    throw new Error(
      `campaign_status_actor_required: no user id was supplied for the status change on ${args.campaignExternalId}`,
    )
  }

  // An action this process has no adapter for cannot be run by the drainer, so it
  // must not be approvable. stagePromotion (:635) and stageRetry (:749) both ask;
  // this function is the marketing staging path that never did, and reaching the
  // lane is the point of the residual.
  if (!isExecutable('set_campaign_status')) {
    throw new Error(
      'provider_not_configured: this process has no set_campaign_status adapter, so approving a status change would queue work nothing can run',
    )
  }
```

`isExecutable` is already imported (`:35`). The two guards go before the reads because they are the cheapest answers to ask.

- [ ] **Step 3: Make the bundle argument load-bearing**

The existence check at `:825` gains `AND bundle_id = $3`:

```ts
  const created = await db.query<{ id: string }>(
    `SELECT id FROM marketing_actions
      WHERE tenant_id = $1
        AND action = 'create_campaign'
        AND status = 'succeeded'
        AND result ->> 'externalId' = $2
        AND bundle_id = $3`,
    [args.tenantId, args.campaignExternalId, args.bundleId],
  )
  if (created.rows.length === 0) {
    throw new Error(
      `campaign_not_found: no succeeded create_campaign action for external id ${args.campaignExternalId} on bundle ${args.bundleId}`,
    )
  }
```

The analyst reads metrics per bundle and recommends against that bundle's campaign, so a campaign id created under a different bundle is not this bundle's campaign and its recommendation is not actionable. Until now `bundleId` was decorative, which is the kind of argument a caller can pass wrongly without anything noticing.

- [ ] **Step 4: The uuid target**

Extend the hash import at `:30` to `import { computeBundleHash, uuidFromSeed } from '../../marketing/hash'`, and change the two lines in the `getOrCreateDraft` call at `:880` and `:884`:

```ts
    // Meta's campaign id is not a uuid and target_id is one
    // (migrations/0002_crum_spine.sql:149), which is the second half of why this
    // insert has always failed. uuidFromSeed gives the same external identity the
    // same derived id every time, so a re-ask still lands on the existing draft
    // rather than a second approval, and the real id stays in the payload, which
    // is what applyDraft hands the adapter.
    targetId: uuidFromSeed(`campaign:${args.campaignExternalId}`),
    ...
    requestedBy: args.userId,
```

`runId` stays `'analyst-cron'`: it is a text column and the label is honest there. `payload` stays `{ campaignId, status }` (`:866`) with no prose, because `scoreRisk` stringifies the whole draft and the analyst's `reason` moving the score would make the gate depend on the model's phrasing. The `reason` argument is therefore still not persisted, which is the spec's decision (section 9.1) and stays true; Task 17 puts it in the message the owner reads in chat, and the cron puts it in its log.

- [ ] **Step 5: The setting**

`src/config/env.ts`, after `CRUM_IMAGE_COST_MINOR_PER_IMAGE` (`:204-208`):

```ts
  // Slice 5 spec section 9.2: a staged draft needs a uuid actor, and the analyst
  // cron is the only caller that has no human in the loop. Blank is unset, like
  // every other credential here, so an `CRUM_ANALYST_USER_ID=` placeholder line
  // cannot fail a boot. Unset means the cron reports its recommendations and
  // stages nothing, because inventing a synthetic person to satisfy a column that
  // means "who asked" would put a fiction in the audit trail.
  CRUM_ANALYST_USER_ID: z.preprocess(blankAsUnset, z.string().uuid().optional()),
```

`tests/config/env.test.ts` gets three cases beside the slice-4 ones (`:147` onward): a blank value parses as unset rather than failing the boot, a valid uuid parses through, and `'analyst-cron'` is rejected with an issue that names `CRUM_ANALYST_USER_ID` so the operator knows which line to fix.

Do not touch `.env.example`. It carries another effort's uncommitted edits, and the standing rule keeps it unstaged; the new setting gets recorded in the Task 19 report as a line the owner adds to their own env file.

- [ ] **Step 6: The cron stops staging fictions**

`scripts/analyst-cron.ts`. The args at `:190-197` gain `analystUserId?: string | null`. The loop at `:303-327` becomes:

```ts
    const status = rec.recommendation === 'scale' ? 'ACTIVE' : 'PAUSED'

    // An unattributed draft is not a smaller approval, it is no approval: the
    // insert fails on requested_by before anybody can review it. Report the
    // recommendation, say plainly that nothing was staged, and count it in errors
    // so the summary line cannot read "0 error(s)" over a run that staged nothing.
    if (!args.analystUserId) {
      errors.push(`not_staged_no_actor: ${rec.campaignId}`)
      console.log(
        `[analyst-cron] ${rec.recommendation} for ${rec.campaignId} was not staged (${rec.reason}): CRUM_ANALYST_USER_ID is unset, so no owner could be named as the requester`,
      )
      continue
    }
    try {
      const draftId = await stageStatus({
        tenantId: args.tenantId,
        userId: args.analystUserId,
        bundleId: rec.bundleId,
        campaignExternalId: rec.campaignId,
        status,
        reason: rec.reason,
        userRole: 'campaign-analyst',
      })
```

and `main()` (`:356-381`) reads and passes it:

```ts
  const analystUserId = env.CRUM_ANALYST_USER_ID ?? null
  if (!analystUserId) {
    console.warn(
      '[analyst-cron] CRUM_ANALYST_USER_ID is unset; recommendations will be reported but never staged',
    )
  }
  ...
    const result = await runAnalystCron({ tenantId, metricsReadback, analystUserId })
```

- [ ] **Step 7: Unit tests**

`tests/mastra/marketing-campaign-status-tool.test.ts`. Every existing call of `stageCampaignStatusChange` gains `userId: USER` with `const USER = '55555555-5555-4555-8555-555555555555'`. The two assertions that recorded the bugs become:

```ts
    expect(call.targetId).toBe(uuidFromSeed(`campaign:${CAMPAIGN_ID}`))
    expect(call.requestedBy).toBe(USER)
```

with `import { uuidFromSeed } from '../../src/marketing/hash'`. The existing `expect(call.runId).toBe('analyst-cron')` stays, because that column is text and the label is honest.

Because the function now asks `isExecutable`, and no unit test registers an adapter, the file needs the registry the way `tests/mastra/marketing-publish-tools.test.ts:71` does it. Add to the imports `import { registerActionAdapter } from '../../src/marketing/outbox'`, then:

```ts
let unregister: () => void

beforeEach(() => {
  // The staging function now refuses an action this process cannot run, so the
  // cases below that expect a draft need an adapter present. registerActionAdapter
  // hands back the unregister so the map goes back exactly as it was found
  // (src/marketing/outbox.ts:69), and afterEach means a failed assertion cannot
  // leak the registration into the refusal case below.
  unregister = registerActionAdapter({
    name: 'set_campaign_status',
    execute: () => Promise.resolve({ externalId: 'x' }),
  })
  ...existing mockReset and policy stub...
})

afterEach(() => {
  unregister()
})
```

Three new cases: a call with `userId: ''` rejects with `/campaign_status_actor_required/` and `mockQuery` was never called; a successful call's `create_campaign` existence query carries `args.bundleId` as its third parameter; and a case that calls `unregister()` first and then expects `/provider_not_configured/` with `mockGetOrCreateDraft` not called. The second case needs the recorded-call reader, because a fragment stub answers any parameters and therefore proves nothing about scoping. Add the same local helper `tests/db/marketing-commit.test.ts:76` uses:

```ts
function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}
```

and assert `calls("action = 'create_campaign'").at(-1)!.params` is `[TENANT, CAMPAIGN_ID, BUNDLE_ID]`.

- [ ] **Step 8: Integration tests**

`tests/integration/analyst-cron.test.ts` gains `const ANALYST = 'c4000000-0000-4000-8000-000000000020'`, and the two staging cases pass `analystUserId: ANALYST`. Their cleanup and their counting must address the derived id, not the external one:

```ts
    await db.query(`DELETE FROM pending_writes WHERE tenant_id = $1 AND target_id = $2`, [
      TENANT,
      uuidFromSeed(`campaign:${CAMPAIGN_A}`),
    ])
    ...
    const draftCount = await countPendingWrites(uuidFromSeed(`campaign:${CAMPAIGN_A}`))
```

One new case, no `analystUserId`: `result.stagedDrafts` is empty, `result.errors` contains `not_staged_no_actor: camp-ext-20-a`, and the console log named the reason the analyst gave. The `hold` case at `:126` and the no-campaigns case at `:114` keep asserting `errors: []`, because the hold path returns before the actor check and an unconfigured install must not be reported as broken when it had nothing to stage.

- [ ] **Step 9: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/config/env.test.ts
npx vitest run --project integration tests/integration/analyst-cron.test.ts
npm run typecheck
npm run lint
```

Expected: the unit file green, the env cases green, and the two cron staging integration cases green, which is the first time they have run at all. Report the skip status honestly: if `CRUM_INTEGRATION_DATABASE_URL` was unset for you, say the file skipped and do not claim the fix is proven.

- [ ] **Step 10: Commit**

```bash
cd D:/Code/CRUM
git add src/mastra/tools/marketing-writes.ts src/config/env.ts scripts/analyst-cron.ts tests/mastra/marketing-campaign-status-tool.test.ts tests/config/env.test.ts tests/integration/analyst-cron.test.ts
git commit -m "fix(marketing): a campaign status draft carries uuids and names its requester"
```

---

### Task 16: The `applyDraft` branch that makes an approval mean something

**Files**

- Modify `src/db/pending-writes.ts`, new branch immediately before `const target = requireTarget(draft.objectType)` at `:632`
- Test `tests/db/marketing-commit.test.ts` (five new cases), new `tests/integration/marketing-campaign-status.test.ts`

**Interfaces this task consumes:** the draft `stageCampaignStatusChange` now writes, `PendingWrite.payload` as `{ campaignId: string, status: 'ACTIVE' | 'PAUSED' }`, `commitWithReceipt(draft, { approvedBy, scope })`, `makeSetCampaignStatusAdapter` (`src/marketing/meta-ads.ts:134`), `drainOnce` (`scripts/publish-drain.ts:172`).

**Why it belongs here.** `marketing_set_campaign_status` is in the object-type CHECK (`src/db/pending-writes.ts:62`), in `policy/tools.yaml:281`, and in the guard list. It has never had a branch. Approving one today falls through every marketing branch, reaches `requireTarget`, and throws `unknown object type` out of the transaction that already signed nothing: the owner's click 500s, the campaign does not change, and the draft stays open. Task 15 makes the draft exist; Task 16 makes approving it do something.

- [ ] **Step 1: Write the refusal cases the branch has to answer**

In `tests/db/marketing-commit.test.ts`, beside the existing marketing cases, add a draft builder after `stageDraft` (`:48`):

```ts
function statusDraft(payload: Record<string, unknown>): PendingWrite {
  return {
    ...stageDraft(payload),
    objectType: 'marketing_set_campaign_status',
    operation: 'update',
    // The derived id Task 15 writes. The branch never reads target_id: the
    // campaign lives at Meta, and the payload names it.
    targetId: '77777777-7777-4777-8777-777777777777',
  }
}

const CAMPAIGN = '23842653876'
```

Five cases, all through `commitWithReceipt`, which is how the other marketing branches in this file are driven (`:129`):

```ts
  it('refuses a status draft that is not an update', async () => {
    const { commitWithReceipt, UnsupportedCommitError } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
    })
    const draft = { ...statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }), operation: 'create' as const }
    await expect(
      commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:status' }),
    ).rejects.toThrow(UnsupportedCommitError)
    expect(calls('INSERT INTO marketing_actions')).toEqual([])
    expect(calls('INSERT INTO audit_receipts')).toEqual([])
  })
```

and the same shape for: a payload status of `'ARCHIVED'` refuses naming the value it was given; a campaign with no succeeded `create_campaign` row refuses naming the campaign id; a draft asking `ACTIVE` when the latest succeeded status action already said `ACTIVE` refuses rather than queueing a no-op; the happy case, which is Step 3.

For the no-op case note what the stub is answering. `status = 'succeeded'` appears in both the existence query and the latest-status query, so key the stubs on the fragments that differ and list them in the order `stubQueries` matches (`tests/db/marketing-commit.test.ts:37`, first match wins): `"action = 'create_campaign'"` for the origin read, `"action = 'set_campaign_status'"` for the latest-status read, `'INSERT INTO marketing_actions'` last. This is the same fragment-collision hazard Task 4 hit, and the same fix applies.

- [ ] **Step 2: Read the shape the branch has to satisfy**

The payload the adapter reads is `{ campaignId, status }`: `makeSetCampaignStatusAdapter` builds `${META_API_BASE}/${payload.campaignId}` and posts `{ status: payload.status }` (`src/marketing/meta-ads.ts:145-157`). `listActiveCampaigns` reads `payload ->> 'status'` off the latest succeeded `set_campaign_status` row (`src/db/marketing.ts:506`), so the row this branch inserts must carry exactly those two keys, or the next analyst run will read the campaign as still paused after a successful activation. `marketing_actions.bundle_id` is `uuid NOT NULL REFERENCES marketing_bundles` (`migrations/0018_crum_marketing.sql:88`), so the branch has to source a real bundle id from the origin row, and the payload does not carry one.

- [ ] **Step 3: Write the branch**

Insert before `:632`, following `marketing_promote` (`:489-565`) step for step for the reason spec section 9.3 gives: it is the same kind of thing, one work order and no content change.

```ts
  // A campaign status change is a work order against an identity CRUM does not
  // own. Everything the payload asserts about another row is re-read under this
  // transaction, because the payload is a claim, and a receipt signed over a
  // campaign that has gone would attest to work the drainer can only fail.
  if (draft.objectType === 'marketing_set_campaign_status') {
    if (draft.operation !== 'update') {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status supports only the update operation, not ${draft.operation}`,
      )
    }
    const campaignId = payload['campaignId']
    const status = payload['status']
    if (typeof campaignId !== 'string' || campaignId.length === 0) {
      throw new UnsupportedCommitError(
        'marketing_set_campaign_status must name a campaign in its payload, so the adapter has an id to address',
      )
    }
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status carries status ${String(status)}, which is neither ACTIVE nor PAUSED, so approving it would send Meta a value its own API rejects`,
      )
    }
    // The campaign must still be the product of a succeeded create_campaign in
    // this tenant, and this read also supplies what the payload deliberately does
    // not carry: the bundle the action row belongs to. Prose in a scored payload
    // moves the gate (spec section 5), so the bundle travels by reference.
    const origin = await client.query<{ bundle_id: string }>(
      `SELECT bundle_id FROM marketing_actions
        WHERE tenant_id = $1
          AND action = 'create_campaign'
          AND status = 'succeeded'
          AND result ->> 'externalId' = $2`,
      [draft.tenantId, campaignId],
    )
    const created = origin.rows[0]
    if (!created) {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status names campaign ${campaignId}, which this tenant has no succeeded create_campaign action for, so there is no campaign here to change`,
      )
    }
    // The no-op rule was asked at staging time. A campaign's state lives at Meta,
    // so this is the last moment on the CRUM side that the question can still be
    // answered, and the answer here is the one the receipt is signed over.
    const latest = await client.query<{ status: string }>(
      `SELECT payload ->> 'status' AS status FROM marketing_actions
        WHERE tenant_id = $1
          AND action = 'set_campaign_status'
          AND payload ->> 'campaignId' = $2
          AND status = 'succeeded'
        ORDER BY created_at DESC
        LIMIT 1`,
      [draft.tenantId, campaignId],
    )
    if (latest.rows[0]?.status === status) {
      throw new UnsupportedCommitError(
        `marketing_set_campaign_status asks for ${status}, but campaign ${campaignId} was last set to ${status} by an action that succeeded, so approving it would queue nothing`,
      )
    }
    // receipt_id is NULL for the reason marketing_stage and marketing_promote
    // both give: commitWithReceipt signs its receipt after applyDraft returns, so
    // no receipt id exists to write yet, and the drainer back-fills it.
    const queued = await client.query<{ id: string }>(
      `INSERT INTO marketing_actions (tenant_id, bundle_id, action, payload, status, receipt_id)
       VALUES ($1, $2, 'set_campaign_status', $3, 'queued', NULL)
       RETURNING id`,
      [draft.tenantId, created.bundle_id, JSON.stringify({ campaignId, status })],
    )
    // The committed record is the work order, because the work order is what the
    // receipt covers. marketing_promote returns a bundle id instead, since its
    // receipt is a decision about a bundle.
    return queued.rows[0]!.id
  }
```

No `COMMIT_TARGETS` entry, for the reason `marketing_stage` and `marketing_promote` have none: these are not content rows in a CRM table.

- [ ] **Step 4: Finish the happy case in the unit file**

```ts
  it('queues the work order and returns the action row as the committed record', async () => {
    const { commitWithReceipt } = await import('../../src/db/pending-writes')
    stubQueries({
      'SELECT receipt_id, rejected_at, committed_at FROM pending_writes': [
        { receipt_id: null, rejected_at: null, committed_at: null },
      ],
      "action = 'create_campaign'": [{ bundle_id: BUNDLE }],
      "action = 'set_campaign_status'": [],
      'INSERT INTO marketing_actions': [{ id: ACTION }],
      'INSERT INTO audit_receipts': [{ id: RECEIPT }],
      'UPDATE pending_writes SET receipt_id': [],
    })
    const result = await commitWithReceipt(
      statusDraft({ campaignId: CAMPAIGN, status: 'ACTIVE' }),
      { approvedBy: APPROVER, scope: 'marketing:status' },
    )
    expect(result.committedId).toBe(ACTION)
    const insert = calls('INSERT INTO marketing_actions').at(-1)!
    expect(insert.sql).toContain(`'set_campaign_status'`)
    // The bundle comes from the origin row, not the payload, and the params are
    // what proves it: a fragment stub answers any params, so read the call.
    expect(insert.params[0]).toBe(TENANT)
    expect(insert.params[1]).toBe(BUNDLE)
    expect(JSON.parse(insert.params[2] as string)).toEqual({ campaignId: CAMPAIGN, status: 'ACTIVE' })
    // NULL, not draft.receiptId: the receipt does not exist at this instant.
    expect(insert.sql).toMatch(/'queued', NULL\)/)
  })
```

with `const ACTION = '88888888-8888-4888-8888-888888888888'` and `const RECEIPT = '99999999-9999-4999-8999-999999999999'`, matching the id style already in the file. Also assert `calls('INSERT INTO audit_receipts').at(-1)!.params` carries `ACTION` as `committed_record_id` (position six in the statement at `src/db/pending-writes.ts:687-692`), because that link is what lets a reviewer trace a receipt to the work order it signed.

- [ ] **Step 5: Integration proof 4**

New `tests/integration/marketing-campaign-status.test.ts`, following `tests/integration/marketing-publish.test.ts` for the fixture shape (`migrate(pool)` in `beforeAll` at `:75`, `commitWithReceipt` at `:227`, `describe.skipIf(!url)`):

1. Unique ids in the file's `a5` band. A tenant, a bundle, and one succeeded `create_campaign` row with `result` `{"externalId": "<CAMPAIGN>"}` and `payload` `{"adAccountId": "act_123"}`.
2. `stageCampaignStatusChange({ tenantId, userId: ANALYST, bundleId: BUNDLE, campaignExternalId: CAMPAIGN, status: 'ACTIVE', reason: 'cost_per_lead_below_5', userRole: 'admin' })`, with `registerActionAdapter` in force so the executability guard passes.
3. `getPendingWrite(draftId, TENANT)`, then `commitWithReceipt(draft, { approvedBy: APPROVER, scope: 'marketing:status' })`.
4. Assert exactly one `set_campaign_status` row for the bundle, `status = 'queued'`, `receipt_id IS NULL`, payload `{ campaignId, status }`, and `audit_receipts.committed_record_id` equal to that row's id. This is the spec's proof that an approval now produces the work order rather than a 500.
5. Register `makeSetCampaignStatusAdapter({ accessToken: 'test-token', adAccounts: ['act_123'], fetchImpl })` where `fetchImpl` is a local function that records its arguments and resolves `{ ok: true }` with `{ success: true }` JSON, then `await drainOnce({ pool, bundleId: BUNDLE })`. Assert the recorded URL ends with the campaign id and the recorded body is `{"status":"ACTIVE"}`, then assert the row is `succeeded`. Passing `bundleId` is not cosmetic: the integration database is shared across files, and Vitest runs them in parallel workers, so a drain without the scope would claim another file's queued rows.

- [ ] **Step 6: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/db/marketing-commit.test.ts tests/db/pending-writes-commit.test.ts
npx vitest run --project integration tests/integration/marketing-campaign-status.test.ts
npm run typecheck
npm run lint
```

Expected: unit green both times, integration green with the URL exported, and the report naming that file as run rather than skipped.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git add src/db/pending-writes.ts tests/db/marketing-commit.test.ts tests/integration/marketing-campaign-status.test.ts
git commit -m "feat(marketing): approving a campaign status draft queues the work order"
```

---

### Task 17: `marketing.set_campaign_status` joins the registry

**Files**

- Modify `src/marketing/payload.ts` (new `campaignStatusPayload`)
- Modify `src/mastra/tools/marketing-writes.ts` (the new tool, and the two payload sites)
- Modify `src/mastra/agent.ts` (import at `:36`, registry key after `marketing.generate_assets` at `:89`)
- Modify `src/mastra/instructions.ts` (the marketing section, `:80-100`)
- Test `tests/mastra/marketing-campaign-status-tool.test.ts`, `tests/mastra/agent.test.ts:50-53`

**Interfaces this task produces:** `setCampaignStatusTool` (id `marketing.set_campaign_status`), `campaignStatusPayload({ campaignId, status })`, `stageCampaignStatusChange(...): Promise<{ pendingWriteId: string; riskScore: number }>`, a 42-key `crumToolRegistry`.

**Why this is the residual.** The registry holds 41 tools (`src/mastra/agent.ts:48-90`) and the admin's active list holds 42 (`tests/mastra/active-tools.test.ts:49-62` and the `ADMIN_EXPECTED` count at `:72`), because `resolveActiveTools` is derived from `policy/tools.yaml` and never asks the registry whether the tool exists. So since slice 3 the agent has been told, in every turn, that it may call `marketing.set_campaign_status`, and the call has no tool behind it. The governance triangle already has two of its three edges: the policy declares the tool (`policy/tools.yaml:281`, `class: approval`, `scope: marketing:status`, and `tests/governance/conformance.test.ts:56` already records `['approval', 'draftHash']`), and the guard lists it. Only the registry edge is missing, which is why this task needs no conformance change.

- [ ] **Step 1: One payload builder, used by both hooks**

`promoteBundleTool` scores `promotePayload({...})` in `requireApproval` and stages the same builder's output in `execute` (`src/mastra/tools/marketing-writes.ts:927-936`, `:635` onward), and `src/marketing/payload.ts` is where those builders live. Add:

```ts
/**
 * The campaign status payload. Identifiers and a status only: the analyst's
 * reason is prose the model wrote, and scoreRisk stringifies the payload, so a
 * reason in here would make the approval gate depend on the phrasing rather than
 * on the change. Both hooks need the same view, which is why it is a builder.
 */
export function campaignStatusPayload(input: {
  campaignId: string
  status: 'ACTIVE' | 'PAUSED'
}): { campaignId: string; status: 'ACTIVE' | 'PAUSED' } {
  return { campaignId: input.campaignId, status: input.status }
}
```

and switch `stageCampaignStatusChange`'s inline literal (`src/mastra/tools/marketing-writes.ts:866`) to it, so a plan shape cannot be understood two ways in two places.

- [ ] **Step 2: The staging function carries its score out**

`StageOutputSchema` (`:305-312`) requires `riskScore: z.number().int().min(0).max(100)`, and a chat answer that reports a bogus score is worse than one that reports none. Change the return type at `:818` to `Promise<{ pendingWriteId: string; riskScore: number }>` and the last line of the function to:

```ts
  return { pendingWriteId: draft.id, riskScore: draft.riskScore }
```

`scripts/analyst-cron.ts:314` becomes `const staged = await stageStatus(...)` with `stagedDrafts.push({ campaignId: rec.campaignId, status, draftId: staged.pendingWriteId })`. The `stagedDrafts` shape does not change, so `tests/integration/analyst-cron.test.ts` needs nothing beyond the `analystUserId` it gained in Task 15; the unit file's `expect(draftId).toBe(DRAFT_ID)` assertions become `expect(result.pendingWriteId).toBe(DRAFT_ID)`.

- [ ] **Step 3: The tool**

`src/mastra/tools/marketing-writes.ts`, after `promoteBundleTool`. The shape is `promoteBundleTool`'s (`:910-978`) because the job is the same: a synchronous `requireApproval` that cannot read a database, and an `execute` that stages the real thing.

```ts
export const setCampaignStatusTool = createTool({
  id: 'marketing.set_campaign_status',
  title: 'Set Campaign Status',
  description:
    'Ask the owner to approve pausing or activating one campaign this tenant created. Stages one approval and changes nothing until the owner approves and the publisher drains the work order.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    bundleId: z.string().uuid(),
    campaignExternalId: z.string().trim().min(1).max(64),
    status: z.enum(['ACTIVE', 'PAUSED']),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe('Why you recommend this change. It reaches the owner in chat, not the scored payload.'),
  }),
  outputSchema: StageOutputSchema,
  outputValidation: 'warn',

  requireApproval: (input, { requestContext } = {}) => {
    const policy = loadPolicy()
    // The campaign id is not knowable here without a read, and this hook must
    // stay synchronous and side-effect free, so it scores an empty one. The
    // payload is identifiers and a status, so the declared class decides the gate
    // whatever the placeholder holds; execute recomputes on the real payload.
    const assessment = scoreRisk(
      campaignStatusPayload({ campaignId: '', status: input.status }),
      policy.risk,
      'marketing.set_campaign_status',
    )
    const rc = requestContext?.all as Record<string, unknown> | undefined
    return (
      policy.gateFor('marketing.set_campaign_status', assessment, { requestContext: rc }) === 'approval'
    )
  },

  execute: async (input, context) =>
    context.observe.span('marketing.set_campaign_status', async () => {
      const rc = context.requestContext.all as { tenantId: string; userId: string; userRole: string }
      try {
        const staged = await stageCampaignStatusChange({
          tenantId: rc.tenantId,
          userId: rc.userId,
          bundleId: input.bundleId,
          campaignExternalId: input.campaignExternalId,
          status: input.status,
          reason: input.reason,
          userRole: rc.userRole,
        })
        return {
          pendingWriteId: staged.pendingWriteId,
          riskScore: staged.riskScore,
          gate: 'approval' as const,
          // The reason is deliberately absent from the payload, so this is where
          // the analyst's argument reaches a human. The draft the owner reviews
          // names the campaign and the status; the conversation carries the why.
          message: `Status change to ${input.status} staged for campaign ${input.campaignExternalId} (${input.reason}). Nothing changes at the provider until the owner approves and the publisher drains.`,
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        // Refusing as a queue entry rather than a thrown turn, the way promote
        // does: an owner reading a refusal can act on it, and a failed turn leaves
        // no record of why no campaign was touched.
        const humanTaskId = await createHumanTask(
          {
            tenantId: rc.tenantId,
            runId: `campaign_status:${input.campaignExternalId}`,
            toolName: 'marketing.set_campaign_status',
            riskScore: 0,
            title: `Refused status change for campaign ${input.campaignExternalId}`,
            body: `Not staged: ${why}. No campaign was changed.`,
            requestedBy: rc.userId,
          },
          'refusal',
        )
        return {
          pendingWriteId: humanTaskId,
          riskScore: 0,
          gate: 'approval' as const,
          message: `Campaign status change refused (${readableReason(tokenOf(why))}). A human task was created; nothing was staged and no campaign changed.`,
        }
      }
    }),
})
```

`readableReason` (`:906`) already turns a token into a sentence; add the two tokens this tool can surface from Task 15 to `REFUSAL_PROSE` (`:899-905`): `campaign_not_found` as "no campaign with that id was created by a publish this tenant completed" and `provider_not_configured` as "this process has no campaign status adapter, so the change could not be run". `campaign_already_active` reads honestly after the underscore replacement, and `campaign_status_actor_required` cannot reach a chat turn.

`tokenOf` is a two-line local, next to `readableReason`:

```ts
// Every refusal this function raises opens with its token and a colon, so the
// prose map can be consulted without a second registry of error classes.
function tokenOf(message: string): string {
  const colon = message.indexOf(':')
  return colon > 0 ? message.slice(0, colon) : message
}
```

- [ ] **Step 4: The registry, the count, the instructions**

`src/mastra/agent.ts`: extend the import at `:36` with `setCampaignStatusTool`, and add `'marketing.set_campaign_status': setCampaignStatusTool,` after `'marketing.generate_assets'` (`:89`). `tests/mastra/agent.test.ts:50-53` becomes:

```ts
  it('has 42 tools configured (22 read + 7 auto + 13 approval)', async () => {
    const tools = await crmAssistant.listTools()
    expect(tools).toBeDefined()
    expect(Object.keys(tools).length).toBe(42)
  })
```

The split in the title is what the policy declares for an admin (`tests/mastra/active-tools.test.ts` lists 22 read-only at `:12`, 7 auto at `:38`, and 13 approval at `:49`, and asserts the 42 at `:72`), and 42 is the number `resolveActiveTools` has been promising since slice 3.

`src/mastra/instructions.ts`, one paragraph at the end of the marketing section (after `:99`):

```html
    <p>Scale and kill decisions reach the owner through
    <code>marketing.set_campaign_status</code>, which stages one approval and changes
    nothing itself. Ask for it when the evidence supports a pause or an activation,
    name the reason in the conversation, and never tell the owner a campaign is
    active or paused because the change only exists once a human approves it and the
    publisher drains it.</p>
```

- [ ] **Step 5: Tests for the tool, not only the function**

In `tests/mastra/marketing-campaign-status-tool.test.ts`, mock `../../src/db/pending-writes` partially for `createHumanTask` (the file already does this for `getOrCreateDraft`, `:11-15`) and drive the tool the way `tests/mastra/marketing-publish-tools.test.ts:33` builds its `context`:

```ts
const rc = { tenantId: TENANT, userId: USER, bundleId: BUNDLE_ID, userRole: 'admin' }
const context = {
  requestContext: { all: rc },
  observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
} as never
```

Four cases: `requireApproval` returns true for a `{ status: 'PAUSED' }` input, because the declared class is approval whatever the placeholder campaign id holds; a successful `execute` returns the draft id and the score the draft carried, and its message quotes the reason; a `campaign_not_found` throw comes back as a refusal output rather than a rejected promise, with `createHumanTask` called once with `'refusal'` and `pendingWriteId` equal to the human task id; and an `input.reason` of 500 characters passes while 501 does not, because the reason is the only prose this tool accepts and it must not become a place to park an essay.

- [ ] **Step 6: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts tests/mastra/active-tools.test.ts tests/mastra/marketing-publish-tools.test.ts tests/governance/conformance.test.ts
npx vitest run --project integration tests/integration/analyst-cron.test.ts tests/integration/marketing-campaign-status.test.ts
npm run typecheck
npm run lint
```

Expected: green, and `tests/governance/conformance.test.ts` unchanged and green, which is the evidence that the policy edge of the triangle was already there.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git add src/marketing/payload.ts src/mastra/tools/marketing-writes.ts src/mastra/agent.ts src/mastra/instructions.ts scripts/analyst-cron.ts tests/mastra/marketing-campaign-status-tool.test.ts tests/mastra/agent.test.ts
git commit -m "feat(marketing): the campaign status decision becomes callable, and reachable"
```

---

### Task 18: The guard list is derived, and finds four missing tools

**Files**

- Modify `src/mastra/processors/write-claim-guard.ts` (`MUTATING_TOOL_IDS`, `:8-25`)
- Modify `src/mastra/agent.ts` (one word: `export const crumToolRegistry`)
- Test `tests/mastra/processors/write-claim-guard.test.ts` (`:36-59` replaced)

**Why derivation is the fix.** `tests/mastra/processors/write-claim-guard.test.ts:58` asserts `toHaveLength(16)` against a hand-written array. Nothing derives 16, and nothing connects the array to the two things it has to agree with, which is the exact drift that produced R6: a tool in the guard list and in the policy and in the object-type CHECK, absent from the registry and unreachable from `applyDraft`. Deriving it also finds a live bug in four lanes. `ranMutatingTool` (`src/mastra/processors/write-claim-guard.ts:80`) answers true only for ids on the list, and `crm.draft_outreach`, `crm.send_outreach`, `crm.save_prospect_snapshot` and `crm.resolve_merge_candidate` all mutate, all sit in the registry (`src/mastra/agent.ts:80-84`), and are all missing. A turn that really sent an outreach and then says "I've sent it" therefore looks, to this processor, exactly like a turn that hallucinated the send, and the guard retries and then rewrites an answer that was true.

- [ ] **Step 1: Replace the literal with the three derived assertions**

In `tests/mastra/processors/write-claim-guard.test.ts`, delete the `MUTATING_TOOL_IDS lists every write tool by registry id` case at `:36-59` (the sixteen `toContain` calls and the `toHaveLength(16)`) and add at the top:

```ts
import { crumToolRegistry } from '../../../src/mastra/agent'
import { loadPolicy } from '../../../src/governance/policy'

// The policy is read through the same loader the runtime uses, so this file and
// src/mastra/processors/write-claim-guard.ts ask one source one question rather
// than maintaining a second parser that can disagree with the first.
const REGISTERED = Object.keys(crumToolRegistry)
const DECLARED_MUTATING = loadPolicy()
  .tools.tools.filter((tool) => tool.class !== 'read-only')
  .map((tool) => tool.name)

/**
 * Declared mutating, not callable. run.side-effect is a workflow label whose scope
 * is resolved at run time, and crm.bulk_import is declared in the policy and
 * implemented nowhere. Both belong in a test as a named backlog: a gap that is
 * written down stays a known hole, and a gap that disappears behind a filter nobody
 * checks becomes a blind spot.
 */
const DECLARED_BUT_NOT_CALLABLE = ['crm.bulk_import', 'run.side-effect']
```

and three cases:

```ts
  it('guards exactly the mutating tools the agent can actually call', () => {
    expect(MUTATING_TOOL_IDS.slice().sort()).toEqual(
      DECLARED_MUTATING.filter((name) => REGISTERED.includes(name)).sort(),
    )
  })

  it('guards nothing the registry does not hold', () => {
    // The assertion that would have caught R6 on its own. A guarded id that is not
    // a tool is not a bug in the guard, it is a bug in the lane it names, and this
    // makes that unmissable.
    for (const id of MUTATING_TOOL_IDS) {
      expect(REGISTERED).toContain(id)
    }
  })

  it('names every declared mutating tool the registry is missing', () => {
    expect(DECLARED_MUTATING.filter((name) => !REGISTERED.includes(name)).sort()).toEqual(
      DECLARED_BUT_NOT_CALLABLE.slice().sort(),
    )
  })
```

The intersection in the first case is what the spec's hand-written exception list would otherwise have had to do, and it is 20 names: 22 declared mutating (7 auto, 14 approval, 1 refuse) minus the two backlog ids.

- [ ] **Step 2: Run it RED**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/processors/write-claim-guard.test.ts
```

Expect the first case to fail naming the four `crm.*outreach*`, `crm.save_prospect_snapshot`, `crm.resolve_merge_candidate` ids as missing, and the third case to pass, because Task 17 already put `marketing.set_campaign_status` in the registry. If the third case fails instead, the registry edit did not land, and Task 17 is not done.

- [ ] **Step 3: Add the four ids**

`src/mastra/processors/write-claim-guard.ts`, after `'crm.transfer_owner'` (`:17`) and before `'mail.send'`, keeping the file's rough order-by-lane shape:

```ts
  // Prospect-lane writes. Each one mutates, each is callable today, and none was
  // here: a turn that genuinely sent an outreach and reported the send read, to
  // this processor, exactly like a turn that invented it.
  'crm.draft_outreach',
  'crm.send_outreach',
  'crm.save_prospect_snapshot',
  'crm.resolve_merge_candidate',
```

`MUTATING_TOOLS` (`:27`) is derived from the array, so it needs no edit. `src/mastra/agent.ts:48` becomes `export const crumToolRegistry = {`. It is a module-local const today, and exporting the object the module already builds does not widen what the process publishes.

- [ ] **Step 4: One behavioural case for the outreach lane**

The file already drives the processor directly with a hand-built args object (`:106-124`). Add the case that says why the four ids matter:

```ts
  it('leaves a true report of a send alone now that crm.send_outreach is guarded', () => {
    const calls: string[] = []
    const args = {
      text: "I've sent the outreach to Nordwind.",
      toolCalls: [{ toolName: providerToolName('crm.send_outreach') }],
      steps: [],
      retryCount: 0,
      messages: [],
      abort: (reason: string) => calls.push(reason),
    } as never
    new WriteClaimGuardProcessor().processOutputStep(args)
    expect(calls).toEqual([])
  })
```

Before Step 3 this aborts with `write-claim-without-tool` over a send that happened, which is the false-positive class the file's own comment says killed the earlier version of the guard.

- [ ] **Step 5: Run**

```bash
cd D:/Code/CRUM
npx vitest run tests/mastra/processors/write-claim-guard.test.ts tests/mastra/agent.test.ts tests/mastra/processors tests/governance
npm run typecheck
npm run lint
```

Expected: green. `toHaveLength(16)` is gone and nothing in the file states a count, so the list can only agree with the policy and the registry or fail.

- [ ] **Step 6: Commit**

```bash
cd D:/Code/CRUM
git add src/mastra/processors/write-claim-guard.ts src/mastra/agent.ts tests/mastra/processors/write-claim-guard.test.ts
git commit -m "fix(governance): the write-claim guard is derived from policy and registry"
```

---

### Task 19: Prove the slice, walk it once with a real picture, and write it down

**Files**

- Create `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md`

**This task owns no code.** It runs what Tasks 1 to 18 produced, compares the shape against the recorded slice-4 baseline, walks the flow with one real Replicate image on one real page, and writes the report. Per the standing rule, no claim about R1 is made without the walkthrough.

- [ ] **Step 1: The named unit suites**

```bash
cd D:/Code/CRUM
npx vitest run tests/marketing tests/db tests/api tests/config tests/governance
npx vitest run tests/mastra
```

Explicit directories, never a bare `npx vitest run` and never `npm run test`: `tests/evals/golden-gate.test.ts` is inside the unit project and spends roughly twelve model-minutes of the owner's paid credit. The golden gate does not run in this slice. Record that choice in the report rather than leaving it as an absence.

Baseline to compare against, from `docs/superpowers/plans/2026-11-01-marketing-team-slice-4-verification.md`: `tests/marketing` 206, `tests/governance` 248, `tests/mastra` 496, `tests/db` 149, `tests/api` 282, `tests/config` 34. Report the new counts per directory and name every added case. A count that went down is a deleted test and must be explained.

- [ ] **Step 2: The integration proofs**

```bash
cd D:/Code/CRUM
export CRUM_INTEGRATION_DATABASE_URL="postgres://crum_test@localhost:5455/crum_slice5"
npx vitest run --project integration tests/integration/marketing-asset-page.test.ts tests/integration/marketing-asset-invalidation.test.ts tests/integration/marketing-image-spend.test.ts tests/integration/marketing-generate-assets.test.ts tests/integration/marketing-campaign-status.test.ts tests/integration/analyst-cron.test.ts
```

Those six files are the five proofs spec section 13 asks for, mapped as: proof 1 in `marketing-asset-page.test.ts` (Task 7), proof 2 in `marketing-asset-invalidation.test.ts` (Task 12), proofs 3 and 5 in `marketing-image-spend.test.ts` and `marketing-generate-assets.test.ts` (Tasks 8, 9 and 10), proof 4 across `marketing-campaign-status.test.ts` (Task 16) and `analyst-cron.test.ts` (Task 15). Add the existing integration files whose behaviour this slice moved: `tests/integration/marketing-publish.test.ts` (Task 5 changed what its hash is computed over), `tests/integration/reviewer-predictions.test.ts` (Task 14), `tests/integration/pending-writes.test.ts` (Tasks 11 and 16), and `tests/integration/migrations.test.ts` (Task 8 added a migration). Baseline to carry forward: `tests/integration/migrations.test.ts` has two failures that predate this slice. Name them again, unchanged, or explain what changed.

For every file: state whether it ran or skipped. `describe.skipIf(!url)` skips silently, and this slice exists partly because that skip hid a broken insert for two slices.

- [ ] **Step 3: The console**

```bash
cd D:/Code/CRUM/console
npx vitest run
npm run lint
npx tsc --noEmit
```

The console has its own Vitest project and no paid gate inside it, so an unfiltered run is the blessed form here; slice 4 used the same command from the same directory. Baseline: 24 files and 210 tests. Task 13 adds `console/tests/AssetManager.test.tsx` and extends `console/tests/KnowledgePage.test.tsx`, so report the new counts and confirm the invoice and contract tabs still read their own lists.

- [ ] **Step 4: The whole gate, reported honestly**

```bash
cd D:/Code/CRUM
npm run typecheck
npm run lint
```

Run these two, not `npm run verify`. `verify` chains `npm run test`, which reaches the golden gate, and it exits non-zero in this repository by design. The report states that `npm run verify` was not run and why, and states the typecheck and lint results as they came out.

- [ ] **Step 5: The manual walkthrough, one real image on one real page**

Owner-supplied credentials, never written to a file or a commit: `CRUM_REPLICATE_API_TOKEN`, `CRUM_META_ADS_ACCESS_TOKEN`, `CRUM_CLOUDFLARE_ACCOUNT_ID`, `CRUM_CLOUDFLARE_PAGES_PROJECT`, `CRUM_CLOUDFLARE_API_TOKEN`, `CRUM_ANALYST_USER_ID`, `CRUM_IMAGE_PROVIDER=replicate`, and both spend ceilings. If any is missing, stop and report the walkthrough as not done; that is a result, not a delay.

1. Boot the API and the console, and in chat ask the marketing lead for one campaign whose page calls for a picture. Let the designer produce the creative prompt set, save the bundle, and run `marketing.generate_assets` for one image, so the ceiling arithmetic is exercised at its real cost rather than a fixture's.
2. Confirm the PNG is in the Campaign images tab. If the bundle is staged and unpredicted, confirm the thumbnail slot shows the awaiting-review placeholder and that the byte route answered 409, and say which of the two you observed.
3. Review the asset, confirm the tab reloads it as `ready`, and record the `invalidatedBundles` count the review response returned. If the count is non-zero, re-stage and write the prediction, and note that the re-stage is what R2 is for.
4. Stage the bundle, predict, and have a second person approve it, so the reviewer is not the predictor.
5. Publish, then promote, then drain with `npx tsx scripts/publish-drain.ts`.
6. Open the live preview URL in Zen and look at the picture. This is the residual: an image that reaches a published page. Record the URL, the file name the manifest carried (`slug/assets/<uuid>.png`), and whether the HTML held the resolved path rather than the placeholder token.
7. Independently of the console, `curl` the byte route with the identity headers for that document, both before and after the prediction exists, and record the status codes.
8. Ask for one scale and one kill recommendation in chat. Confirm each stages a draft whose review row shows a uuid requester and a derived target, that approval queues exactly one `set_campaign_status` action, and that the drainer reports the campaign id Meta acknowledged. Confirm the owner was told nothing was live until it was.
9. Then run the cron once, with and without `CRUM_ANALYST_USER_ID`, and record that the second reports recommendations and stages nothing while the first stages drafts.

Report each numbered step as done, skipped with the reason, or failed with what was seen. Do not summarise the walkthrough as successful.

- [ ] **Step 6: Write the report**

Create `docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md` with these sections, in this order: what the slice changed, per residual what proves it closed (R1 to R6, then RV1 and RV2), what ran with the exact command and the counts, the integration files that ran versus the ones that skipped, the baseline comparison including the two `migrations.test.ts` failures, the walkthrough step by step, the decisions this slice took that a later reader will want recorded (the browse surface inheriting the gate, no automatic provider fallback, the two-layer ceiling, invalidation over re-hash, the derived guard list), the deviations from the plan with the reason for each, and the holes left open for slice 6. Carry the known holes forward: the pixel's post-hash deviation, `reason` living only in chat rather than in the draft, the missing `users` table behind `pending_writes.requested_by`, and `npm run verify` staying red by design.

Style, per the standing rule: plain language, no dashes used as punctuation, no semicolons, no divider lines, no table of contents. Naming a file or a column in backticks is fine; a hyphen between clauses is not.

- [ ] **Step 7: Commit**

```bash
cd D:/Code/CRUM
git status --porcelain -- docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md
git add -f docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md
git commit -m "docs(marketing): record what slice 5 proved, what it skipped, and what it left open" -- docs/superpowers/plans/2026-11-02-marketing-team-slice-5-verification.md
```

`docs/` is gitignored while its files are tracked, so the `-f` is required and the `-m` must precede the `--`.

---

## Self-review notes for the person executing this plan

1. Tasks 15, 16 and 17 touch `stageCampaignStatusChange` in that order, and each leaves the tree green: Task 15 changes its arguments, Task 16 changes what an approval of its draft does, Task 17 changes what it returns and who can call it. Do not merge them, and do not reorder them.
2. The missing-actor refusal is a cron-path guard. `rc.userId` is always present in a chat turn, so Task 17's tool cannot reach it and Task 15 tests it through the function directly. A reviewer asking why the chat tool has no test for `campaign_status_actor_required` should get that sentence rather than a new case.
3. Two tasks add a `calls()` style assertion because a fragment stub answers any parameters. If a step in this plan says "assert the params", read it as load-bearing: Task 4 and Task 5 of S5a hit the same collision, and the ordering note in Task 16 Step 1 is the fix.
4. No task in this plan calls Replicate, a model, or a real domain from an automated test. The only real-provider run is Task 19 Step 5, which the owner drives with their own token.
