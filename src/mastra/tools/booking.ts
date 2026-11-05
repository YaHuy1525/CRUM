// src/mastra/tools/booking.ts
// Cal.diy booking tools: availability checks (read-only), booking link
// generation (approval required — it stages a meeting a human did not yet
// confirm), and booking confirmation/cancellation (approval required — a
// cancelled booking that nobody signed off on is the same class of mistake as
// an outbound message sent without review).

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { parseEnv } from '../../config/env'
import { calConfigured, getAvailability, createBookingLink, confirmBooking } from '../../booking/cal'
import { TenantRequestContextSchema } from '../../mastra/tenant-context'

const AvailabilityOutputSchema = z.object({
  availableSlots: z.array(
    z.object({
      startIso: z.string(),
      endIso: z.string(),
    }),
  ),
})

const BookingLinkOutputSchema = z.object({
  bookingUrl: z.string(),
  eventTypeId: z.number(),
  expiresAt: z.string().datetime({ offset: true }),
})

const BookingConfirmOutputSchema = z.object({
  bookingId: z.string(),
  status: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
})

export const bookingGetAvailabilityTool = createTool({
  id: 'booking.get_availability',
  title: 'Get Booking Availability',
  description:
    'Check available time slots for a booking event type on Cal.diy. Read-only: no side effects, no approval required. Requires CRUM_CAL_URL and CRUM_CAL_API_KEY.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    eventTypeId: z.number().int().positive(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
    timezone: z.string().trim().min(1).default('Australia/Sydney').optional(),
  }),
  outputSchema: AvailabilityOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) =>
    context.observe.span('booking.get_availability', async () => {
      const env = parseEnv()
      const config = calConfigured(env)
      if (!config) {
        throw new Error('Cal.diy not configured: set CRUM_CAL_URL and CRUM_CAL_API_KEY')
      }
      return getAvailability(config, input.eventTypeId, {
        startDate: input.startDate,
        endDate: input.endDate,
        timezone: input.timezone,
      })
    }),
})

export const bookingCreateLinkTool = createTool({
  id: 'booking.create_link',
  title: 'Create Booking Link',
  description:
    'Generate a booking page link for a contact to schedule a meeting. The link points to the configured Cal.diy instance and encodes the event type, duration and preferred date. Requires human approval.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    eventTypeId: z.number().int().positive(),
    durationMinutes: z.number().int().positive().default(30).optional(),
    preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
    contactEmail: z.string().email().optional(),
  }),
  outputSchema: BookingLinkOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('booking.create_link', async () => {
      const env = parseEnv()
      const config = calConfigured(env)
      if (!config) {
        throw new Error('Cal.diy not configured: set CRUM_CAL_URL and CRUM_CAL_API_KEY')
      }
      const bookingUrl = createBookingLink(
        config,
        input.eventTypeId,
        input.durationMinutes,
        input.preferredDate,
      )
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      return {
        bookingUrl,
        eventTypeId: input.eventTypeId,
        expiresAt,
      }
    }),
})

export const bookingConfirmTool = createTool({
  id: 'booking.confirm_booking',
  title: 'Confirm or Cancel Booking',
  description:
    'Confirm or cancel a booking in Cal.diy. This changes the state of a real booking and may notify the participant. Requires human approval.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    bookingId: z.string().trim().min(1),
    status: z.enum(['confirmed', 'cancelled']),
    reason: z.string().trim().max(500).optional(),
  }),
  outputSchema: BookingConfirmOutputSchema,
  outputValidation: 'warn',

  requireApproval: () => true,

  execute: async (input, context) =>
    context.observe.span('booking.confirm_booking', async () => {
      const env = parseEnv()
      const config = calConfigured(env)
      if (!config) {
        throw new Error('Cal.diy not configured: set CRUM_CAL_URL and CRUM_CAL_API_KEY')
      }
      return confirmBooking(config, input.bookingId, input.status, input.reason)
    }),
})
