// scripts/calendar-seed.ts
//
// Demo meeting seeder for the /calendar board. The console's demo tenant has a
// full customer book (5,000 rows, real contacts) but 0 schedules, which makes
// the board an empty grid. This script writes ~24 business meetings for the
// demo tenant across THIS week and next, attached to real customer rows and
// staffed with real contact names as attendees, so the board reads like a CRM.
//
// Safety contract (mirrors sim-seed):
// - Refuses to run without DATABASE_URL.
// - The wipe is a single DELETE scoped to the target tenant's schedules and
//   nothing else. Governance tables are untouched. Idempotent: re-run to
//   refresh the week anchors (they intentionally follow the current date, so
//   the demo always lands on a populated board instead of a 2026-01 grid).
// - Defaults to the console's demo tenant/user ids; override with
//   --tenant / --user for another workspace.
//
// Usage: npm run cal:seed
import { setDefaultResultOrder } from 'node:dns'
import { Pool } from 'pg'
import { parseEnv } from '../src/config/env'

setDefaultResultOrder('ipv4first')

const DEMO_TENANT = '4fc9d503-7095-38fb-8bc9-f01dbdffe5f2'
const DEMO_USER = '97fb4fe1-83ed-311b-9c66-80dd388fff3b'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : fallback
}

// Deterministic PRNG (mulberry32, same generator as sim-seed) so a re-run of
// this week produces the same board.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    // `>>> 0` staging, same as sim-seed: bit-identical to the old `| 0`
    // form, without tripping the Sonar `| 0` rule.
    a >>>= 0
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(20261026)
const int = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T

const TITLES = [
  'Site visit', 'Renewal call', 'Product demo', 'Quarterly review', 'Proposal walkthrough',
  'Onboarding kickoff', 'Pricing workshop', 'Handover meeting', 'Contract redlines review',
  'Lunch and learn', 'Delivery checkpoint', 'Expansion catch-up',
] as const

// Times deliberately collide (two 09:30 slots per busy day) so the overlap
// lanes in the board are exercised rather than theoretical.
const SLOTS = [8, 9, 9.5, 10.5, 11.5, 13, 14, 15, 16, 17] as const

interface CustomerSeed {
  id: string
  name: string
  company: string
  city: string
  attendees: string[]
}

async function main(): Promise<void> {
  const env = parseEnv()
  if (!env.DATABASE_URL) {
    throw new Error('cal:seed requires DATABASE_URL. The demo board seeds the real database or not at all.')
  }
  const tenant = arg('tenant', DEMO_TENANT)
  const owner = arg('user', DEMO_USER)

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 2,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 30_000,
  })

  // Real customers, oldest first, plus up to two of their real contacts.
  const customers = await pool.query<CustomerSeed>(
    `SELECT c.id, c.name, c.company, c.city,
            COALESCE((SELECT array_agg(t.name) FROM (
              SELECT name FROM contacts k
              WHERE k.customer_id = c.id
              ORDER BY k.is_primary DESC NULLS LAST, k.name LIMIT 2
            ) t), '{}') AS attendees
     FROM customers c
     WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.created_at ASC, c.name ASC
     LIMIT 30`,
    [tenant],
  )
  if (customers.rows.length < 8) {
    throw new Error(`cal:seed needs a seeded customer book (found ${customers.rows.length}); run npm run sim:seed first.`)
  }

  // Monday 00:00 local of the current week; next week gets sparser coverage.
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))

  const plan: { day: number; hour: number }[] = []
  for (let week = 0; week < 2; week++) {
    for (let dow = 0; dow < 5; dow++) {
      const count = week === 0 ? int(3, 5) : int(1, 3)
      const used = new Set<number>()
      for (let n = 0; n < count; n++) {
        let slot = int(0, SLOTS.length - 1)
        // Allow one deliberate collision per day; then avoid repeats.
        if (used.has(slot) && rng() > 0.25) slot = (slot + 3) % SLOTS.length
        used.add(slot)
        plan.push({ day: week * 7 + dow, hour: SLOTS[slot] ?? 9 })
      }
    }
  }

  console.log(`Wiping tenant ${tenant.slice(0, 8)}… schedules...`)
  const wiped = await pool.query('DELETE FROM schedules WHERE tenant_id = $1', [tenant])
  console.log(`  removed ${wiped.rowCount ?? 0} rows`)

  let inserted = 0
  for (let i = 0; i < plan.length; i++) {
    const slot = plan[i]!
    const customer = customers.rows[i % customers.rows.length]!
    const start = new Date(monday)
    start.setDate(start.getDate() + slot.day)
    start.setHours(Math.floor(slot.hour), (slot.hour % 1) * 60, 0, 0)
    const durationMin = pick([30, 45, 60, 90])
    const end = new Date(start.getTime() + durationMin * 60_000)
    // Cancelled first: the old order let `i % 9 === 4` swallow the cancelled
    // index (plan.length - 3 = 31, and 31 % 9 = 4) so no cancelled row ever
    // seeded and the struck-through path went unexercised (browser check found it).
    const status = i === 12 ? 'cancelled' : i % 9 === 4 ? 'tentative' : 'confirmed'
    const location = pick([
      'Google Meet',
      'Teams',
      `${customer.city} office`,
      `${customer.company} HQ`,
    ])
    const attendees = customer.attendees.length > 0 ? customer.attendees : [customer.name]
    await pool.query(
      `INSERT INTO schedules (tenant_id, customer_id, title, start_time, end_time, location, attendees, status, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenant, customer.id, pick(TITLES), start.toISOString(), end.toISOString(), location, attendees, status, owner],
    )
    inserted++
  }

  console.log(`Seeded ${inserted} meetings for the week of ${monday.toDateString()}.`)
  console.log('Board: http://localhost:3000/calendar')
  await pool.end()
}

main().catch((err) => {
  console.error('Calendar seed failed:', err)
  process.exit(1)
})
