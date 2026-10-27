# Inbox lane scope (the Cedar-style inbox)

Date: 2026-10-26
Status: scope only. No schema, route, or UI for an inbox is committed by this document.
Related: `docs/superpowers/plans/99-later-backlog.md` item B6, `docs/superpowers/specs/2026-10-26-console-ia-chats-design.md`

## 1. The ask

The reference product shows a single inbox: four tabs across the top (All, Inbox, Agent Drafts, Active
Pipeline) and one row per customer message, each row carrying a channel icon (email, LinkedIn, WhatsApp)
and a Draft badge where the agent has written a reply that a human has not approved. The console has no
screen like it.

## 2. What exists today, verified against the repo

1. There is no inbox table. The migration set contains `customers`, `contacts`, `followups`, `human_tasks`,
   `schedules`, `knowledge_documents`, `documents`, `gmail_connections`, and `pending_writes`. Nothing in
   that list stores a message.
2. `migrations/0006_crum_receipt_scope.sql` and its predecessor store Gmail OAuth metadata only: the
   connected address, an encrypted refresh token, and scopes. No mail content is stored.
3. `migrations/0009_crum_documents.sql` gives documents a `source` column that allows `email`. That means an
   email can become one knowledge document. It is not a message feed and it drops the channel, the
   counterpart, the direction, and the thread.
4. `scripts/sim-seed.ts` seeds customers, contacts, followups, tasks, and schedules. It creates no
   conversations and no messages. So there are no seeded emails to route to.
5. Outbound mail already has a seam. `mail.draft` (`src/mastra/tools/auto-writes.ts`) and `mail.send`
   (`src/mastra/tools/approval-writes.ts`) stage rows into `pending_writes`. Nothing talks to a real
   mailbox yet.
6. Inbound mail is already designed but never built. Backlog item B6 records that `WebhookSignalProvider`
   and `intentTriageFlow` are specified in the technical plan, and that the real gap is a `policy/tools.yaml`
   entry rather than new plumbing. B6 also requires every inbound body to pass the `crum-injection`
   classifier before it is triaged.

Conclusion. The inbox is not a missing screen on top of existing data. It is a missing data model plus a
missing read surface plus a missing screen. The three parts have very different costs.

## 3. What a minimal inbox needs

### 3.1 Storage

One new table, working name `inbox_messages`, holding the union of channels rather than email alone.

| column | purpose |
|---|---|
| `id`, `tenant_id`, `owner_id` | identity and the existing RLS scoping pattern |
| `customer_id` | links a row to `customers`, so a row can open a record |
| `channel` | `email`, `linkedin`, `whatsapp`. Drives the icon |
| `direction` | `inbound`, `outbound` |
| `counterpart` | display name plus address or handle |
| `subject`, `preview` | cheap list rendering, no full body in a list query |
| `body` | full text, fetched per row |
| `thread_ref`, `provider`, `provider_message_id` | dedupe. A unique constraint on (`tenant_id`, `provider`, `provider_message_id`) makes a webhook retry harmless |
| `status` | `unread`, `replied`, `drafted`, `archived` |
| `draft_pending_write_id` | points at the `pending_writes` row when a Draft badge should show |
| `observed_at`, `ingested_at` | real time versus our time |

Two design notes worth keeping. First, `draft_pending_write_id` means the Draft badge is a join to the
approval queue that already exists, not a second copy of draft state. Second, the table stores
channel-agnostic fields only. Anything Gmail specific belongs in a `raw` JSONB column, so LinkedIn does
not force a migration.

### 3.2 Content, so the screen is not empty

The cheap answer is to extend `scripts/sim-seed.ts` with a per-customer message generator, reusing its
existing deterministic `nameUuid` scheme so a seed run is reproducible. This gives a demo inbox with no
integration, no credentials, and no new failure mode. It must be labelled as simulation data in the UI
path it appears under, in the same spirit as the existing sim tenants.

### 3.3 Read route

One route on the REST plane, `GET /api/inbox`, with a tab filter, a channel filter, a text filter, and a
page cursor. It mirrors `src/api/threads.ts` in three respects that matter: identity comes from the
request, `resourceId` is derived server-side and never accepted as a parameter, and a row that is not the
caller's answers as absent rather than as forbidden.

One caveat to carry over from the thread work: storage filters by an exact `tenantId:userId` resource, so
there is currently no way to enumerate a whole tenant's conversations. An inbox is a tenant-wide list by
nature, and a per-rep view plus a manager view are different queries. That needs an explicit decision
(section 7, question 1) before the route is written, not during.

### 3.4 UI

A section in the existing sidebar shell, using the current `theme.css` tokens and the card and row recipes
the console already has. The reference teaches the structure: tabs as a filter bar, one row per message, a
channel mark, a draft mark, quiet metadata. It does not teach the palette or the copy, and the console
should not borrow those.

The four tabs decompose into queries against one table plus one existing one. All is unfiltered. Inbox is
`direction = inbound` and `status = unread`. Agent Drafts is rows whose `draft_pending_write_id` is set and
whose approval is still open. Active Pipeline is arguably not an inbox query at all, because it is open
work on a customer, which `followups` and `human_tasks` already model. That tab risks becoming a second
source of truth for pipeline state, so it is the piece most worth cutting from a first slice.

## 4. Governance

1. The inbox is a read surface. It must not gain a send path of its own. Sending stays on `mail.send`
   behind the approval gate with a signed receipt.
2. An inbound body is untrusted input arriving in a human's list view. It must pass the `crum-injection`
   classifier before it is rendered into a prompt or a context panel, per backlog B6. Rendering it as text
   is safe. Handing it to the agent is not automatically safe.
3. A Draft badge shows the existence of an approval, never its outcome. It links to the approval queue.

## 5. Slices, in cost order

| slice | contents | rough cost | blocker |
|---|---|---|---|
| A | `inbox_messages` migration, seeder extension, `GET /api/inbox`, one list screen with two tabs | small. one migration, one route, one console section | the TLS blocker in section 6 only if the route reads Mastra storage. It does not |
| B | Draft badge joined to `pending_writes`, row click opening a customer record | small, on top of A | none |
| C | Real Gmail read behind the mail seam, webhook ingestion with idempotency | large | OAuth credentials, a reachable webhook receiver, and a decision on polling versus push |
| D | LinkedIn and WhatsApp channels | unknown | no connector exists for either |

Recommended first move if this is ever greenlit: slice A with two tabs (All and Inbox), simulation content,
and no send affordance.

## 6. Known blockers, found while verifying the routing complaint

These are recorded here because they gate any lane that reads Mastra storage, and they are current facts
verified on 2026-10-26 rather than speculation.

1. `SELF_SIGNED_CERT_IN_CHAIN`. The Supabase session pooler in `DATABASE_URL` cannot be verified under the
   explicit `rejectUnauthorized: true` that `src/mastra/storage.ts` mandates for non-loopback hosts. Every
   thread and conversation read therefore fails at the storage layer, as a 503 or a 500 rather than as
   empty data. The plain `pg` pool in `src/db/client.ts` succeeds only because it passes no `ssl` option at
   all, which means the CRM read path reaches a remote database without TLS. That is a separate finding and
   it is not acceptable as the fix. The `DIRECT_URL` host does not resolve from this machine at all. The
   intended remedy, which the storage comment already states, is to identify the signing CA on this host and
   export it through `NODE_EXTRA_CA_CERTS`, not to set `MASTRA_PG_SSL=false`.
2. `/api/agent/search` answers 500 with `searchMessages requires a vector store. Configure vector and
   embedder on your Memory instance.` The route cannot work until the Memory instance is given a vector
   store and an embedder, so the console's conversation search is unreachable by configuration rather than
   by routing.
3. `DATABASE_URL` looks malformed. Its userinfo segment reads `postgres.tjvalzjxameymtqbloor://` with no
   password, which suggests a literal `://` was written into the password field at some point. It is worth
   re-exporting the connection string from the Supabase dashboard before assuming the certificate is the
   whole story.

## 7. Open questions for a human decision

1. Is the inbox a per-rep view, a tenant-wide view, or both behind a role check? The current identity
   scoping supports the first and not the second.
2. Does Active Pipeline read `inbox_messages` at all, or is it a saved filter over `followups` and
   `human_tasks`? Duplicating pipeline state would create the console's second source of truth.
3. Is simulation content enough to justify building the screen, or does the screen only make sense once
   slice C can land? A demo inbox that never shows real mail is a prototype, and prototypes need an owner
   and an expiry.
4. Which channels are actually in scope for the product? A three-channel union table is a bigger contract
   than an email list, and only email has any prior work here.
