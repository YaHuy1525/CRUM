import { z } from 'zod'

export const timestamptz = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value))

export const nullableTimestamptz = timestamptz.nullish()

export const CustomerRowSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  city: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  owner_id: z.string(),
  team_member_ids: z.array(z.string()),
  created_at: timestamptz,
  updated_at: timestamptz,
  deleted_at: nullableTimestamptz,
})

export const ContactRowSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string(),
  name: z.string(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  is_primary: z.boolean().optional(),
  created_at: timestamptz,
  updated_at: timestamptz,
})


export const FollowupRowSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  scheduled_at: timestamptz.optional(),
  completed_at: nullableTimestamptz,
  notes: z.string().nullable().optional(),
  owner_id: z.string(),
  created_at: timestamptz,
  updated_at: timestamptz,
})


export const TaskRowSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string().nullable(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  deadline: nullableTimestamptz,
  priority: z.string().optional(),
  status: z.string().optional(),
  assigned_to: z.string().nullable().optional(),
  owner_id: z.string(),
  created_at: timestamptz,
  updated_at: timestamptz,
})


export const ScheduleRowSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  customer_id: z.string().nullable(),
  title: z.string().optional(),
  start_time: timestamptz.optional(),
  end_time: timestamptz.optional(),
  location: z.string().nullable().optional(),
  attendees: z.array(z.string()).optional(),
  status: z.string().optional(),
  owner_id: z.string(),
  created_at: timestamptz,
  updated_at: timestamptz,
})
