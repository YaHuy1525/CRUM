# Document processing and data transformation: what is built and what is proven

This file replaces `ALL_PHASES_COMPLETE.md`. That name promised more than the code delivers.
Everything below is checked against the working tree on 2026-11-02. Each claim says which
command or which file backs it.

## 1. Status at a glance

| Phase | What exists in the tree | Proven by | Not proven |
| --- | --- | --- | --- |
| 1 Async intake | `src/queue/document-queue.ts`, `document-worker.ts`, `intake-run.ts`, `websocket-server.ts`, async routes in `src/api/documents.ts` | typecheck, lint, `tests/api/documents.test.ts` (14 tests) | no job has ever been consumed by a live worker on this machine |
| 2 OCR | `services/ocr/app.py`, `src/mastra/ocr.ts`, image branch in `src/mastra/workflows/document-intake.ts` | typecheck, lint, import is wired into intake | the sidecar image was never built or called |
| 3 Layout adaptation | `src/mastra/layout-clustering.ts`, `src/mastra/adaptive-extraction.ts` | typecheck, lint | nothing imports either module, no tests, no run |
| 4 Batch and multi-format | `src/queue/batch-queue.ts`, `batch-worker.ts`, `src/api/batch.ts`, `src/mastra/multi-format-parser.ts` | typecheck, lint, batch router mounted in `src/api/index.ts`, batch queue has a consumer | nothing imports `multi-format-parser.ts`, no tests for any of it, no run |
| 5 Temporal | `src/temporal/workflows/document-processing.ts`, `activities/document-activities.ts`, `worker.ts` | typecheck, lint | no Temporal server was ever contacted, no tests |
| 6 Live dashboard | `console/components/DocumentProcessingDashboard.tsx`, Processing tab in `console/app/knowledge/page.tsx` | console typecheck, lint, 6 new component tests, tab reachability test | never opened in a browser against a running stack |
| 7 Transformation pipeline | `src/transforms/pipeline.ts`, `src/transforms/functions.ts` | typecheck, lint | nothing imports them, no tests |

## 2. Commands that were run and what they printed

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` (root) | exit 0, no diagnostics |
| `npx eslint .` (root) | exit 0, no diagnostics |
| `npx vitest run --project unit tests/mastra/identity tests/api/serve tests/api/documents tests/config/env tests/build/pins` | 5 files passed, 104 tests passed |
| `npx tsc --noEmit` (console) | exit 0 |
| `npx next lint` (console) | exit 0, one pre-existing warning about the Next ESLint plugin |
| `npx vitest run` (console) | 25 files passed, 217 tests passed |
| `npm run test` (root, full) | 169 files passed, 2223 tests passed, 19 files skipped. The one failed file is `tests/evals/golden-gate.test.ts`, which runs live model calls and fails on this machine because the ambient `DATABASE_URL` presents a self-signed certificate; see section 7. |

## 3. Corrections to the earlier claims

1. Upload is asynchronous. `POST /api/documents/upload` answers `202` with `{ jobId, fileId,
   status: "queued" }`. It answers `503 { error: "queue-not-wired" }` when the queue cannot be
   resolved. It no longer runs intake inside the request, so no response carries `chunkCount` or
   `needs_review` any more.
2. Phase 5 is one coarse-grained activity. `runDocumentIntake` calls the same `runIntake` the
   BullMQ worker calls. The earlier draft that mirrored the seven intake steps as seven Temporal
   activities was wrong: `crum-document-intake` publishes one output object
   (`{ documentId, status, kind, confidence, chunkCount, indexName }`) and exposes no per-step
   boundary, so a per-step replication would have been invented, not derived.
3. The live lane is dev-mode only. A WebSocket handshake cannot carry an `Authorization` header
   and this console has no browser Supabase client, so `resolveSocketIdentity` in
   `src/mastra/identity.ts` accepts the query-string tenant and user pair only when
   `CRUM_AUTH_MODE=dev` and closes with `1008 missing-token` under `jwt`. Reading a bearer token
   off the URL was rejected because it lands in every proxy and history entry between the page and
   the port.
4. The container stack had no queue consumer before this pass. The api container boots the REST
   plane through `src/mastra/boot.ts`, which calls `startApiServer` and never reaches the `main()`
   in `src/api/serve.ts` where the workers start, so uploads would have stayed in the queue.
   `docker-compose.yml` now runs `redis` and a `worker` service on `npm run queue:worker`.
5. The dashboard used to be dead code. It was never mounted, it read identity from
   `localStorage`, and it dialled `ws://${window.location.host}`, which Next rewrites do not
   proxy. It is now mounted as the Processing tab, takes identity from the baked
   `NEXT_PUBLIC_CRUM_DEV_*` values, dials `NEXT_PUBLIC_CRUM_WS_ORIGIN`, and stops retrying when the
   server refuses on policy grounds.

## 4. What has never been executed

1. No document has been processed by a worker on this machine. Redis was not running, so the
   enqueue path, the retry path, the `document.progress` broadcast, and the batch consumer are all
   unexercised.
2. `services/ocr` was never built and `src/mastra/ocr.ts` was never called against a live
   Tesseract.
3. `src/temporal/worker.ts` was never connected to a Temporal server. Its API calls are written to
   the 1.25.0 typings and reviewed by hand only.
4. `POST /api/batch/upload` and the two batch read routes were never called.
5. `src/mastra/multi-format-parser.ts` has no importer. Single uploads accept `pdf, docx, txt, md,
   html, csv, json` and the intake workflow parses each of those through Docling, unpdf, mammoth,
   or the plain-text fallback. Batch uploads additionally admit `xlsx, xls, pptx`, but the intake
   workflow has no parser for any of those three, so a batch that contains one will produce a job
   that finishes with no usable blocks. The multi-format promise of Phase 4 is not met by the
   current wiring.
6. `src/transforms/*`, `src/mastra/adaptive-extraction.ts`, and `src/mastra/layout-clustering.ts`
   have no importer. They are libraries waiting for a call site.

## 5. How to make it real, in order

| Step | Command | What you should see |
| --- | --- | --- |
| 1 | `docker compose --env-file .env.compose up --build -d` | `db`, `redis`, `migrate`, `api`, `worker`, `console` healthy |
| 2 | `curl -F file=@fixture.pdf -H "x-tenant-id: ..." -H "x-user-id: ..." -H "x-user-role: admin" http://127.0.0.1:4113/api/documents/upload` | `202` with a `jobId` |
| 3 | `curl -H "..." http://127.0.0.1:4113/api/documents/status/<jobId>` | `state` moves from `waiting` or `active` to `completed` |
| 4 | open `http://127.0.0.1:3000/knowledge`, choose Processing, upload | the row appears, the bar moves, the badge lands on `completed` |
| 5 | `docker compose logs worker` | one `[DocumentWorker] Processing job` line per upload |
| 6 | `docker compose --profile ocr up -d ocr` and set `OCR_URL=http://ocr:8091` | an image upload returns blocks instead of the text fallback |
| 7 | `npm run queue:worker` locally with `REDIS_URL` set | the same lane without Docker |

Steps 1 to 5 are the gate. Until they pass, treat phases 1, 4, and 6 as built but unproven.

## 6. Known gaps worth deciding on next

1. Wire `multi-format-parser.ts` into `crum-document-intake` or delete it. Both are honest. Leaving
   it imported by nothing while a doc claims seven formats is not.
2. Add tests for the queue modules. They are the only new code with real failure modes (retry
   accounting, progress typing, worker shutdown), and `src/queue/websocket-server.ts` cannot be
   imported in a unit test today because loading `document-queue.ts` opens a Redis connection.
3. Give the live lane a jwt-mode story, or document polling as the jwt answer.
4. `src/temporal/*` is unused by every entry point. Either mount it behind a flag or move it under
   `src/experimental/`.
5. The two remaining orphan libraries (adaptation and transforms) need a call site in intake to
   earn their place.

## 7. Verification noise to expect

`tests/evals/golden-gate.test.ts` runs live model calls and live scorers. On this machine the
ambient `DATABASE_URL` presents a certificate that Node rejects with `SELF_SIGNED_CERT_IN_CHAIN`,
so every memory save in the gate fails and the three scored tests report failure. That file is not
touched by this work. The same run leaves `MASTRA_VECTOR_PG_CREATE_INDEX_FAILED` blocks in the log
for the same reason. The other 169 files (2223 tests) pass.
