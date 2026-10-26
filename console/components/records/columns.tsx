'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import type { CrmContact, CrmFollowup, CrmSchedule, CrmTask, CustomerRow } from '@/lib/types'

/**
 * Column sets for the Records tables.
 *
 * Kept in one module because the same five object types are rendered in two
 * places — the `/records` browser and the customer detail page — and a second
 * copy of "what a task row shows" is how the two drift apart. A column is a
 * header plus a cell renderer, not a JSON config, because half of these cells are
 * links and badges and a serialisable config would only be a worse JSX.
 *
 * Dates print as absolute timestamps with a stable locale argument. `undefined`
 * shows an em dash: an unknown time is not the same fact as "now", and a row
 * missing a deadline should say so rather than borrow today's date.
 */

export interface Column<T> {
  header: string
  cell: (row: T) => ReactNode
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function abbreviated(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—'
}

/** A customer id rendered as the one place a reader can usefully go next. */
function CustomerLink({ id }: { id: string | null | undefined }) {
  if (!id) return <span className="text-text-muted">No customer</span>
  return (
    <Link
      href={`/records/customers/${id}`}
      className="font-mono text-xs text-accent-bright underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-accent"
      title={id}
    >
      {abbreviated(id)}
    </Link>
  )
}

type BadgeVariant = 'success' | 'warning' | 'danger' | 'secondary'

/**
 * Status colour follows meaning, not vocabulary: a cancelled slot and a failed
 * document are both terminal-and-bad, an open task and a confirmed slot are both
 * live. Anything unrecognised stays neutral instead of being coloured as good.
 */
function statusVariant(status: string | null | undefined): BadgeVariant {
  switch (status) {
    case 'done':
    case 'completed':
    case 'confirmed':
    case 'open':
    case 'normal':
      return 'success'
    case 'in_progress':
    case 'tentative':
    case 'high':
      return 'warning'
    case 'cancelled':
    case 'missed':
    case 'urgent':
      return 'danger'
    default:
      return 'secondary'
  }
}

function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-text-muted">—</span>
  return <Badge variant={statusVariant(value)}>{value.replace(/_/g, ' ')}</Badge>
}

export const CUSTOMER_COLUMNS: Column<CustomerRow>[] = [
  {
    header: 'Name',
    cell: (row) => (
      <Link
        href={`/records/customers/${row.id}`}
        className="font-medium text-text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-accent"
      >
        {row.name}
      </Link>
    ),
  },
  { header: 'City', cell: (row) => row.city ?? <span className="text-text-muted">—</span> },
  {
    header: 'Tags',
    cell: (row) =>
      row.tags && row.tags.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-text-muted">—</span>
      ),
  },
  { header: 'Added', cell: (row) => <span className="text-text-muted">{when(row.created_at)}</span> },
]

export const CONTACT_COLUMNS: Column<CrmContact>[] = [
  { header: 'Name', cell: (row) => <span className="font-medium text-text-primary">{row.name}</span> },
  { header: 'Role', cell: (row) => row.role ?? <span className="text-text-muted">—</span> },
  { header: 'Email', cell: (row) => row.email ?? <span className="text-text-muted">—</span> },
  { header: 'Customer', cell: (row) => <CustomerLink id={row.customer_id} /> },
]

export const FOLLOWUP_COLUMNS: Column<CrmFollowup>[] = [
  { header: 'Type', cell: (row) => row.type ?? <span className="text-text-muted">—</span> },
  { header: 'Status', cell: (row) => <Status value={row.status} /> },
  { header: 'Scheduled', cell: (row) => <span className="text-text-muted">{when(row.scheduled_at)}</span> },
  {
    header: 'Notes',
    cell: (row) => (
      <span className="block max-w-[24rem] truncate" title={row.notes ?? undefined}>
        {row.notes ?? <span className="text-text-muted">—</span>}
      </span>
    ),
  },
  { header: 'Customer', cell: (row) => <CustomerLink id={row.customer_id} /> },
]

export const TASK_COLUMNS: Column<CrmTask>[] = [
  {
    header: 'Title',
    cell: (row) => (
      <span className="font-medium text-text-primary">{row.title ?? `Task ${abbreviated(row.id)}`}</span>
    ),
  },
  { header: 'Status', cell: (row) => <Status value={row.status} /> },
  { header: 'Priority', cell: (row) => <Status value={row.priority} /> },
  { header: 'Deadline', cell: (row) => <span className="text-text-muted">{when(row.deadline)}</span> },
  { header: 'Customer', cell: (row) => <CustomerLink id={row.customer_id} /> },
]

export const SCHEDULE_COLUMNS: Column<CrmSchedule>[] = [
  {
    header: 'Title',
    cell: (row) => (
      <span className="font-medium text-text-primary">{row.title ?? `Slot ${abbreviated(row.id)}`}</span>
    ),
  },
  { header: 'Starts', cell: (row) => when(row.start_time) },
  { header: 'Ends', cell: (row) => <span className="text-text-muted">{when(row.end_time)}</span> },
  { header: 'Location', cell: (row) => row.location ?? <span className="text-text-muted">—</span> },
  { header: 'Status', cell: (row) => <Status value={row.status} /> },
  { header: 'Customer', cell: (row) => <CustomerLink id={row.customer_id} /> },
]
