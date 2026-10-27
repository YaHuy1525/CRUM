import { describe, expect, it } from 'vitest'
import {
  ContactRowSchema,
  CustomerRowSchema,
  FollowupRowSchema,
  ScheduleRowSchema,
  TaskRowSchema,
} from '../../../src/mastra/tools/row-fields'

/**
 * These schemas describe rows, and the row that matters is the one
 * `node-postgres` returns from `SELECT *`, not the one a fixture hand-writes.
 * Two differences broke every read tool against the real database while every
 * test stayed green, so both are pinned here.
 *
 * 1. `timestamptz` arrives as a `Date`. A `z.string()` field rejected it, so a
 *    read that found zero rows worked and a read that found one row failed.
 * 2. `team_member_ids` exists only on `customers`. The other four tables never
 *    had it, yet their schemas required it as a non-optional array, so those rows
 *    could not validate at all.
 *
 * The fixtures below mirror `migrations/0002_crum_spine.sql` column for column:
 * the nullable ones are `null`, the NOT NULL ones are present, and nothing that
 * the DDL does not have is invented.
 */

const CREATED = new Date('2026-10-20T09:00:00.000Z')
const UPDATED = new Date('2026-10-21T09:00:00.000Z')

const driverCustomerRow = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  name: 'Acme Corp',
  company: null,
  email: null,
  phone: null,
  city: null,
  tags: ['enterprise'],
  owner_id: '33333333-3333-4333-8333-333333333333',
  team_member_ids: [],
  created_at: CREATED,
  updated_at: UPDATED,
  deleted_at: null,
}

const driverContactRow = {
  id: '44444444-4444-4444-8444-444444444444',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  customer_id: '11111111-1111-4111-8111-111111111111',
  name: 'Grace Park',
  role: null,
  email: null,
  phone: '+61400000000',
  notes: null,
  is_primary: true,
  created_at: CREATED,
  updated_at: UPDATED,
}

const driverFollowupRow = {
  id: '55555555-5555-4555-8555-555555555555',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  customer_id: '11111111-1111-4111-8111-111111111111',
  contact_id: null,
  type: 'call',
  status: 'missed',
  scheduled_at: CREATED,
  completed_at: null,
  notes: null,
  owner_id: '33333333-3333-4333-8333-333333333333',
  created_at: CREATED,
  updated_at: UPDATED,
}

const driverTaskRow = {
  id: '66666666-6666-4666-8666-666666666666',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  customer_id: null,
  title: 'Send the renewal',
  description: null,
  deadline: null,
  priority: 'high',
  status: 'open',
  assigned_to: null,
  owner_id: '33333333-3333-4333-8333-333333333333',
  created_at: CREATED,
  updated_at: UPDATED,
}

const driverScheduleRow = {
  id: '77777777-7777-4777-8777-777777777777',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  customer_id: '11111111-1111-4111-8111-111111111111',
  title: 'QBA review',
  start_time: CREATED,
  end_time: UPDATED,
  location: null,
  attendees: [],
  status: 'confirmed',
  owner_id: '33333333-3333-4333-8333-333333333333',
  created_at: CREATED,
  updated_at: UPDATED,
}

describe('read-tool row schemas against driver rows', () => {
  it.each([
    ['customers', CustomerRowSchema, driverCustomerRow],
    ['contacts', ContactRowSchema, driverContactRow],
    ['followups', FollowupRowSchema, driverFollowupRow],
    ['tasks', TaskRowSchema, driverTaskRow],
    ['schedules', ScheduleRowSchema, driverScheduleRow],
  ])('validates a %s row as node-postgres returns it', (_table, schema, row) => {
    const result = schema.safeParse(row)
    if (!result.success) {
      throw new Error(
        `${JSON.stringify(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))}`,
      )
    }
  })

  it('normalises the Date the driver hands back into the ISO string the app speaks', () => {
    const parsed = TaskRowSchema.parse(driverTaskRow)
    expect(parsed.created_at).toBe('2026-10-20T09:00:00.000Z')
    expect(parsed.updated_at).toBe('2026-10-21T09:00:00.000Z')
  })

  it('still accepts an ISO string, so a serialised row round-trips', () => {
    const parsed = FollowupRowSchema.parse({
      ...driverFollowupRow,
      created_at: '2026-10-20T09:00:00.000Z',
      scheduled_at: '2026-10-20T09:00:00.000Z',
    })
    expect(parsed.created_at).toBe('2026-10-20T09:00:00.000Z')
  })

  it('keeps the nullable columns nullable instead of dropping the row', () => {
    const parsed = ContactRowSchema.parse(driverContactRow)
    expect(parsed.role).toBeNull()
    expect(parsed.email).toBeNull()
  })

  it('strips the owner columns that only customers carries', () => {
    // `contacts`, `followups`, `tasks` and `schedules` have no `team_member_ids`,
    // so a schema that required one could never validate a real row. A schema that
    // omits it must also not leak a `null` for it into the model context.
    expect(ContactRowSchema.parse(driverContactRow)).not.toHaveProperty('team_member_ids')
    expect(FollowupRowSchema.parse(driverFollowupRow)).not.toHaveProperty('team_member_ids')
    expect(TaskRowSchema.parse(driverTaskRow)).not.toHaveProperty('team_member_ids')
    expect(ScheduleRowSchema.parse(driverScheduleRow)).not.toHaveProperty('team_member_ids')
    expect(CustomerRowSchema.parse(driverCustomerRow)).toHaveProperty('team_member_ids', [])
  })
})
