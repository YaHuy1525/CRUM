import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'

/**
 * pg hands back every row as `any`, so a bare `return result.rows` here would
 * satisfy a declared `Promise<Customer[]>` without anything checking the shape.
 * The wire really is untyped, which is why the cast exists, but it belongs in one
 * place rather than at fifteen return statements: each caller names the row
 * interface its SELECT produces, and this is the single point where a row crosses
 * into it.
 */
async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await getDbClient().query(sql, params)
  return result.rows as T[]
}

export interface Customer {
  id: string
  tenant_id: string
  name: string
  city?: string
  tags?: string[]
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
  /** Nullable soft-delete marker added by migration 0005_crum_parity.sql. */
  deleted_at?: string | null
}

export interface Contact {
  id: string
  tenant_id: string
  customer_id: string
  name: string
  email?: string
  phone?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
  /**
   * Columns that exist in 0002 but not in the tool output schemas. They arrive on
   * any `SELECT *` read, so the list endpoints can render them; optional because
   * a writer that constructs a Contact by hand (the tools' return types) does not
   * have to invent them.
   */
  role?: string | null
  is_primary?: boolean
  notes?: string | null
}

export interface Followup {
  id: string
  tenant_id: string
  customer_id: string
  note?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
  /** Real column is `notes` (0002); the tool schema's `note` above is the drift. */
  notes?: string | null
  type?: string
  status?: string
  /** `scheduled_at` is NOT NULL on the real table. */
  scheduled_at?: string
}

export interface Task {
  id: string
  tenant_id: string
  /** Nullable in 0002 (`ON DELETE SET NULL`), so a task can outlive its customer. */
  customer_id: string | null
  title?: string
  description?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
  deadline?: string | null
  priority?: string
  status?: string
  assigned_to?: string | null
}

/**
 * NOTE: this shape is pinned by the `crm.list_schedules` tool's output schema
 * (src/mastra/tools/schedules.ts), which declares `team_member_ids` and an
 * optional `scheduled_at` — neither of which exists on the real `schedules`
 * table (0002). It is retained to avoid breaking that tool's return-type
 * contract; the drift is tracked in the Wave 1B report, and the queries below
 * never read those columns. `start_time`/`end_time` are the real columns.
 */
export interface Schedule {
  id: string
  tenant_id: string
  /** Nullable in 0002 (`ON DELETE SET NULL`), so a slot can outlive its customer. */
  customer_id: string | null
  scheduled_at?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
  /** The real columns (0002). `SELECT *` returns them; the tool schema above does not. */
  title?: string
  start_time?: string
  end_time?: string
  location?: string | null
  status?: string
}

/**
 * Builds the WHERE clause fragments for tenant-scoped visibility.
 * For admin role: only tenant_id predicate.
 * For user role: tenant_id + (owner_id = userId OR userId = ANY(team_member_ids)).
 *
 * NOTE: this fragment is reused by queries over `tasks`/`followups`/`schedules`,
 * which have no `deleted_at` column, so soft-delete filtering is NOT added here.
 * `customers.deleted_at` is filtered explicitly in the customer queries below.
 */
function visibilityPredicate(context: TenantRequestContext): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'tenant_id = $1', params: [context.tenantId] }
  }
  // user role: owner or team member
  return {
    sql: 'tenant_id = $1 AND (owner_id = $2 OR $2 = ANY(team_member_ids))',
    params: [context.tenantId, context.userId],
  }
}

export interface CustomerFilters {
  city?: string
  name?: string
  tags?: string[]
}

/** A page request for the read-only list endpoints. The route clamps `limit`; this
 *  layer takes what it is given, so a direct caller does not need the HTTP policy. */
export interface ListPage {
  limit: number
  offset: number
}

export interface ListResult<T> {
  items: T[]
  total: number
}

/**
 * One row page and the count behind it. Every list endpoint needs both ("showing
 * 25 of 340"), and building the WHERE clause once per call is what keeps the
 * count and the rows answering the same question — two hand-written counts is how
 * a page header ends up disagreeing with its own list.
 *
 * `orderBy` always carries an id tiebreaker: `OFFSET` pagination over rows that
 * share a `created_at` would otherwise be able to skip or repeat one.
 */
async function pagedRows<T>(
  select: string,
  from: string,
  conditions: string[],
  params: unknown[],
  orderBy: string,
  page: ListPage,
): Promise<ListResult<T>> {
  const where = conditions.join(' AND ')
  const counts = await queryRows<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${from} WHERE ${where}`,
    params,
  )
  const items = await queryRows<T>(
    `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  )
  return { items, total: counts[0]?.count ?? 0 }
}

/**
 * The customer rule written against an aliased join, for the child tables.
 *
 * `contacts` and `followups` have no owner columns at all; 0002 says so in as
 * many words ("child records inherit visibility through their customer"), and the
 * agent's tools enforce it by resolving the parent first: `queryContacts` returns
 * `[]` the moment `queryCustomer` returns null. A tenant-wide child list has to
 * reproduce that gate in SQL, or it would be a wider read than the tool it
 * mirrors, which is exactly the governance parity the spec forbids breaking.
 */
function customerScope(
  context: TenantRequestContext,
  alias: string,
): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return {
      sql: `${alias}.tenant_id = $1 AND ${alias}.deleted_at IS NULL`,
      params: [context.tenantId],
    }
  }
  return {
    sql: `${alias}.tenant_id = $1 AND ${alias}.deleted_at IS NULL AND (${alias}.owner_id = $2 OR $2 = ANY(${alias}.team_member_ids))`,
    params: [context.tenantId, context.userId],
  }
}

/**
 * Visibility for a table whose `customer_id` is nullable (tasks, schedules, both
 * `ON DELETE SET NULL` in 0002).
 *
 * An inner join would silently hide every orphaned row, and a left join whose
 * only predicate was the customer rule would hand those same orphans to whoever
 * asked — two wrong answers in opposite directions. So the rule is a union: a row
 * with a customer is visible when that customer is, and a row without one falls
 * back to the ownership rule the tools' `my_open_items` read already applies
 * (`owner_id` or `assigned_to`). Admins see the tenant, as everywhere else.
 */
function orphanAwareScope(
  context: TenantRequestContext,
  alias: string,
  ownPredicate: (userIdIndex: number) => string,
): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: `${alias}.tenant_id = $1`, params: [context.tenantId] }
  }
  return {
    sql: `${alias}.tenant_id = $1 AND ((${alias}.customer_id IS NOT NULL AND cu.id IS NOT NULL AND cu.deleted_at IS NULL AND (cu.owner_id = $2 OR $2 = ANY(cu.team_member_ids))) OR (${alias}.customer_id IS NULL AND (${ownPredicate(2)})))`,
    params: [context.tenantId, context.userId],
  }
}

/**
 * The customer list's WHERE clause, shared by the array read (the tools' path) and
 * the paged read (the console's), so a filter added here reaches both.
 */
function customerWhere(
  context: TenantRequestContext,
  filters: CustomerFilters,
): { conditions: string[]; params: unknown[] } {
  const vis = visibilityPredicate(context)
  // Soft-deleted customers are hidden from every read path (see migration 0005).
  const conditions: string[] = [vis.sql, 'deleted_at IS NULL']
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.city) {
    idx++
    conditions.push(`city = $${idx}`)
    params.push(filters.city)
  }
  if (filters.name) {
    idx++
    conditions.push(`name ILIKE $${idx}`)
    params.push(`%${filters.name}%`)
  }
  if (filters.tags && filters.tags.length > 0) {
    idx++
    conditions.push(`tags @> $${idx}`)
    params.push(filters.tags)
  }

  return { conditions, params }
}

/**
 * Lists customers matching the tenant scope and optional filters.
 */
export async function queryCustomers(
  context: TenantRequestContext,
  filters: CustomerFilters = {},
): Promise<Customer[]> {
  const { conditions, params } = customerWhere(context, filters)
  const sql = `SELECT * FROM customers WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
  return queryRows<Customer>(sql, params)
}

/** `GET /api/crm/customers` — the same scope as `crm.list_customers`, paged. */
export async function queryCustomersPage(
  context: TenantRequestContext,
  filters: CustomerFilters = {},
  page: ListPage,
): Promise<ListResult<Customer>> {
  const { conditions, params } = customerWhere(context, filters)
  return pagedRows<Customer>(
    '*',
    'customers',
    conditions,
    params,
    'created_at DESC, id DESC',
    page,
  )
}

export interface ContactFilters {
  customerId?: string
  name?: string
}

/** `GET /api/crm/contacts` — tenant-wide, gated by the parent customer. */
export async function queryContactsPage(
  context: TenantRequestContext,
  filters: ContactFilters = {},
  page: ListPage,
): Promise<ListResult<Contact>> {
  const scope = customerScope(context, 'cu')
  const conditions = [scope.sql]
  const params = [...scope.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`c.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.name) {
    idx++
    conditions.push(`c.name ILIKE $${idx}`)
    params.push(`%${filters.name}%`)
  }

  return pagedRows<Contact>(
    'c.*',
    'contacts c JOIN customers cu ON cu.id = c.customer_id',
    conditions,
    params,
    'c.created_at DESC, c.id DESC',
    page,
  )
}

export interface FollowupFilters {
  customerId?: string
}

/** `GET /api/crm/followups` — tenant-wide, gated by the parent customer. */
export async function queryFollowupsPage(
  context: TenantRequestContext,
  filters: FollowupFilters = {},
  page: ListPage,
): Promise<ListResult<Followup>> {
  const scope = customerScope(context, 'cu')
  const conditions = [scope.sql]
  const params = [...scope.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`f.customer_id = $${idx}`)
    params.push(filters.customerId)
  }

  return pagedRows<Followup>(
    'f.*',
    'followups f JOIN customers cu ON cu.id = f.customer_id',
    conditions,
    params,
    'f.created_at DESC, f.id DESC',
    page,
  )
}

export interface TaskFilters {
  customerId?: string
}

/** `GET /api/crm/tasks` — customer-gated, with orphans falling back to ownership. */
export async function queryTasksPage(
  context: TenantRequestContext,
  filters: TaskFilters = {},
  page: ListPage,
): Promise<ListResult<Task>> {
  const scope = orphanAwareScope(context, 't', (i) => `t.owner_id = $${i} OR t.assigned_to = $${i}`)
  const conditions = [scope.sql]
  const params = [...scope.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`t.customer_id = $${idx}`)
    params.push(filters.customerId)
  }

  return pagedRows<Task>(
    't.*',
    'tasks t LEFT JOIN customers cu ON cu.id = t.customer_id',
    conditions,
    params,
    't.created_at DESC, t.id DESC',
    page,
  )
}

export interface ScheduleFilters {
  customerId?: string
  /** `YYYY-MM-DD`, filtered on `date(start_time)` — the real column. */
  date?: string
}

/** `GET /api/crm/schedules` — customer-gated, with orphans falling back to ownership. */
export async function querySchedulesPage(
  context: TenantRequestContext,
  filters: ScheduleFilters = {},
  page: ListPage,
): Promise<ListResult<Schedule>> {
  const scope = orphanAwareScope(context, 's', (i) => `s.owner_id = $${i}`)
  const conditions = [scope.sql]
  const params = [...scope.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`s.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.date) {
    idx++
    conditions.push(`date(s.start_time) = $${idx}::date`)
    params.push(filters.date)
  }

  return pagedRows<Schedule>(
    's.*',
    'schedules s LEFT JOIN customers cu ON cu.id = s.customer_id',
    conditions,
    params,
    's.start_time ASC, s.id ASC',
    page,
  )
}

/**
 * Returns a single customer by id, or null if not visible to the context.
 */
export async function queryCustomer(
  context: TenantRequestContext,
  id: string,
): Promise<Customer | null> {
  const vis = visibilityPredicate(context)
  const params: unknown[] = [...vis.params, id]
  const idx = params.length
  // `deleted_at IS NULL` also gates every child read (contacts/followups/tasks/
  // schedules), which all first call queryCustomer and return [] when it is null.
  const sql = `SELECT * FROM customers WHERE id = $${idx} AND ${vis.sql} AND deleted_at IS NULL LIMIT 1`
  const rows = await queryRows<Customer>(sql, params)
  return rows[0] ?? null
}

/**
 * Returns contacts for a customer, scoped by tenant visibility.
 */
export async function queryContacts(
  context: TenantRequestContext,
  customerId: string,
): Promise<Contact[]> {
  const customer = await queryCustomer(context, customerId)
  if (!customer) return []
  return queryRows<Contact>(
    `SELECT * FROM contacts WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
}

/**
 * Returns followups for a customer, scoped by tenant visibility.
 */
export async function queryFollowups(
  context: TenantRequestContext,
  customerId: string,
): Promise<Followup[]> {
  const customer = await queryCustomer(context, customerId)
  if (!customer) return []
  return queryRows<Followup>(
    `SELECT * FROM followups WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
}

/**
 * Returns tasks for a customer, scoped by tenant visibility.
 */
export async function queryTasks(
  context: TenantRequestContext,
  customerId: string,
): Promise<Task[]> {
  const customer = await queryCustomer(context, customerId)
  if (!customer) return []
  return queryRows<Task>(
    `SELECT * FROM tasks WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
}

/**
 * Returns schedules for a customer, scoped by tenant visibility.
 */
export async function querySchedules(
  context: TenantRequestContext,
  customerId: string,
): Promise<Schedule[]> {
  const customer = await queryCustomer(context, customerId)
  if (!customer) return []
  return queryRows<Schedule>(
    `SELECT * FROM schedules WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
}

/**
 * Returns schedules that fall on a calendar date, scoped by tenant.
 *
 * `schedules` has no `scheduled_at` column (0002 defines `start_time`/`end_time`
 * only), so the date filter runs on `date(start_time)` and ordering stays
 * chronological by `start_time ASC`. `schedules` also has no team_member_ids, so
 * the shared visibilityPredicate is not used; a non-admin sees their own rows.
 *
 * @param date a `YYYY-MM-DD` string (or anything Postgres can cast to `date`).
 */
export async function querySchedulesForDate(
  context: TenantRequestContext,
  date: string,
  limit = 50,
): Promise<Schedule[]> {
  const params: unknown[] = [context.tenantId, date]
  let ownerClause = ''
  if (context.userRole !== 'admin') {
    ownerClause = ' AND owner_id = $3'
    params.push(context.userId)
  }
  const sql = `SELECT * FROM schedules WHERE tenant_id = $1 AND date(start_time) = $2::date${ownerClause} ORDER BY start_time ASC LIMIT $${params.length + 1}`
  params.push(limit)
  return queryRows<Schedule>(sql, params)
}

export interface SearchResult {
  type: 'customer' | 'contact' | 'task'
  id: string
  label: string
  tenant_id: string
}

/**
 * Searches customers, contacts and tasks by name/title ILIKE match, scoped by tenant visibility.
 *
 * For admin role the contacts/tasks sub-queries omit the owner predicate
 * (admin sees all rows in the tenant). For user role the owner predicate
 * is included with the correct parameter index for userId.
 */
export async function querySearch(
  context: TenantRequestContext,
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  const pattern = `%${query}%`

  if (context.userRole === 'admin') {
    // Admin: no owner predicate on contacts/tasks. Params: [tenantId, pattern, limit]
    const sql = `
      SELECT 'customer' AS type, id, name AS label, tenant_id FROM customers WHERE tenant_id = $1 AND deleted_at IS NULL AND name ILIKE $2
      UNION ALL
      SELECT 'contact' AS type, id, name AS label, tenant_id FROM contacts WHERE tenant_id = $1 AND name ILIKE $2
      UNION ALL
      SELECT 'task' AS type, id, COALESCE(title, description) AS label, tenant_id FROM tasks WHERE tenant_id = $1 AND (title ILIKE $2 OR description ILIKE $2)
      ORDER BY label ASC
      LIMIT $3
    `
    return queryRows<SearchResult>(sql, [context.tenantId, pattern, limit])
  }

  // User role: scope by the caller's visible customers. Params: [tenantId, userId, pattern, limit]
  //
  // contacts has no owner_id/team_member_ids, so its visibility is inherited
  // from the parent customer via a subquery; tasks has no team_member_ids, so
  // "mine" means owner_id OR assigned_to.
  const sql = `
    SELECT 'customer' AS type, id, name AS label, tenant_id FROM customers WHERE tenant_id = $1 AND (owner_id = $2 OR $2 = ANY(team_member_ids)) AND deleted_at IS NULL AND name ILIKE $3
    UNION ALL
    SELECT 'contact' AS type, id, name AS label, tenant_id FROM contacts WHERE tenant_id = $1 AND customer_id IN (SELECT id FROM customers WHERE tenant_id = $1 AND (owner_id = $2 OR $2 = ANY(team_member_ids)) AND deleted_at IS NULL) AND name ILIKE $3
    UNION ALL
    SELECT 'task' AS type, id, COALESCE(title, description) AS label, tenant_id FROM tasks WHERE tenant_id = $1 AND (owner_id = $2 OR assigned_to = $2) AND (title ILIKE $3 OR description ILIKE $3)
    ORDER BY label ASC
    LIMIT $4
  `
  return queryRows<SearchResult>(sql, [context.tenantId, context.userId, pattern, limit])
}

export interface KnowledgeDocument {
  id: string
  tenant_id: string
  title: string
  file_type: string
  content_hash: string
  metadata: Record<string, unknown>
  status: string
  owner_id: string
  created_at: string
  updated_at: string
}

/**
 * Searches knowledge_documents by title, scoped by tenant.
 *
 * There is no `content` column: 0002 defines knowledge_documents as a document
 * registry (title, content_hash, metadata, status). Full-text / semantic search
 * over document bodies belongs to the Phase-4 retrieval path (knowledge.retrieve
 * over the vector index), not an ILIKE scan of a Postgres row, so the search is
 * title-only here.
 */
export async function queryKnowledgeDocuments(
  context: TenantRequestContext,
  query: string,
  limit = 20,
): Promise<KnowledgeDocument[]> {
  const pattern = `%${query}%`
  const sql = `SELECT * FROM knowledge_documents WHERE tenant_id = $1 AND title ILIKE $2 ORDER BY updated_at DESC LIMIT $3`
  return queryRows<KnowledgeDocument>(sql, [context.tenantId, pattern, limit])
}

/**
 * Returns tasks assigned to the user across all customers, scoped by tenant.
 *
 * `tasks` has `owner_id` and `assigned_to` but NO `team_member_ids`, so the
 * shared visibilityPredicate cannot be used here (it would reference a column
 * that does not exist). "My tasks" means rows where the caller owns or is
 * assigned them, for both roles.
 */
export async function queryMyTasks(
  context: TenantRequestContext,
): Promise<Task[]> {
  const sql = `SELECT * FROM tasks WHERE tenant_id = $1 AND (owner_id = $2 OR assigned_to = $2) ORDER BY created_at DESC`
  const params = [context.tenantId, context.userId]
  return queryRows<Task>(sql, params)
}

/**
 * Returns followups owned by the user across all customers, scoped by tenant.
 *
 * `followups` has `owner_id` but NO `team_member_ids`, so the shared
 * visibilityPredicate cannot be used here.
 */
export async function queryMyFollowups(
  context: TenantRequestContext,
): Promise<Followup[]> {
  const sql = `SELECT * FROM followups WHERE tenant_id = $1 AND owner_id = $2 ORDER BY created_at DESC`
  const params = [context.tenantId, context.userId]
  return queryRows<Followup>(sql, params)
}

/**
 * Returns all tasks for a tenant (used by digest workflow).
 * The digest runs as a background job with no user session, so it queries
 * by tenant_id only — no row-level visibility predicate.
 */
export async function queryAllTasks(tenantId: string): Promise<Task[]> {
  return queryRows<Task>(
    `SELECT * FROM tasks WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  )
}

/**
 * Returns schedules for a tenant on a given date (used by digest workflow).
 * The digest runs as a background job with no user session, so it queries
 * by tenant_id only — no row-level visibility predicate.
 */
export async function queryTenantSchedulesForDate(
  tenantId: string,
  date: string,
): Promise<Schedule[]> {
  return queryRows<Schedule>(
    `SELECT * FROM schedules WHERE tenant_id = $1 AND date(start_time) = $2::date ORDER BY start_time ASC`,
    [tenantId, date],
  )
}

/**
 * Returns followups not updated within `staleDays` days (used by digest workflow).
 */
export async function queryStaleFollowups(
  tenantId: string,
  staleDays = 7,
): Promise<Followup[]> {
  return queryRows<Followup>(
    `SELECT * FROM followups WHERE tenant_id = $1 AND updated_at < NOW() - INTERVAL '1 day' * $2 ORDER BY updated_at ASC`,
    [tenantId, staleDays],
  )
}
