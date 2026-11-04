// src/calendar/google.ts
// Google Calendar event creation. The OAuth plumbing is the Gmail connector's:
// the same google client id, the same encrypted refresh tokens in
// gmail_connections, the same access-token cache. Only the API host and the
// scope differ, so a tenant that already connected Gmail gets Calendar by
// re-running consent (include_granted_scopes makes that incremental).

import type { CrumEnv } from '../config/env'
import { resolveGmailAccess } from '../gmail/client'

const CALENDAR_API_ROOT = 'https://www.googleapis.com/calendar/v3'

export class CalendarApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CalendarApiError'
    this.status = status
  }
}

export interface CalendarEventInput {
  summary: string
  startIso: string
  endIso: string
  description?: string
  location?: string
  attendeeEmails?: string[]
}

export interface CalendarEventResult {
  id: string
  htmlLink: string
}

/**
 * Create an event on the connected user's primary calendar. Returns the event
 * id and its web link so the receipt can name exactly what was created.
 */
export async function createCalendarEvent(
  accessToken: string,
  event: CalendarEventInput,
): Promise<CalendarEventResult> {
  const body: Record<string, unknown> = {
    summary: event.summary,
    start: { dateTime: event.startIso },
    end: { dateTime: event.endIso },
  }
  if (event.description) body.description = event.description
  if (event.location) body.location = event.location
  if (event.attendeeEmails?.length) {
    body.attendees = event.attendeeEmails.map((email) => ({ email }))
  }

  const res = await fetch(`${CALENDAR_API_ROOT}/calendars/primary/events?sendUpdates=none`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  const json = (await res.json().catch(() => ({}))) as { id?: string; htmlLink?: string; error?: { message?: string } }
  if (!res.ok || !json.id) {
    throw new CalendarApiError(
      `calendar events.insert failed: ${json.error?.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return { id: json.id, htmlLink: json.htmlLink ?? '' }
}

/**
 * Resolve a Google access token for this tenant user through the Gmail
 * connector's plumbing, then create the event. The ok:false reasons are the
 * connector's own words (not configured, no connection, refresh failed) so the
 * tool's error names the actual missing step.
 */
export async function scheduleCalendarEvent(
  env: CrumEnv,
  tenantId: string,
  userId: string,
  event: CalendarEventInput,
): Promise<CalendarEventResult> {
  const access = await resolveGmailAccess(env, tenantId, userId)
  if (!access.ok) throw new CalendarApiError(`calendar event not created: ${access.reason}`, 401)
  return createCalendarEvent(access.accessToken, event)
}
