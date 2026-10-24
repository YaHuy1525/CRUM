import type { PoolClient } from 'pg'
import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'

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
}

export interface Task {
  id: string
  tenant_id: string
  customer_id: string
  title?: string
  description?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
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
  customer_id: string
  scheduled_at?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
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

/**
 * Lists customers matching the tenant scope and optional filters.
 */
export async function queryCustomers(
  context: TenantRequestContext,
  filters: CustomerFilters = {},
): Promise<Customer[]> {
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

  const sql = `SELECT * FROM customers WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
  const result = await getDbClient().query(sql, params)
  return result.rows
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
  const result = await getDbClient().query(sql, params)
  return result.rows[0] ?? null
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
  const result = await getDbClient().query(
    `SELECT * FROM contacts WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
  return result.rows
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
  const result = await getDbClient().query(
    `SELECT * FROM followups WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
  return result.rows
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
  const result = await getDbClient().query(
    `SELECT * FROM tasks WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
  return result.rows
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
  const result = await getDbClient().query(
    `SELECT * FROM schedules WHERE customer_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [customerId, context.tenantId],
  )
  return result.rows
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
  const result = await getDbClient().query(sql, params)
  return result.rows
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
    const result = await getDbClient().query(sql, [context.tenantId, pattern, limit])
    return result.rows
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
  const result = await getDbClient().query(sql, [context.tenantId, context.userId, pattern, limit])
  return result.rows
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
  const result = await getDbClient().query(sql, [context.tenantId, pattern, limit])
  return result.rows
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
  const result = await getDbClient().query(sql, params)
  return result.rows
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
  const result = await getDbClient().query(sql, params)
  return result.rows
}

/**
 * Returns all tasks for a tenant (used by digest workflow).
 * The digest runs as a background job with no user session, so it queries
 * by tenant_id only — no row-level visibility predicate.
 */
export async function queryAllTasks(tenantId: string): Promise<Task[]> {
  const result = await getDbClient().query(
    `SELECT * FROM tasks WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  )
  return result.rows
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
  const result = await getDbClient().query(
    `SELECT * FROM schedules WHERE tenant_id = $1 AND date(start_time) = $2::date ORDER BY start_time ASC`,
    [tenantId, date],
  )
  return result.rows
}

/**
 * Returns followups not updated within `staleDays` days (used by digest workflow).
 */
export async function queryStaleFollowups(
  tenantId: string,
  staleDays = 7,
): Promise<Followup[]> {
  const result = await getDbClient().query(
    `SELECT * FROM followups WHERE tenant_id = $1 AND updated_at < NOW() - INTERVAL '1 day' * $2 ORDER BY updated_at ASC`,
    [tenantId, staleDays],
  )
  return result.rows
}
