# CRUM Console Redesign: Information Architecture and Chats Section

Date: 2026-10-26
Status: design approved in brainstorming, pending written spec review
Scope: the Next.js console under `console/` and the read and manage API surface for conversations and CRM records under `src/api/`

## Purpose

The console today puts the whole workbench on Home. One page holds the thread list, the live chat, the greeting, quick actions, the customer context bind, and two live metric cards. Saved conversations cannot be reopened because the stored transcript is never served back to the browser. Picking an old conversation remounts an empty pane.

This redesign gives the console a production grade information architecture. Conversations get their own section where they are launched, saved, listed, searched, renamed, deleted, and reopened with their full transcript. Governance, knowledge, and CRM records get focused pages. Home becomes a dashboard of pointers. The visual language evolves the existing graphite and emerald token system onto a real component foundation, learning from the calm density and honest states of the reference product Cedar without copying it.

## Approved decisions

1. Grouped sidebar with a Pages group (Home, Governance, Knowledge, Records) and a Chats group (New chat action, All conversations entry). The sidebar holds navigation only. Conversation history lives inside the Chats section.
2. Route per conversation. `/chats` is the searchable history index, `/chats/new` is the launch view, `/chats/[id]` is one reopenable and deep linkable conversation.
3. Launch pages are Home, Governance, Knowledge, Records, and the Chats section. Usage stays a live route entered from the Home quick launchers and by URL, and is not in the sidebar at launch.
4. UI foundation is shadcn/ui primitives on Radix with Tailwind mapped onto CRUM design tokens, plus lucide-react icons. TanStack Query owns server state.
5. Visual language evolves the current graphite and emerald tokens into a documented design system. Dark only. No light theme in this project.
6. Migration is phased: baseline and hygiene, foundation, Chats backend, Chats UI, page migrations, polish. Every phase stays shippable and verified.
7. History scope is per user at launch because storage isolates threads by tenant and user. A workspace wide conversation view is a future backend decision and is not promised here.
8. New capability arrives as HTTP endpoints only. No new Mastra tools, so the governed tool registry and its four file test fan-out stay untouched.

## Route map

| Route | Purpose |
|---|---|
| `/` | Home dashboard. Greeting header, awaiting decision card, today digest card, recent conversations card, quick launcher row. No composer, no transcript, no session column, no context bind form. |
| `/chats` | Chats section home. Search field, history rows with title and relative last activity, per row rename and delete menu, New chat action. Search hits carry matching snippets. |
| `/chats/new` | Launch view. Centered composer with the single reserved prompt gradient and starter prompt cards. Sending mints the thread and redirects into it. |
| `/chats/[id]` | One conversation. Stored transcript hydrates first, live streaming continues in place. Inline title rename, customer context side panel, feedback thumbs on assistant answers, Stop wired to the interrupt signal. |
| `/governance` | Approval queue and receipts. Pending and decided tabs, draft level decisions, signature verdicts, queue count badge in the page header. Replaces `/approvals`. |
| `/knowledge` | Document upload, list, delete, re-ingest with honest duplicate messaging. Behavior unchanged from today. |
| `/records` | CRM objects with sub-tabs: Customers, Contacts, Follow-ups, Tasks, Schedules. Backed by new read only list endpoints. |
| `/records/new` | Capture flow, formerly `/new`. Paste text, parser previews fields honestly, hand off to a new chat prefilled with them. Never creates rows silently. |
| `/records/customers/[id]` | Customer detail with related contacts, follow-ups, and tasks beneath. Replaces the orphaned `/customer/[id]`. |
| `/usage` | Token, cost, and tool metrics. Not in sidebar. Entered from Home launchers and by URL. |

Redirects keep old links working: `/approvals` to `/governance`, `/today` to `/`, `/new` to `/records/new`, `/customer/[id]` to `/records/customers/[id]`. The standalone `/today` page retires and its digest folds into Home.

## App shell

One `AppShell` renders the sidebar and a main column. The sidebar shows the brand, the Pages group, the Chats group, and a footer with workspace and user identity read from the real injected identity instead of the hard coded dev chip used today. Each page renders its own header row with title and contextual actions inside a consistent max width content column. Nested route layouts give the Chats section its own shell so list and conversation views share context. Route level `loading.tsx`, `error.tsx`, `not-found.tsx`, and `global-error.tsx` appear for the first time.

## Design system foundation

Tokens stay the source of truth. `console/app/theme.css` keeps every token and Tailwind maps colors, spacing, radii, typography, shadows, and motion onto those variables, so utilities consume one language. The 1810 line global stylesheet shrinks as components migrate and is deleted in the polish phase. The token import becomes impossible to drop silently because the Tailwind theme layer references the token file explicitly.

Initial primitive batch from shadcn/ui: button, input, textarea, label, tabs, dialog, dropdown-menu, tooltip, skeleton, separator, badge, toast, avatar. Dialogs and menus provide accessible rename and delete confirmations and row actions. Icons move from duplicated inline SVG fragments to lucide-react.

Typography and density: 14px base for information density, light weight serif display headings in Source Serif 4, Inter for UI, JetBrains Mono for ids and metrics, all self hosted through `next/font` instead of a blocking external request.

State recipes as written rules: skeleton while reading, honest error with retry that names the unreachable plane and port, distinct empty copy per entity, streaming cursor as a 2px accent block, tool calls as a collapsed mono inspector, assistant messages quiet and unbubbled capped near 68ch, user messages as right aligned pills.

Motion: 120ms and 180ms durations on the existing easing curve, with `prefers-reduced-motion` respected.

Accessibility bar: visible focus ring on every interactive element, labels on icon only buttons, focus trapped dialogs, keyboard reachable nav and thread list, `role="log"` transcript with live region preserved.

Testing contract: components expose stable roles, labels, and test ids. Existing tests migrate off raw class name selectors as each component moves.

## Chats section

### Backend

One new Hono router mounted into `createApiRouter` in `src/api/index.ts`, served on the REST plane and proxied by the existing console rewrite. No database migration and no new dependency. The pinned memory layer already exposes recall, getThreadById, updateThread, deleteThread, and searchMessages, reachable through the established `mastra.getMemory('coreMemory')` accessor.

| Endpoint | Behavior |
|---|---|
| `GET /api/agent/threads` | Existing. History index list for the caller's resource. |
| `GET /api/agent/threads/:id` | Thread metadata and existence check so stale links resolve to not-found. |
| `GET /api/agent/threads/:id/messages` | Paginated stored messages converted from the framework storage shape into the chat UI message shape by a new unit tested mapping module. Tool call and reasoning parts are the hard cases. |
| `PATCH /api/agent/threads/:id` | Rename title with `metadata.titlePinned` set so auto titling never overwrites a user rename. |
| `DELETE /api/agent/threads/:id` | Delete thread and its messages. UI confirms with a dialog naming the conversation. |
| `GET /api/agent/search?query=` | Semantic message search scoped to the caller's resource, returning thread hits with snippets. |

Every endpoint resolves identity from the request, derives the resource id from it, accepts no client supplied resource id, and re-filters results by owner, matching the defense already proven on the thread list. Another user's thread reads as not-found, never as data.

Auto-title: when the first turn of a thread lands on the chat route, the server sets the title from a truncation of the first user message unless a pinned title exists. No LLM summarization in this project.

### Frontend

`/chats` lists history through TanStack Query with skeleton rows, honest error with retry, and a distinct empty state. Rows show title and relative last activity while search results show matching snippets. Search debounces into the search endpoint. Row menus offer rename and delete. Delete and rename mutations invalidate the list, and rename applies optimistically.

`/chats/new` shows the launch composer and starter prompt cards drawn from a curated static set in a single console config module. Sending mints the thread id in the browser as today, navigates to `/chats/[id]`, and starts streaming there.

`/chats/[id]` hydrates the stored transcript through the messages endpoint into `useChat` via `setMessages`, shows a skeleton while loading, then continues live streaming with the resume flag for in flight runs. It renders quiet assistant messages, user pills, the collapsed tool inspector, the streaming cursor, thumbs feedback posting to the existing `/api/feedback` endpoint using trace and span ids extracted from stored message metadata by the mapping module, and if the pinned storage shape lacks those ids then Phase 2 records the limitation and the control defers to the backlog rather than shipping a fake vote, Stop wired to `/api/signals/interrupt`, inline title rename, and the customer context bind as a conversation side panel moved off Home.

## Page migrations and Home dashboard

Home composes three named and testable card components extracted from the current inline home file: an awaiting decision card reading pending approvals, a today card reading the digest, and a recent conversations card reading the thread list. A quick launcher row offers New chat, Capture from text, Knowledge, and Usage. The two live metric fetchers that sit inline in the home file today become these components and gain tests.

Governance and Knowledge migrate their existing components with behavior unchanged and styling moved onto primitives.

Records gains read only list endpoints for customers, contacts, follow-ups, tasks, and schedules under a new `/api/crm` router. They reuse the same visibility predicates the agent read tools enforce, are paginated, and support simple filters. The customer detail page shows related objects beneath the header. The Capture flow keeps its honest preview and gains a hand off button that opens `/chats/new` prefilled with the parsed text.

## States and error handling

Every route gains loading, error, and not-found surfaces. Identity misconfiguration surfaces once as a setup instruction banner using the existing error description convention instead of scattered card failures. Mutations show in flight state, confirm dialogs gate destructive acts, and toasts report outcomes. A failure never renders as empty anywhere in the console.

## Testing strategy

Unit tests cover the message shape mapping including tool and reasoning parts and pagination, every new endpoint including the cross user not-found property, and title derivation.

Console tests cover each new page across loading, empty, and error states, the launch and conversation views, dashboard cards, and Records tabs. Existing chat and session tests migrate to role and label selectors as their components move. The currently empty shell test gap gains real tests for sidebar groups, active states, and redirects.

Gates per phase: console typecheck clean, console suite green, root suites unaffected because endpoints are additive.

## Phasing

Phase 0: commit the current uncommitted theme work as a clean baseline and clear the pre-existing root typecheck debt so later gates mean something.

Phase 1: foundation. Tailwind on tokens, primitive batch, icons, self hosted fonts, new app shell with grouped sidebar, route skeleton with redirects, route level state trio, TanStack Query provider.

Phase 2: conversation backend. Messages read, metadata read, rename, delete, search, auto-title, mapping module, and their tests.

Phase 3: Chats UI. Index, launch view, conversation view with hydration, tool inspector, and context panel. Shipped without the feedback control, because the stored message shape carries no trace or span ids. Recorded as C1 in `docs/superpowers/plans/99-later-backlog.md` rather than shipped as a control that could not vote.

Phase 4: page migrations. Governance, Knowledge, Records with list endpoints, Home dashboard, retired pages behind redirects.

Phase 5: polish. Delete the legacy global stylesheet, accessibility pass, responsive pass to the specified breakpoints, reduced motion audit, final verification.

## Verification and definition of done

Each phase ends with console typecheck and console suite green. The project ends with live stack verification: boot the real stack, start a conversation with a real model turn, reopen it from history to prove the transcript restores, and exercise rename, delete, and search in a browser with screenshots. Delivery reports state the proven runnability tier and list every unmet external requirement such as missing keys or unset environment variables. Green tests alone are never presented as a working system.

## Out of scope

Light theme. Workspace wide conversation history. LLM based thread summarization. Mail and Telegram channels. Observational memory enablement. Zustand. Visual regression infrastructure. Rebuilding the containerized console image, which remains a separate ops task.

## Risks and assumptions

The message mapping is new code with no vendor helper, so its unit tests are the contract. Auto-title is deterministic truncation, which is honest but plain. The root typecheck starts red with pre-existing errors and Phase 0 must clear it before gates are trusted. The working tree carries uncommitted theme work that Phase 0 commits first. Records list endpoints must reuse tool visibility predicates or governance parity breaks. The chat transport, identity middleware, and storage isolation conventions are unchanged by this design.

## Phase log

**Phase 0, baseline.** Theme work committed, pre-existing root typecheck debt cleared, root lint green.

**Phase 1, foundation.** Tailwind mapped onto the token file, the shadcn primitive batch, lucide icons, self hosted fonts, the grouped sidebar shell, the route skeleton with redirects, and the TanStack Query provider. Commits `07b66c3` for the shell and foundation, `5fcacbd` for the token re-theme.

**Phase 2, conversation backend.** Six endpoints on the REST plane, the message mapping module, auto-title on the first turn, and their tests. Commit `4a75ccc`. Two contract asymmetries were found and carried forward rather than papered over. The list row omits `title_pinned`, recorded as C2 in the backlog. Stored messages carry no trace or span ids, recorded as C1.

**Phase 3, Chats UI.** `ConversationList` on TanStack Query with skeleton, honest error and retry, empty state, debounced semantic search, optimistic rename and confirmed delete. `LaunchView` with the single reserved gradient token and the curated starters, minting the thread id in the browser and handing the first message through `sessionStorage`. `ConversationView` hydrating a stored transcript through `setMessages`, refusing to render another user's thread as an empty conversation, continuing live streaming in place, and stopping through the interrupt signal. `ContextPanel` moved off Home into the conversation side column and the Home rail from one implementation.

Three deletions came with it, each because a second copy of the same behaviour is a drift waiting to happen. `ChatPane` and its test were replaced by `ConversationView` and `ConversationView.test.tsx`, which keeps every transport contract the pane proved and adds hydration, the launch handoff and the interrupt. The duplicate `CustomerPanel` inside `components/ObjectPanel.tsx` was removed and its cases moved to `tests/ContextPanel.test.tsx`. The Home context bind form was removed in favour of the panel.

**What Phase 3 is not.** No feedback thumbs, see C1. No route level `loading.tsx`, `error.tsx` or `not-found.tsx` outside the conversation view's own not-found path, which belongs to the Phase 5 pass per the app shell section. Home still mints its own thread id and renders a live transcript, which is what Phase 4 replaces with the dashboard of pointers.

**Phase 3 verification, what was actually run.** Console `tsc --noEmit` clean. Console suite `vitest run` green at 11 files and 87 tests. Root `tsc --noEmit` clean. Root `eslint .` clean. Console `next lint` reports no warnings and no errors, with one standing note that the Next plugin is not registered in the console ESLint config.

**Runnability tier for Phase 3: console renders, data plane unverified.** The console dev server served `/`, `/chats`, `/chats/new` and `/chats/<id>` at HTTP 200, and the served markup contains the expected surfaces, being the conversations header and search field, the launch composer with the reserved gradient token, and the context panel with its bind form. The REST proxy through `/api/agent/threads` answered 500 because no REST plane was listening, so every list and transcript read in this run reached the honest error path and nothing more.

The block is external and is not a console defect. `DATABASE_URL` points at `db.tjvalzjxameymtqbloor.supabase.co`, which fails name resolution with `getaddrinfo ENOENT`, so the Mastra dev server exits during boot on its restart pass. Pointing the stack at a reachable Postgres is what the next live run needs, and three routes are open to it. Restore the Supabase project, start the Docker daemon and use the compose database on `postgres:changeme`, or supply a local database with the migrations in `migrations/` applied. Until one of those is true, no model turn, transcript restore, rename, delete or search has been exercised against a real database, and this phase does not claim otherwise.

**Phase 4, page migrations.** The CRM read surface is a new `/api/crm` router in `src/api/crm.ts` with six routes: paged lists for customers, contacts, follow-ups, tasks and schedules, and `GET /api/crm/customers/:id`. `src/db/queries.ts` gained the `queryCustomersPage` family beside the existing tool queries, and the page functions own the visibility predicates rather than the router owning a copy, so `crm.list_contacts` and `GET /api/crm/contacts` cannot drift apart. Child tables inherit the parent customer's gate. The two tables whose `customer_id` is nullable, `tasks` and `schedules` because `0002` declares `ON DELETE SET NULL`, fall back to an ownership check so a row whose customer was deleted is not silently dropped from its owner's list. Paging is `limit` with a default of 25 and a ceiling of 100, plus `offset`, a `count(*)::int` total, and `hasMore` computed from the page actually returned so a total that moved between the count and the read cannot promise an empty page. Filters stay simple: name, city and tags for customers, `customerId` for the three child lists, and a `YYYY-MM-DD` date for schedules, rejected as a 400 when the shape is wrong because a full timestamp truncated by `::date` is a different day west of UTC. The router has no write route at all, which is the governance argument rather than an omission: a POST here would be the bypass the product exists to prevent, and it is also why capture hands off to a chat instead of creating a row.

`src/api/customers.ts` and its test were deleted rather than kept beside the new router, because two routers answering "read one customer" is the drift the parity rule exists to prevent. `tests/api/crm.test.ts` replaces `tests/api/customers.test.ts`, and `tests/db/queries.test.ts` gained the page functions.

Three tool output schemas and the digest item schema now declare `customer_id` as nullable, because the columns have been nullable since `0002` and a schema stricter than its table rejects its own row.

**Records browser.** `RecordsBrowser` renders five tabs over the new endpoints, with filters debounced into the query string, `useInfiniteQuery` pagination keyed on the server's `hasMore`, per tab empty copy, and a failure band that names the plane and offers a retry. `?object=` is read on the server and validated there, so the Home cards can deep link into a tab and an unknown value lands on Customers instead of an empty panel. The tab strip is Radix `Tabs`, which moved three test selectors from `button` to `tab` rather than letting the component keep a hand-rolled strip to suit them. `/records/customers/[id]` renders `CustomerDetail`, a header plus related contacts, follow-ups and tasks read with `customerId`, replacing the legacy `CustomerPanel` on that route.

**Capture hand-off.** `/records/new` keeps the honest preview and gains a hand-off that never writes. `handoffPrompt()` composes the pasted text with the parser's fields, omits the field block entirely when the parser answered `usedFallbackValue`, and links to `/chats/new?prompt=`. That page became an async server component that slices the parameter to 4000 characters and seeds the launch composer through a new `initialText` prop. The prop seeds the field and nothing else, so a hand-off still needs a human to press send.

**Home dashboard.** `console/app/page.tsx` is now a dashboard of pointers. `AwaitingDecisionCard` reads pending approvals and shows the three oldest with a total and a link to `/governance`. `TodayCard` reads the digest for the operator's local calendar date, which fixes a bug carried from `TodayView` where `toISOString().slice(0, 10)` is the previous day for anyone east of Greenwich in the evening, and each of its three counts links into the Records tab holding those rows. `RecentConversationsCard` reads the thread list. `QuickLauncher` offers the four destinations the spec names. The cards share `HomeCard`, `CardPending`, `CardFailure`, `CardEmpty` and `CardLink`, so loading, failure and empty read the same in all three, and a failure names the unreachable plane and offers a retry rather than the `--` the old rail card printed. `/today` is a redirect, and `TodayView`, `SessionList` and the `SessionList` test were deleted because the dashboard and `ConversationList` now own both behaviours.

**Governance, Knowledge and Receipt on primitives.** Behavior unchanged, styling moved onto `PageHeader`, `Button`, `Badge`, `Tabs`, `Input`, `Textarea` and the token utilities. `ApprovalQueue`'s hand-rolled tab buttons became Radix `Tabs` labelled Pending and Decided, the one place the migration changed a selector rather than a class. `ReceiptView` publishes `data-verdict={verification}`, so its tests assert the contract the component exposes rather than a class name from the stylesheet Phase 5 deletes. `KnowledgeManager` uses the same table shape as Records.

**What Phase 4 is not.** No write endpoint, by design. No sort control on the Records lists and no search beyond the name filters, which is what "simple filters" was taken to mean. No route level `loading.tsx`, `error.tsx` or `not-found.tsx` beyond what Phase 3 added, because the app shell section assigns that to Phase 5. The legacy global stylesheet is untouched. The digest stale follow-up label reads a field the table does not have, recorded as C3 in the backlog rather than corrected, because no surface renders that label yet.

**Phase 4 verification, what was actually run.** Console `tsc --noEmit` clean. Console suite `vitest run` green at 14 files and 103 tests, up from 11 files and 87 tests, with the additions being the Home cards, Records, capture, the four redirects and one launch view case, and the deletion being `SessionList.test.tsx`. Console `next lint` reports no warnings and no errors, with the same standing note as Phase 3 that the Next plugin is not registered in the console ESLint config.

**A defect the tests could not see.** The console dev server was booted for this phase and every page was requested over HTTP. `/records` answered 200 and rendered an error page whose message was `RECORD_OBJECTS.includes is not a function`. `app/records/page.tsx` imported `RECORD_OBJECTS` from `RecordsBrowser.tsx`, which is a client module, so the server component received a client reference rather than the value. The types were correct, which is why `tsc` and the component tests stayed green while the page failed at request time. The tab list now lives in `console/lib/records.ts`, which carries no `'use client'`, and both the page and the browser read it from there. `/records?object=tasks` and `?object=schedules` render five tabs with the named one selected.

**What the live run proves.** The dev server served `/`, `/records` with each of the five tab values, `/records/new`, `/records/customers/<uuid>`, `/governance`, `/knowledge`, `/usage`, `/chats` and `/chats/new?prompt=` at HTTP 200. The markup carries the three Home cards as `aria-label` regions, the `Quick actions` navigation, the launch composer already holding the hand-off text, and the `Decided` tab on Governance. `/today` answers with a redirect. No server error appears in the dev log after the fix above.

**What the live run does not prove.** The REST plane was not listening on 4113, so every list read on those pages took the honest error path and no CRM row was ever rendered. `DATABASE_URL` still fails name resolution, the same block recorded under Phase 3. Nothing was clicked, no tab was switched by a browser, and no card has been seen with real data.

**Phase 4 root gates, and what was in the tree.** Root `tsc --noEmit` and root `eslint .` were clean when this phase began and report nothing in any Phase 4 file. Both failed at the end of the phase, 9 type errors and 11 lint problems, entirely inside `src/mastra/workflows/document-intake.ts`, an untracked file that appeared at 15:38 while this phase was finishing, beside `src/db/documents.ts`, `migrations/0009_crum_documents.sql` and a fixtures tree. That work is not part of Phase 4, is not committed with it, and will have to pass the gates under its own phase. Root `vitest run` reported 899 tests with 868 passed, 27 skipped, 1 todo and 3 failed. All three failures are in `tests/evals/golden-gate.test.ts`, the live model and judge gate that `docs/verification/PHASE-8-HANDOFF.md` section 5 already records as unpassable in this environment, where the scorer calls return zeros and the classifier has no key. The failure count moves between runs because that gate makes live calls.

**Runnability tier for Phase 4: console renders, data plane unverified.** Every page was served by a real Next dev server and rendered the surfaces the spec names. No read reached a database, so the Records lists, the customer detail related lists and the Home card counts are proven as components and as rendered shells, not as working reads.

