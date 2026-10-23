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
  const conditions: string[] = [vis.sql]
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
  const sql = `SELECT * FROM customers WHERE id = $${idx} AND ${vis.sql} LIMIT 1`
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
