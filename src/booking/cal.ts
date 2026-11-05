// src/booking/cal.ts
// Cal.diy adapter: open-source scheduling/booking platform (fork of Cal.com).
// Uses the same API as Cal.com. Provides availability checks, booking link
// generation, and booking confirmation/cancellation.

import type { CrumEnv } from '../config/env'

export class CalError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CalError'
    this.status = status
  }
}

export interface CalConfig {
  apiUrl: string // Cal.diy instance URL
  apiKey: string // API key
}

export function calConfigured(env: CrumEnv): CalConfig | null {
  if (!env.CRUM_CAL_URL || !env.CRUM_CAL_API_KEY) return null
  return { apiUrl: env.CRUM_CAL_URL, apiKey: env.CRUM_CAL_API_KEY }
}

export interface TimeSlot {
  startIso: string
  endIso: string
}

export interface AvailabilityResponse {
  availableSlots: TimeSlot[]
}

/**
 * GET /api/v2/availability — returns available time slots for an event type
 * within a date range.
 */
export async function getAvailability(
  config: CalConfig,
  eventTypeId: number,
  dateRange: { startDate: string; endDate: string; timezone?: string },
): Promise<AvailabilityResponse> {
  const params = new URLSearchParams({
    eventTypeId: eventTypeId.toString(),
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    apiKey: config.apiKey,
  })
  if (dateRange.timezone) {
    params.set('timezone', dateRange.timezone)
  }

  const url = `${config.apiUrl}/api/v2/availability?${params.toString()}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new CalError(
      `Cal.diy availability check failed: HTTP ${res.status} ${text.slice(0, 200)}`.trim(),
      res.status,
    )
  }

  const data = (await res.json()) as { availableSlots?: TimeSlot[]; slots?: TimeSlot[] }
  return {
    availableSlots: data.availableSlots || data.slots || [],
  }
}

/**
 * Constructs a booking URL like {apiUrl}/booking/{eventTypeId} with query
 * params for duration and date.
 */
export function createBookingLink(
  config: CalConfig,
  eventTypeId: number,
  duration?: number,
  date?: string,
): string {
  const params = new URLSearchParams()
  if (duration) {
    params.set('duration', duration.toString())
  }
  if (date) {
    params.set('date', date)
  }

  const queryString = params.toString()
  return `${config.apiUrl}/booking/${eventTypeId}${queryString ? '?' + queryString : ''}`
}

export interface BookingUpdateResponse {
  bookingId: string
  status: string
  updatedAt: string
}

/**
 * PATCH /api/v2/bookings/{id} — confirms or cancels a booking.
 */
export async function confirmBooking(
  config: CalConfig,
  bookingId: string,
  status: 'confirmed' | 'cancelled',
  reason?: string,
): Promise<BookingUpdateResponse> {
  const url = `${config.apiUrl}/api/v2/bookings/${bookingId}`
  const body: Record<string, unknown> = { status }
  if (reason) {
    body.reason = reason
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new CalError(
      `Cal.diy booking update failed: HTTP ${res.status} ${text.slice(0, 200)}`.trim(),
      res.status,
    )
  }

  const data = (await res.json()) as { id?: string; status?: string; updatedAt?: string }
  return {
    bookingId: data.id || bookingId,
    status: data.status || status,
    updatedAt: data.updatedAt || new Date().toISOString(),
  }
}
