import { z } from 'zod'

export const CustomerParseSchema = z.object({
  name: z.string(),
  company: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  tags: z.array(z.string()).default([]),
})

export const ContactParseSchema = z.object({
  firstName: z.string(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  customerId: z.string().uuid().optional(),
})

export const ScheduleParseSchema = z.object({
  title: z.string(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).default([]),
  notes: z.string().optional(),
})

export const TaskParseSchema = z.object({
  title: z.string(),
  dueDate: z.string().datetime().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  assignee: z.string().optional(),
  description: z.string().optional(),
})

/**
 * Map of object type to parse schema. Each schema is passed as
 * `structuredOutput.schema` to the parser agent. Multi-record paste uses an
 * array wrapper; each element stages as its own pending write (§6.2).
 */
export const PREFILL_SCHEMAS = {
  customer: CustomerParseSchema,
  contact: ContactParseSchema,
  schedule: ScheduleParseSchema,
  task: TaskParseSchema,
} as const

export type PrefillObjectType = keyof typeof PREFILL_SCHEMAS
