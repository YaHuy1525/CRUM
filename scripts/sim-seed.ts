// scripts/sim-seed.ts
//
// Simulation seeder: 10 tenants x 5,000 customers with a full related spine
// graph (~2 contacts, ~3 followups, ~2 tasks, ~1 schedule per customer).
// Deterministic: the same seed produces byte-identical ids, so load-test
// numbers are comparable across re-runs.
//
// Safety contract:
// - Refuses to run without DATABASE_URL (no silent in-memory "success").
// - Wipe-and-reseed is scoped to the simulation tenant ids ONLY. Eval tenants
//   and any other rows are untouched.
// - Governance tables (pending_writes, audit_receipts, human_tasks) are never
//   seeded: they are system-of-record data, not simulation material.
//
// The wipe is a set of tenant-scoped DELETEs and the inserts stream per tenant
// WITHOUT one wrapping transaction: the Supabase session pooler runs in
// transaction-pooling mode, where a multi-minute BEGIN/COMMIT across statements
// is not safe. A failed run is always recoverable by re-running (wipe is
// idempotent).
//
// Usage: npm run sim:seed
import { createHash } from 'node:crypto'
import { setDefaultResultOrder } from 'node:dns'
import { Pool } from 'pg'
import { parseEnv } from '../src/config/env'

// Cloudflare-fronted poolers can hang on IPv6 connection attempts from Windows
// dual-stack sockets; prefer IPv4 for this process.
setDefaultResultOrder('ipv4first')

// ── Plan ─────────────────────────────────────────────────────────────────
export const TENANT_COUNT = 10
export const CUSTOMERS_PER_TENANT = 5_000
export const OWNERS_PER_TENANT = 5
const OWNER_WEIGHTS = [40, 18, 15, 15, 12] as const
export const SEED = 42
const NAMESPACE = 'crum-sim-v1'

// ── Deterministic identities ─────────────────────────────────────────────

/** RFC-4122 v3-shaped name UUID (md5 of namespace:name, version bits set). */
export function nameUuid(namespace: string, name: string): string {
  const h = createHash('md5').update(`${namespace}:${name}`).digest('hex')
  const versioned = `${h.slice(0, 12)}3${h.slice(13, 16)}${((Number.parseInt(h.substring(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17)}`
  return [
    versioned.slice(0, 8),
    versioned.slice(8, 12),
    versioned.slice(12, 16),
    versioned.slice(16, 20),
    versioned.slice(20, 32),
  ].join('-')
}

export function simTenantIds(): string[] {
  return Array.from({ length: TENANT_COUNT }, (_, i) => nameUuid(NAMESPACE, `tenant-${i}`))
}

export function simUserIds(tenantIndex: number): string[] {
  return Array.from({ length: OWNERS_PER_TENANT }, (_, i) => nameUuid(NAMESPACE, `tenant-${tenantIndex}-user-${i}`))
}

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    // `>>> 0` (not `| 0`): same 32-bit wrap, and Sonar flags `| 0` as a
    // pseudo-truncation. Every consumer below coerces mod 2^32, so signed
    // vs unsigned staging produces a bit-identical stream (verified).
    a >>>= 0
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))

function pick<T>(rng: Rng, arr: readonly T[]): T {
  const value = arr[Math.floor(rng() * arr.length)]
  if (value === undefined) throw new Error('sim-seed: pick from empty array')
  return value
}

/** Weighted pick: [value, weight] pairs. */
function weighted<T>(rng: Rng, options: readonly (readonly [T, number])[]): T {
  const total = options.reduce((s, [, w]) => s + w, 0)
  let roll = rng() * total
  for (const [value, w] of options) {
    roll -= w
    if (roll < 0) return value
  }
  throw new Error('sim-seed: weighted options exhausted')
}

// ── Word lists (Australian-flavoured, no external faker dependency) ──────

const FIRST_NAMES = [
  'Olivia', 'Amelia', 'Charlotte', 'Isla', 'Grace', 'Zoe', 'Ella', 'Matilda', 'Ivy', 'Harper',
  'Jack', 'Noah', 'Oliver', 'William', 'Lucas', 'Henry', 'Ethan', 'Mason', 'Cooper', 'Liam',
  'Priya', 'Arjun', 'Wei', 'Mei', 'Hassan', 'Fatima', 'Sofia', 'Marco', 'Elena', 'Dmitri',
  'Chloe', 'Lily', 'Georgia', 'Ruby', 'Sienna', 'Elijah', 'James', 'Benjamin', 'Samuel', 'Daniel',
  'Ava', 'Mia', 'Emily', 'Sophie', 'Isabelle', 'Xavier', 'Leo', 'Max', 'Oscar', 'Felix',
] as const

const LAST_NAMES = [
  'Nguyen', 'Thompson', 'Martin', 'Smith', 'Johnson', 'Williams', 'Brown', 'Chen', 'Wang', 'Kaur',
  'Patel', 'Kim', 'Silva', 'Rossi', 'Weber', 'Kowalski', 'O_Brien', 'Murphy', 'Taylor', 'Lee',
  'Walker', 'Harris', 'Clarke', 'Mitchell', 'Turner', 'Campbell', 'Stewart', 'Robertson', 'Thomson', 'Graham',
  'Abbas', 'Ali', 'Hassan', 'Ibrahim', 'Salmon', 'Butler', 'Barnes', 'Fisher', 'Marshall', 'Ellis',
  'Ahmed', 'Mohammed', 'Yu', 'Zhao', 'Lin', 'Huang', 'Wu', 'Yang', 'Kelly', 'Ryan',
] as const

const COMPANIES = [
  'Southern Cross Logistics', 'Billabong Stationery', 'Melbourne Makers Co', 'Sunshine Coast Solar',
  'Yarra Valley Vines', 'Barwon Agro', 'Toorak Trading', 'Geelong Fabrication', 'Adelaide Analytics',
  'Perth Pipe Works', 'Brisbane Buildwell', 'Hobart Harvest', 'Darwin Digital', 'Canberra Consulting',
  'Newcastle Nitro', 'Wollongong Weld', 'Bondi Boutique', 'Parramatta Parts', 'Frankston Foods',
  'Gippsland Grain', 'Riverina Rail', 'Tasman Textiles', 'Coastal Care Clinics', 'Metro Media Group',
  'Apex Accounting', 'Bright Spark Electrical', 'Clearwater Pools', 'Diamond Creek Wines',
  'Eastside Estates', 'Four Winds Sailing', 'Golden Grove Mining', 'Harbour Holdings',
  'Ironbark Insurance', 'Juniper Health', 'Kingsford Kitchens', 'Lakeside Labs', 'Meridian Freight',
  'Northline Retail', 'Omega Office Supplies', 'Pinehill Property',
] as const

const CITIES = [
  'Melbourne', 'Sydney', 'Brisbane', 'Perth', 'Adelaide', 'Canberra', 'Hobart', 'Darwin',
  'Geelong', 'Newcastle', 'Wollongong', 'Townsville', 'Cairns', 'Ballarat', 'Bendigo',
  'Launceston', 'Toowoomba', 'Mandurah', 'Frankston', 'Gold Coast',
] as const

const TAG_POOL = ['vip', 'enterprise', 'smb', 'renewal', 'churn-risk', 'referral', 'partner', 'gov'] as const

const CONTACT_ROLES = [
  'Procurement Manager', 'Operations Lead', 'CFO', 'Founder', 'Office Manager', 'Head of Sales',
  'Project Coordinator', 'Technical Lead', 'PA to CEO', 'Supply Chain Manager',
] as const

const TASK_VERBS = ['Send', 'Review', 'Prepare', 'Follow up on', 'Confirm', 'Draft', 'Chase', 'Schedule'] as const
const TASK_NOUNS = ['the quote', 'the renewal paperwork', 'invoice 4471', 'the site visit', 'delivery dates', 'the sample pack', 'contract redlines', 'the pricing sheet'] as const

// ── Row types (column names match the spine exactly) ─────────────────────

export interface CustomerRow {
  id: string
  tenant_id: string
  name: string
  company: string
  email: string
  phone: string
  city: string
  tags: string[]
  owner_id: string
  team_member_ids: string[]
  created_at: string
}

export interface ContactRow {
  id: string
  tenant_id: string
  customer_id: string
  name: string
  role: string
  email: string
  phone: string
  notes: string | null
  is_primary: boolean
}

export interface FollowupRow {
  id: string
  tenant_id: string
  customer_id: string
  contact_id: string | null
  type: string
  status: string
  scheduled_at: string
  completed_at: string | null
  notes: string | null
  owner_id: string
}

export interface TaskRow {
  id: string
  tenant_id: string
  customer_id: string
  title: string
  description: string | null
  deadline: string | null
  priority: string
  status: string
  owner_id: string
}

export interface ScheduleRow {
  id: string
  tenant_id: string
  customer_id: string
  title: string
  start_time: string
  end_time: string
  location: string
  attendees: string[]
  status: string
  owner_id: string
}

export interface TenantRows {
  customers: CustomerRow[]
  contacts: ContactRow[]
  followups: FollowupRow[]
  tasks: TaskRow[]
  schedules: ScheduleRow[]
}

// ── Pure generator ───────────────────────────────────────────────────────

/**
 * Generates the full simulation graph for one tenant index. Pure: no DB, no
 * clock beyond a fixed epoch so determinism holds across runs. The epoch is a
 * constant (2026-01-05T00:00:00Z), NOT now(), so "scheduled" followups are a
 * stable mix of past and future dates no matter when you seed.
 */
export function generateTenantRows(
  tenantIndex: number,
  opts: { customers?: number; seed?: number } = {},
): TenantRows {
  const customersCount = opts.customers ?? CUSTOMERS_PER_TENANT
  const seed = (opts.seed ?? SEED) + tenantIndex * 1009
  const rng = mulberry32(seed)

  const tenantId = simTenantIds()[tenantIndex]
  if (!tenantId) throw new Error(`sim-seed: no simulation tenant at index ${tenantIndex}`)
  const owners = simUserIds(tenantIndex)
  // Owner 0 holds ~40% of the book; the rest share the remainder.
  const ownerWeights = owners.map((id, i): [string, number] => [id, OWNER_WEIGHTS[i] ?? 10])

  const EPOCH = Date.parse('2026-01-05T00:00:00Z')
  const DAY = 86_400_000
  const iso = (ms: number): string => new Date(ms).toISOString()
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')

  const out: TenantRows = { customers: [], contacts: [], followups: [], tasks: [], schedules: [] }

  for (let i = 0; i < customersCount; i++) {
    const first = pick(rng, FIRST_NAMES)
    const last = pick(rng, LAST_NAMES).replace('_', "'")
    const name = `${first} ${last}`
    const company = `${pick(rng, COMPANIES)}${rng() < 0.3 ? ` ${pick(rng, ['Ltd', 'Pty', 'Group', 'Partners'])}` : ''}`
    const city = pick(rng, CITIES)
    const ownerId = weighted(rng, ownerWeights)

    // 0-3 tags, weighted toward fewer.
    const tagCount = weighted(rng, [[0, 15], [1, 40], [2, 30], [3, 15]] as const)
    const tags: string[] = []
    for (let t = 0; t < tagCount; t++) {
      const tag = pick(rng, TAG_POOL)
      if (!tags.includes(tag)) tags.push(tag)
    }

    // Team: the owner plus 0-2 colleagues.
    const teammates = new Set<string>([ownerId])
    for (let t = 0; t < int(rng, 0, 2); t++) teammates.add(pick(rng, owners))

    const customer: CustomerRow = {
      id: nameUuid(`${NAMESPACE}:c`, `${tenantIndex}:${i}`),
      tenant_id: tenantId,
      name,
      company,
      email: `${slug(first)}.${slug(last)}@${slug(company).slice(0, 24) || 'example'}.com.au`,
      phone: `+61 ${int(rng, 2, 8)} ${int(rng, 1000, 9999)} ${int(rng, 1000, 9999)}`,
      city,
      tags,
      owner_id: ownerId,
      team_member_ids: [...teammates],
      created_at: iso(EPOCH - int(rng, 1, 720) * DAY),
    }
    out.customers.push(customer)

    // 1-3 contacts, exactly one primary.
    const contactCount = int(rng, 1, 3)
    const customerContacts: ContactRow[] = []
    for (let c = 0; c < contactCount; c++) {
      const cFirst = pick(rng, FIRST_NAMES)
      const cLast = pick(rng, LAST_NAMES).replace('_', "'")
      customerContacts.push({
        id: nameUuid(`${NAMESPACE}:k`, `${customer.id}:${c}`),
        tenant_id: tenantId,
        customer_id: customer.id,
        name: `${cFirst} ${cLast}`,
        role: pick(rng, CONTACT_ROLES),
        email: `${slug(cFirst)}.${slug(cLast)}@${slug(company).slice(0, 24) || 'example'}.com.au`,
        phone: `+61 4${int(rng, 10, 99)} ${int(rng, 100, 999)} ${int(rng, 100, 999)}`,
        notes: rng() < 0.3 ? `Met at ${pick(rng, ['Index', 'SALES CON', 'a webinar'])}. Prefers ${pick(rng, ['email', 'calls', 'Site visits'])}.` : null,
        is_primary: c === 0,
      })
    }
    out.contacts.push(...customerContacts)

    // 2-4 followups, avg ~3.
    const followupCount = int(rng, 2, 4)
    for (let f = 0; f < followupCount; f++) {
      const status = weighted(rng, [
        ['scheduled', 45], ['completed', 35], ['missed', 12], ['cancelled', 8],
      ] as const)
      const scheduledAt = EPOCH + int(rng, -90, 45) * DAY + int(rng, 0, 23) * 3_600_000
      const completed = status === 'completed'
      out.followups.push({
        id: nameUuid(`${NAMESPACE}:f`, `${customer.id}:${f}`),
        tenant_id: tenantId,
        customer_id: customer.id,
        contact_id: rng() < 0.8 ? pick(rng, customerContacts).id : null,
        type: weighted(rng, [['call', 45], ['email', 30], ['meeting', 17], ['visit', 8]] as const),
        status,
        scheduled_at: iso(scheduledAt),
        // completed rows require completed_at (CHECK constraint in 0002).
        completed_at: completed ? iso(scheduledAt + int(rng, -6, 6) * 3_600_000) : null,
        notes: rng() < 0.5 ? `${pick(rng, ['Discussed renewal', 'Left voicemail', 'Quoted pricing', 'Booked demo', 'Checked delivery'])}.` : null,
        owner_id: ownerId,
      })
    }

    // 1-3 tasks, avg ~2.
    const taskCount = int(rng, 1, 3)
    for (let t = 0; t < taskCount; t++) {
      const status = weighted(rng, [
        ['open', 40], ['in_progress', 25], ['done', 28], ['cancelled', 7],
      ] as const)
      const overdue = rng() < 0.35
      out.tasks.push({
        id: nameUuid(`${NAMESPACE}:t`, `${customer.id}:${t}`),
        tenant_id: tenantId,
        customer_id: customer.id,
        title: `${pick(rng, TASK_VERBS)} ${pick(rng, TASK_NOUNS)}`,
        description: rng() < 0.6 ? `For ${company}, ${city}.` : null,
        deadline: iso(EPOCH + (overdue ? -int(rng, 1, 21) : int(rng, 1, 45)) * DAY),
        priority: weighted(rng, [['low', 20], ['normal', 50], ['high', 22], ['urgent', 8]] as const),
        status,
        owner_id: ownerId,
      })
    }

    // 0-2 schedules, avg ~1.
    const scheduleCount = int(rng, 0, 2)
    for (let s = 0; s < scheduleCount; s++) {
      const start = EPOCH + int(rng, -30, 30) * DAY + int(rng, 8, 17) * 3_600_000
      const durationMin = pick(rng, [30, 45, 60, 90])
      out.schedules.push({
        id: nameUuid(`${NAMESPACE}:s`, `${customer.id}:${s}`),
        tenant_id: tenantId,
        customer_id: customer.id,
        title: pick(rng, ['Site visit', 'Renewal call', 'Demo', 'Quarterly review', 'Lunch and learn', 'Handover meeting']),
        start_time: iso(start),
        // CHECK end_time > start_time (0002 L117).
        end_time: iso(start + durationMin * 60_000),
        location: rng() < 0.5 ? `${pick(rng, CITIES)} office` : 'Teams',
        attendees: customerContacts.slice(0, 2).map((c) => c.name),
        status: weighted(rng, [['confirmed', 70], ['tentative', 22], ['cancelled', 8]] as const),
        owner_id: ownerId,
      })
    }
  }

  // Attach the team set to each customer row (kept out of the literal above so
  // the row shape stays a plain insert-ready object).
  return out
}

// ── Insertion ────────────────────────────────────────────────────────────

const BATCH = 500

function toSqlString(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    // Postgres array literal: '{a,b,c}' — assignment-castable to text[] and
    // uuid[] columns without an explicit ::cast. Elements here are tags, user
    // uuids, and contact names; any quote is doubled.
    const inner = value.map((v) => String(v).replaceAll("'", "''")).join(',')
    return `'{${inner}}'`
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return `'${value.toISOString()}'`
  if (typeof value !== 'string') {
    throw new Error(`sim-seed: refusing to literalize a ${typeof value} value`)
  }
  return `'${value.replaceAll("'", "''")}'`
}

/** Exported for tests: the SQL builder deserves coverage of its escaping. */
export function batchInsertSql(table: string, columns: readonly string[], rows: readonly object[]): string {
  const values = rows
    .map((r) => {
      const row = r as Record<string, unknown>
      return `(${columns.map((c) => toSqlString(row[c])).join(', ')})`
    })
    .join(',\n')
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values}`
}

async function insertRows(
  run: (sql: string) => Promise<unknown>,
  table: string,
  columns: readonly string[],
  rows: readonly object[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(batchInsertSql(table, columns, rows.slice(i, i + BATCH)))
  }
}

const CUSTOMER_COLS = ['id', 'tenant_id', 'name', 'company', 'email', 'phone', 'city', 'tags', 'owner_id', 'team_member_ids', 'created_at'] as const
const CONTACT_COLS = ['id', 'tenant_id', 'customer_id', 'name', 'role', 'email', 'phone', 'notes', 'is_primary'] as const
const FOLLOWUP_COLS = ['id', 'tenant_id', 'customer_id', 'contact_id', 'type', 'status', 'scheduled_at', 'completed_at', 'notes', 'owner_id'] as const
const TASK_COLS = ['id', 'tenant_id', 'customer_id', 'title', 'description', 'deadline', 'priority', 'status', 'owner_id'] as const
const SCHEDULE_COLS = ['id', 'tenant_id', 'customer_id', 'title', 'start_time', 'end_time', 'location', 'attendees', 'status', 'owner_id'] as const

export async function runSimSeed(log: (msg: string) => void = console.log): Promise<void> {
  const env = parseEnv()
  if (!env.DATABASE_URL) {
    throw new Error('sim:seed requires DATABASE_URL. Unset means the app boots in-memory; a simulation seed against memory is a no-op.')
  }

  // A dedicated pool: the app's shared client uses a 2s connection timeout,
  // which is brittle against a remote pooler from a laptop. The seeder needs
  // patience, not the app's pool budget.
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 30_000,
  })
  const tenants = simTenantIds()
  const tenantList = `'{${tenants.join(', ')}}'::uuid[]`

  // Wipe scoped to the simulation tenants, children first.
  const wipeOrder = ['schedules', 'tasks', 'contacts', 'followups', 'customers']
  log('Wiping previous simulation rows (simulation tenants only)...')
  for (const table of wipeOrder) {
    const res = await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY(${tenantList})`)
    log(`  ${table}: removed ${(res.rowCount ?? 0).toLocaleString()} rows`)
  }

  const started = Date.now()
  let total = 0
  for (let i = 0; i < TENANT_COUNT; i++) {
    const rows = generateTenantRows(i)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await insertRows((sql) => client.query(sql), 'customers', CUSTOMER_COLS, rows.customers)
      await insertRows((sql) => client.query(sql), 'contacts', CONTACT_COLS, rows.contacts)
      await insertRows((sql) => client.query(sql), 'followups', FOLLOWUP_COLS, rows.followups)
      await insertRows((sql) => client.query(sql), 'tasks', TASK_COLS, rows.tasks)
      await insertRows((sql) => client.query(sql), 'schedules', SCHEDULE_COLS, rows.schedules)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    const count = rows.customers.length + rows.contacts.length + rows.followups.length + rows.tasks.length + rows.schedules.length
    total += count
    log(`  tenant ${i}: ${count.toLocaleString()} rows (${total.toLocaleString()} total, ${Math.round((Date.now() - started) / 1000)}s)`)
  }

  log('Verifying counts...')
  for (const table of ['customers', 'contacts', 'followups', 'tasks', 'schedules']) {
    const res = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = ANY(${tenantList})`)
    const n = res.rows[0]?.n ?? 0
    log(`  ${table}: ${n.toLocaleString()}`)
  }

  const elapsed = Math.round((Date.now() - started) / 1000)
  log(`Seeded ${total.toLocaleString()} simulation rows in ${elapsed}s.`)
  log('Dev-mode headers for the console (tenant 0):')
  log(`  x-tenant-id: ${tenants[0]}`)
  log(`  x-user-id:   ${simUserIds(0)[0]}`)
  log('  x-user-role: admin')
  await pool.end()
}

// Direct invocation only; the test file imports the pure parts without running
// anything.
if (process.argv[1] && process.argv[1].includes('sim-seed')) {
  runSimSeed().catch((err) => {
    console.error('Simulation seed failed:', err)
    process.exit(1)
  })
}
