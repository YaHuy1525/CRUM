'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Users } from 'lucide-react'

import { describeError, listSchedules } from '../lib/api'
import type { CrmSchedule } from '../lib/types'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from './ui/skeleton'
import { cn } from '@/lib/utils'


const DAY_START_HOUR = 7
const DAY_END_HOUR = 19
const HOUR_PX = 52
const PX_PER_MIN = HOUR_PX / 60

const PALETTE = ['#5b8def', '#e5735f', '#57a773', '#a06bcf', '#e0a458', '#4bb3bd']
const NEUTRAL = '#8a94a6'

function colorFor(event: CrmSchedule): string {
  const key = event.customer_id
  if (!key) return NEUTRAL
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length] as string
}


const addDays = (d: Date, n: number): Date => {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

export function mondayOf(d: Date): Date {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return monday
}

export function ymd(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const hour = (d: Date): number => d.getHours() + d.getMinutes() / 60

const timeLabel = (d: Date): string =>
  d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })

const dayLabel = (d: Date): string =>
  d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })

const placeable = (events: CrmSchedule[]): CrmSchedule[] =>
  events
    .filter((e) => e.start_time)
    .sort((a, b) => Date.parse(a.start_time!) - Date.parse(b.start_time!))

interface Placed {
  event: CrmSchedule
  lane: number
  lanes: number
}

export function layoutDay(events: CrmSchedule[]): Placed[] {
  const sorted = placeable(events)
  const placed: { event: CrmSchedule; lane: number; cluster: number }[] = []
  const laneEnds: number[] = []
  let cluster = 0
  let clusterEnd = -Infinity
  for (const event of sorted) {
    const start = Date.parse(event.start_time!)
    const end = event.end_time ? Date.parse(event.end_time) : start + 60 * 60_000
    if (start >= clusterEnd) {
      cluster += 1
      laneEnds.length = 0
    }
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else {
      laneEnds[lane] = end
    }
    placed.push({ event, lane, cluster })
    clusterEnd = Math.max(clusterEnd, end)
  }
  const lanesPerCluster = new Map<number, number>()
  for (const p of placed) {
    lanesPerCluster.set(p.cluster, Math.max(lanesPerCluster.get(p.cluster) ?? 0, p.lane + 1))
  }
  return placed.map((p) => ({ event: p.event, lane: p.lane, lanes: lanesPerCluster.get(p.cluster) ?? 1 }))
}


export function CalendarBoard() {
  const [anchor, setAnchor] = useState(() => mondayOf(new Date()))
  const [events, setEvents] = useState<CrmSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState(() => ymd(new Date()))
  const [openEvent, setOpenEvent] = useState<CrmSchedule | null>(null)

  const load = useCallback(async (weekStart: Date) => {
    setLoading(true)
    setError(null)
    try {
      const data = await listSchedules({
        from: ymd(addDays(weekStart, -1)),
        to: ymd(addDays(weekStart, 7)),
        limit: 100,
      })
      const weekKeys = new Set(
        Array.from({ length: 7 }, (_, i) => ymd(addDays(weekStart, i))),
      )
      setEvents(data.items.filter((e) => e.start_time && weekKeys.has(ymd(new Date(e.start_time)))))
    } catch (err) {
      setEvents([])
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(anchor)
  }, [anchor, load])

  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i))
  const todayKey = ymd(new Date())
  const byDay = new Map<string, CrmSchedule[]>()
  for (const day of days) byDay.set(ymd(day), [])
  for (const event of placeable(events)) {
    const key = ymd(new Date(event.start_time!))
    const bucket = byDay.get(key)
    if (bucket) bucket.push(event)
    else byDay.set(key, [event])
  }
  const selectedEvents = byDay.get(selectedDay) ?? []

  const shiftWeek = (weeks: number) => {
    const next = addDays(anchor, weeks * 7)
    setAnchor(next)
    const nextDays = new Set(Array.from({ length: 7 }, (_, i) => ymd(addDays(next, i))))
    setSelectedDay(nextDays.has(todayKey) ? todayKey : ymd(next))
  }

  return (
    <div className="space-y-4" data-testid="calendar-board">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous week" onClick={() => shiftWeek(-1)}>
            <ChevronLeft size={16} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Next week" onClick={() => shiftWeek(1)}>
            <ChevronRight size={16} />
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setAnchor(mondayOf(new Date())); setSelectedDay(todayKey) }}>
          Today
        </Button>
        <p className="text-sm font-semibold text-text-primary">
          {dayLabel(days[0]!)} – {dayLabel(days[6]!)}
        </p>
        <p className="ml-auto text-xs text-text-muted">
          {!loading && !error ? `${events.length} meeting(s) this week` : ''}
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-4 max-md:flex-col">
        <aside className="w-56 shrink-0 space-y-1 max-md:w-full" aria-label="Week agenda">
          <p className="px-2 text-xs font-semibold uppercase tracking-[var(--tracking-label)] text-text-muted">
            Agenda
          </p>
          {days.map((day) => {
            const key = ymd(day)
            const count = byDay.get(key)?.length ?? 0
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedDay(key)}
                className={cn(
                  'focus-ring flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-bg-hover',
                  key === selectedDay ? 'bg-bg-active-pill font-semibold text-text-primary' : 'text-text-secondary',
                  key === todayKey && 'text-accent',
                )}
                data-testid={`agenda-day-${key}`}
              >
                <span>{dayLabel(day)}</span>
                <span className="text-xs text-text-muted">{count > 0 ? `${count}` : ''}</span>
              </button>
            )
          })}
          <div className="space-y-1 pt-2">
            {loading && <Skeleton className="h-10 w-full" />}
            {!loading && selectedEvents.length === 0 && (
              <p className="px-2 text-xs text-text-muted">No meetings on {dayLabel(new Date(selectedDay))}.</p>
            )}
            {!loading &&
              selectedEvents.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => setOpenEvent(event)}
                  className="focus-ring w-full rounded-md border-l-[3px] bg-bg-card px-2 py-1.5 text-left text-xs transition-colors hover:bg-bg-hover"
                  style={{ borderLeftColor: colorFor(event) }}
                >
                  <span className="font-mono text-text-muted">{event.start_time ? timeLabel(new Date(event.start_time)) : '—'}</span>{' '}
                  <span className={cn('font-medium text-text-primary', event.status === 'cancelled' && 'line-through opacity-60')}>
                    {event.title ?? 'Untitled meeting'}
                  </span>
                  {event.customer_company && <span className="block truncate text-text-muted">{event.customer_company}</span>}
                </button>
              ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-bg-card">
          {loading ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : events.length === 0 && !error ? (
            <div className="grid place-items-center p-12 text-center">
              <div>
                <CalendarDays className="mx-auto mb-2 size-8 opacity-40" aria-hidden="true" />
                <p className="text-sm font-medium text-text-secondary">Nothing scheduled this week.</p>
                <p className="mt-1 text-xs text-text-muted">
                  Ask the agent to book a meeting, or seed demo meetings with <code>npm run cal:seed</code>.
                </p>
              </div>
            </div>
          ) : (
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border">
                <div />
                {days.map((day) => {
                  const key = ymd(day)
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedDay(key)}
                      className={cn(
                        'focus-ring px-1 py-2 text-center text-xs font-semibold uppercase tracking-wide',
                        key === todayKey ? 'bg-accent-soft text-accent' : 'text-text-secondary',
                        key === selectedDay && key !== todayKey && 'bg-bg-hover text-text-primary',
                      )}
                      data-testid={`grid-day-${key}`}
                    >
                      {day.toLocaleDateString('en-AU', { weekday: 'short' })}
                      <span className="ml-1 font-mono normal-case">{day.toLocaleDateString('en-AU', { day: '2-digit' })}</span>
                    </button>
                  )
                })}
              </div>
              <div className="relative grid grid-cols-[48px_repeat(7,1fr)]">
                <div className="relative">
                  {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => (
                    <div key={i} className="relative" style={{ height: HOUR_PX }}>
                      <span className="absolute -top-2 right-1 font-mono text-[10px] text-text-muted">
                        {String(DAY_START_HOUR + i).padStart(2, '0')}:00
                      </span>
                    </div>
                  ))}
                </div>
                {days.map((day) => {
                  const key = ymd(day)
                  const placed = layoutDay(byDay.get(key) ?? [])
                  return (
                    <div key={key} className="relative border-l border-border/60">
                      {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => (
                        <div
                          key={i}
                          className="border-b border-border/40"
                          style={{ height: HOUR_PX }}
                          data-hour={DAY_START_HOUR + i}
                        />
                      ))}
                      {key === todayKey && <div className="pointer-events-none absolute inset-0 bg-accent-soft/30" aria-hidden="true" />}
                      {placed.map(({ event, lane, lanes }) => {
                        const start = new Date(event.start_time!)
                        const end = event.end_time ? new Date(event.end_time) : new Date(start.getTime() + 60 * 60_000)
                        const top = Math.min(Math.max((hour(start) - DAY_START_HOUR) * HOUR_PX, 0), (DAY_END_HOUR - DAY_START_HOUR - 0.5) * HOUR_PX)
                        const height = Math.max((Math.max(hour(end), hour(start) + 0.4) - hour(start)) * PX_PER_MIN, 26)
                        const hue = colorFor(event)
                        const cancelled = event.status === 'cancelled'
                        const tentative = event.status === 'tentative'
                        return (
                          <button
                            key={event.id}
                            type="button"
                            onClick={() => setOpenEvent(event)}
                            className={cn(
                              'focus-ring absolute overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition-colors',
                              tentative && 'border-dashed',
                            )}
                            style={{
                              top,
                              height: Math.min(height, (DAY_END_HOUR - DAY_START_HOUR) * HOUR_PX - top),
                              left: `calc(${(lane * 100) / lanes}% + 2px)`,
                              width: `calc(${100 / lanes}% - 4px)`,
                              backgroundColor: `${hue}${cancelled ? '22' : '33'}`,
                              border: `1px ${tentative ? 'dashed' : 'solid'} ${hue}88`,
                              opacity: cancelled ? 0.55 : 1,
                            }}
                            data-testid={`event-${event.id}`}
                            aria-label={`${event.title ?? 'Meeting'} at ${timeLabel(start)}${event.customer_name ? ` with ${event.customer_name}` : ''}`}
                          >
                            <span className="block truncate font-semibold text-text-primary">
                              {timeLabel(start)} {event.title ?? 'Untitled'}
                            </span>
                            <span className={cn('block truncate text-text-secondary', cancelled && 'line-through')}>
                              {event.customer_company ?? event.customer_name ?? 'Internal'}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={openEvent !== null} onOpenChange={(open) => !open && setOpenEvent(null)}>
        <DialogContent>
          {openEvent && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span aria-hidden="true" className="inline-block size-3 rounded-pill" style={{ backgroundColor: colorFor(openEvent) }} />
                  {openEvent.title ?? 'Untitled meeting'}
                </DialogTitle>
                <DialogDescription>
                  {openEvent.start_time && openEvent.end_time
                    ? `${dayLabel(new Date(openEvent.start_time))} · ${timeLabel(new Date(openEvent.start_time))} – ${timeLabel(new Date(openEvent.end_time))}`
                    : openEvent.start_time
                      ? dayLabel(new Date(openEvent.start_time))
                      : 'No time recorded'}
                  {' · '}
                  {openEvent.status ?? 'confirmed'}
                </DialogDescription>
              </DialogHeader>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="sr-only">Customer</dt>
                  <dd>
                    {openEvent.customer_id ? (
                      <Link href={`/customer/${openEvent.customer_id}`} className="focus-ring font-medium text-accent hover:underline">
                        {openEvent.customer_name ?? 'Customer'}
                        {openEvent.customer_company ? ` · ${openEvent.customer_company}` : ''}
                      </Link>
                    ) : (
                      <span className="text-text-muted">No customer linked</span>
                    )}
                  </dd>
                </div>
                {openEvent.location && (
                  <div className="flex items-center gap-2 text-text-secondary">
                    <MapPin size={14} aria-hidden="true" />
                    {openEvent.location}
                  </div>
                )}
                {openEvent.attendees && openEvent.attendees.length > 0 && (
                  <div className="flex items-start gap-2 text-text-secondary">
                    <Users size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{openEvent.attendees.join(', ')}</span>
                  </div>
                )}
              </dl>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
