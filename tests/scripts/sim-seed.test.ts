import { describe, expect, it } from 'vitest'
import {
  CUSTOMERS_PER_TENANT,
  OWNERS_PER_TENANT,
  TENANT_COUNT,
  batchInsertSql,
  generateTenantRows,
  nameUuid,
  simTenantIds,
  simUserIds,
} from '../../scripts/sim-seed'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('nameUuid', () => {
  it('produces a stable version-4-shaped UUID (v3 bits) for the same input', () => {
    const a = nameUuid('ns', 'tenant-0')
    const b = nameUuid('ns', 'tenant-0')
    expect(a).toBe(b)
    expect(a).toMatch(UUID_RE)
  })

  it('produces distinct uuids for distinct names', () => {
    expect(nameUuid('ns', 'tenant-0')).not.toBe(nameUuid('ns', 'tenant-1'))
  })
})

describe('simulation identities', () => {
  it('has TENANT_COUNT distinct tenant ids, all uuid-shaped', () => {
    const ids = simTenantIds()
    expect(ids).toHaveLength(TENANT_COUNT)
    expect(new Set(ids).size).toBe(TENANT_COUNT)
    for (const id of ids) expect(id).toMatch(UUID_RE)
  })

  it('each tenant has OWNERS_PER_TENANT distinct users', () => {
    const users = simUserIds(3)
    expect(users).toHaveLength(OWNERS_PER_TENANT)
    expect(new Set(users).size).toBe(OWNERS_PER_TENANT)
  })
})

describe('generateTenantRows', () => {
  // Small tenant for the pure-data assertions; the CLI uses the full size.
  const rows = generateTenantRows(0, { customers: 200, seed: 42 })
  const tenantId = simTenantIds()[0]
  const owners = simUserIds(0)

  it('generates exactly the requested number of customers, all tenant-scoped', () => {
    expect(rows.customers).toHaveLength(200)
    for (const c of rows.customers) {
      expect(c.tenant_id).toBe(tenantId)
      expect(c.name).not.toBe('')
      expect(owners).toContain(c.owner_id)
      for (const t of c.team_member_ids) expect(owners).toContain(t)
    }
  })

  it('is deterministic: same tenant and seed produce identical ids', () => {
    const again = generateTenantRows(0, { customers: 200, seed: 42 })
    expect(again.customers.map((c) => c.id)).toEqual(rows.customers.map((c) => c.id))
    expect(again.contacts.map((c) => c.id)).toEqual(rows.contacts.map((c) => c.id))
  })

  it('changes generated content when the seed differs (ids stay name-derived)', () => {
    const other = generateTenantRows(0, { customers: 200, seed: 43 })
    const namesOf = (r: typeof rows) => r.customers.map((c) => `${c.name}|${c.company}|${c.owner_id}`)
    expect(namesOf(other)).not.toEqual(namesOf(rows))
  })

  it('gives every customer exactly one primary contact', () => {
    const byCustomer = new Map<string, number>()
    for (const contact of rows.contacts) {
      expect(contact.tenant_id).toBe(tenantId)
      byCustomer.set(contact.customer_id, (byCustomer.get(contact.customer_id) ?? 0) + (contact.is_primary ? 1 : 0))
    }
    for (const customer of rows.customers) {
      expect(byCustomer.get(customer.id), `customer ${customer.id}`).toBe(1)
    }
  })

  it('only creates contacts and followups that reference generated customers', () => {
    const ids = new Set(rows.customers.map((c) => c.id))
    for (const contact of rows.contacts) expect(ids.has(contact.customer_id)).toBe(true)
    for (const f of rows.followups) {
      expect(ids.has(f.customer_id)).toBe(true)
      if (f.contact_id) expect(rows.contacts.some((c) => c.id === f.contact_id)).toBe(true)
    }
  })

  it('honors the followups CHECK: completed requires completed_at', () => {
    for (const f of rows.followups) {
      expect(['call', 'email', 'meeting', 'visit']).toContain(f.type)
      expect(['scheduled', 'completed', 'cancelled', 'missed']).toContain(f.status)
      if (f.status === 'completed') expect(f.completed_at).not.toBeNull()
      else expect(f.completed_at).toBeNull()
    }
  })

  it('honors the tasks enums', () => {
    for (const t of rows.tasks) {
      expect(['low', 'normal', 'high', 'urgent']).toContain(t.priority)
      expect(['open', 'in_progress', 'done', 'cancelled']).toContain(t.status)
    }
  })

  it('honors the schedules CHECK: end_time after start_time', () => {
    for (const s of rows.schedules) {
      expect(Date.parse(s.end_time)).toBeGreaterThan(Date.parse(s.start_time))
      expect(['tentative', 'confirmed', 'cancelled']).toContain(s.status)
    }
  })

  it('seeds a full related graph at the documented ratios', () => {
    // ~2 contacts, ~3 followups, ~2 tasks, ~1 schedule per customer.
    expect(rows.contacts.length).toBeGreaterThanOrEqual(rows.customers.length)
    expect(rows.contacts.length).toBeLessThanOrEqual(rows.customers.length * 3)
    expect(rows.followups.length).toBeGreaterThanOrEqual(rows.customers.length * 2)
    expect(rows.tasks.length).toBeGreaterThanOrEqual(rows.customers.length)
    expect(rows.schedules.length).toBeLessThanOrEqual(rows.customers.length * 2)
  })
})

describe('full-scale shape', () => {
  it('exports the 50k-by-default plan: 10 tenants x 5,000 customers', () => {
    expect(TENANT_COUNT * CUSTOMERS_PER_TENANT).toBe(50_000)
  })
})

describe('batchInsertSql', () => {
  it('renders arrays as Postgres literals, doubles quotes, and nulls bare', () => {
    const sql = batchInsertSql(
      'customers',
      ['name', 'tags', 'email'],
      [{ name: "Bob O'Connor", tags: ['vip', 'smb'], email: null }],
    )
    expect(sql).toContain("('Bob O''Connor', '{vip,smb}', null)")
  })

  it('renders one VALUES tuple per row', () => {
    const sql = batchInsertSql('t', ['a'], [{ a: 1 }, { a: 2 }])
    expect(sql.match(/\(\d+\)/g)).toEqual(['(1)', '(2)'])
  })
})
