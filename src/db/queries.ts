import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'

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
  notes?: string | null
  type?: string
  status?: string
  scheduled_at?: string
}

export interface Task {
  id: string
  tenant_id: string
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

export interface Schedule {
  id: string
  tenant_id: string
  customer_id: string | null
  scheduled_at?: string
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
  title?: string
  start_time?: string
  end_time?: string
  location?: string | null
  status?: string
  attendees?: string[]
  customer_name?: string | null
  customer_company?: string | null
}

function visibilityPredicate(context: TenantRequestContext): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'tenant_id = $1', params: [context.tenantId] }
  }
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

export interface ListPage {
  limit: number
  offset: number
}

export interface ListResult<T> {
  items: T[]
  total: number
}

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

function customerWhere(
  context: TenantRequestContext,
  filters: CustomerFilters,
): { conditions: string[]; params: unknown[] } {
  const vis = visibilityPredicate(context)
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

export async function queryCustomers(
  context: TenantRequestContext,
  filters: CustomerFilters = {},
): Promise<Customer[]> {
  const { conditions, params } = customerWhere(context, filters)
  const sql = `SELECT * FROM customers WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
  return queryRows<Customer>(sql, params)
}

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
  date?: string
  from?: string
  to?: string
}

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
  if (filters.from) {
    idx++
    conditions.push(`date(s.start_time) >= $${idx}::date`)
    params.push(filters.from)
  }
  if (filters.to) {
    idx++
    conditions.push(`date(s.start_time) <= $${idx}::date`)
    params.push(filters.to)
  }

  return pagedRows<Schedule>(
    's.*, cu.name AS customer_name, cu.company AS customer_company',
    'schedules s LEFT JOIN customers cu ON cu.id = s.customer_id',
    conditions,
    params,
    's.start_time ASC, s.id ASC',
    page,
  )
}

export async function queryCustomer(
  context: TenantRequestContext,
  id: string,
): Promise<Customer | null> {
  const vis = visibilityPredicate(context)
  const params: unknown[] = [...vis.params, id]
  const idx = params.length
  const sql = `SELECT * FROM customers WHERE id = $${idx} AND ${vis.sql} AND deleted_at IS NULL LIMIT 1`
  const rows = await queryRows<Customer>(sql, params)
  return rows[0] ?? null
}

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

export async function querySearch(
  context: TenantRequestContext,
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  const pattern = `%${query}%`

  if (context.userRole === 'admin') {
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

export async function queryKnowledgeDocuments(
  context: TenantRequestContext,
  query: string,
  limit = 20,
): Promise<KnowledgeDocument[]> {
  const pattern = `%${query}%`
  const sql = `SELECT * FROM knowledge_documents WHERE tenant_id = $1 AND title ILIKE $2 ORDER BY updated_at DESC LIMIT $3`
  return queryRows<KnowledgeDocument>(sql, [context.tenantId, pattern, limit])
}

export async function queryMyTasks(
  context: TenantRequestContext,
): Promise<Task[]> {
  const sql = `SELECT * FROM tasks WHERE tenant_id = $1 AND (owner_id = $2 OR assigned_to = $2) ORDER BY created_at DESC`
  const params = [context.tenantId, context.userId]
  return queryRows<Task>(sql, params)
}

export async function queryMyFollowups(
  context: TenantRequestContext,
): Promise<Followup[]> {
  const sql = `SELECT * FROM followups WHERE tenant_id = $1 AND owner_id = $2 ORDER BY created_at DESC`
  const params = [context.tenantId, context.userId]
  return queryRows<Followup>(sql, params)
}

export async function queryAllTasks(tenantId: string): Promise<Task[]> {
  return queryRows<Task>(
    `SELECT * FROM tasks WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  )
}

export async function queryTenantSchedulesForDate(
  tenantId: string,
  date: string,
): Promise<Schedule[]> {
  return queryRows<Schedule>(
    `SELECT * FROM schedules WHERE tenant_id = $1 AND date(start_time) = $2::date ORDER BY start_time ASC`,
    [tenantId, date],
  )
}

export async function queryStaleFollowups(
  tenantId: string,
  staleDays = 7,
): Promise<Followup[]> {
  return queryRows<Followup>(
    `SELECT * FROM followups WHERE tenant_id = $1 AND updated_at < NOW() - INTERVAL '1 day' * $2 ORDER BY updated_at ASC`,
    [tenantId, staleDays],
  )
}

export interface MailMessageRow {
  id: string
  tenant_id: string
  user_id: string
  gmail_email: string
  thread_id: string
  subject: string
  senders: string[]
  recipients: string[]
  snippet: string
  date_header: string
  received_at: string
  fetched_at: string
}

export async function queryRecentMailMessages(
  tenantId: string,
  limit = 10,
): Promise<MailMessageRow[]> {
  return queryRows<MailMessageRow>(
    `SELECT * FROM mail_messages WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT $2`,
    [tenantId, limit],
  )
}
