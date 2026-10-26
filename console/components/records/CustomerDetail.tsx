'use client'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'

import { ApiError, describeError, get, listContacts, listFollowups, listTasks } from '@/lib/api'
import type { CrmContact, CrmFollowup, CrmTask, CustomerRow } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  CONTACT_COLUMNS,
  FOLLOWUP_COLUMNS,
  TASK_COLUMNS,
  type Column,
} from './columns'
import { RECORDS_PAGE_SIZE, RecordsTable } from './RecordsTable'

/**
 * One customer, with its related objects beneath the header.
 * §"Route map": "Customer detail with related contacts, follow-ups, and tasks
 * beneath."
 *
 * The header reads `GET /api/crm/customers/:id`, the HTTP face of
 * `crm.get_customer`'s own query, so this page cannot show a row the agent's tool
 * would refuse. The three lists below read the tenant-wide endpoints with a
 * `customerId` filter rather than three new nested routes: same rows, same
 * visibility, one SQL path to maintain.
 *
 * A 404 becomes `notFound()` instead of an empty record, for the reason the
 * conversation view gives: the plane answers "no such row" and "not yours" with
 * one body, and painting a blank customer over either would be a fabrication.
 *
 * There is no edit form. Every CRM change is staged by the agent and committed by
 * the approval queue, so the only action here is the hand-off to a chat.
 */

/** The related-object tables drop the Customer column: every row is this one. */
const RELATED_CONTACT_COLUMNS: Column<CrmContact>[] = CONTACT_COLUMNS.filter(
  (column) => column.header !== 'Customer',
)
const RELATED_FOLLOWUP_COLUMNS: Column<CrmFollowup>[] = FOLLOWUP_COLUMNS.filter(
  (column) => column.header !== 'Customer',
)
const RELATED_TASK_COLUMNS: Column<CrmTask>[] = TASK_COLUMNS.filter(
  (column) => column.header !== 'Customer',
)

export function CustomerDetail({ customerId }: { customerId: string }) {
  const customer = useQuery({
    queryKey: ['crm-customer', customerId],
    queryFn: () =>
      get<{ customer: CustomerRow }>(`/api/crm/customers/${encodeURIComponent(customerId)}`),
  })

  if (customer.isError) {
    if (customer.error instanceof ApiError && customer.error.status === 404) notFound()
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span>{describeError(customer.error)}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void customer.refetch()}
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (customer.isPending) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <p className="sr-only" role="status">
          Loading customer
        </p>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="mt-4 h-4 w-40" />
      </div>
    )
  }

  const row = customer.data.customer
  const prompt = `Tell me about ${row.name} (customer id ${row.id}).`
  const description = [row.city, row.tags?.length ? row.tags.join(' · ') : undefined]
    .filter(Boolean)
    .join(' · ')

  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10">
      <PageHeader
        title={row.name}
        description={description || 'Customer record'}
        actions={
          <Link
            href={`/chats/new?prompt=${encodeURIComponent(prompt)}`}
            className="focus-ring inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg shadow-accent transition-colors hover:bg-accent/90"
          >
            Ask about this record
          </Link>
        }
      />

      <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-text-muted">Customer id</dt>
          <dd className="font-mono text-xs text-text-secondary">{row.id}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-text-muted">Added</dt>
          <dd className="text-text-secondary">
            {new Date(row.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </dd>
        </div>
        {row.tags && row.tags.length > 0 ? (
          <div className="flex items-center gap-1">
            {row.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </dl>

      <section className="mt-10" aria-labelledby="related-contacts">
        <h2 id="related-contacts" className="font-display text-lg text-text-primary">
          Contacts
        </h2>
        <RecordsTable
          queryKey={['records', 'contacts', customerId]}
          fetchPage={(offset) =>
            listContacts({ limit: RECORDS_PAGE_SIZE, offset, customerId })
          }
          columns={RELATED_CONTACT_COLUMNS}
          noun="contacts"
          empty={<p>No contacts for this customer yet.</p>}
        />
      </section>

      <section className="mt-10" aria-labelledby="related-followups">
        <h2 id="related-followups" className="font-display text-lg text-text-primary">
          Follow-ups
        </h2>
        <RecordsTable
          queryKey={['records', 'followups', customerId]}
          fetchPage={(offset) =>
            listFollowups({ limit: RECORDS_PAGE_SIZE, offset, customerId })
          }
          columns={RELATED_FOLLOWUP_COLUMNS}
          noun="follow-ups"
          empty={<p>No follow-ups for this customer yet.</p>}
        />
      </section>

      <section className="mt-10" aria-labelledby="related-tasks">
        <h2 id="related-tasks" className="font-display text-lg text-text-primary">
          Tasks
        </h2>
        <RecordsTable
          queryKey={['records', 'tasks', customerId]}
          fetchPage={(offset) => listTasks({ limit: RECORDS_PAGE_SIZE, offset, customerId })}
          columns={RELATED_TASK_COLUMNS}
          noun="tasks"
          empty={<p>No tasks for this customer yet.</p>}
        />
      </section>
    </main>
  )
}
