'use client'

import type { ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'

import { describeError } from '@/lib/api'
import type { CrmListResponse } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Column } from './columns'

/**
 * One paged Records table, shared by the `/records` browser and the customer
 * detail page. §"Page migrations" ("read only list endpoints ... are paginated").
 *
 * Paging is infinite-query paging over `offset`, not a page-number control: the
 * plane returns `hasMore` computed from the page it actually served, so "Load
 * more" can never ask for a page that holds nothing. Rows accumulate, which is
 * what a record browser wants — paging backwards through a CRM list is a
 * scroll-and-lose-your-place experience.
 *
 * The three states are distinct on purpose, because the failure this table must
 * never produce is an empty list over an unreachable plane:
 *
 * - reading: skeleton rows
 * - failed: `role="alert"` with the plane's own sentence and a Retry
 * - empty: the caller's copy for this entity, never a borrowed generic one
 */

export const RECORDS_PAGE_SIZE = 25

export interface RecordsTableProps<T extends { id: string }> {
  /** Encodes the entity and every filter, so a filter change is a new read. */
  queryKey: unknown[]
  /** Fetches one page. The closure captures the filters; the key names them. */
  fetchPage: (offset: number) => Promise<CrmListResponse<T>>
  columns: Column<T>[]
  empty: ReactNode
  /** What the rows are called in "Showing 25 of 340 tasks". */
  noun: string
}

export function RecordsTable<T extends { id: string }>({
  queryKey,
  fetchPage,
  columns,
  empty,
  noun,
}: RecordsTableProps<T>) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.items.length : undefined),
  })

  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total ?? 0

  if (query.isPending) {
    return (
      <div className="mt-4 space-y-2" data-testid="records-loading">
        <p className="sr-only" role="status">
          Loading {noun}
        </p>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-5/6" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div
        role="alert"
        className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
      >
        <span>{describeError(query.error)}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void query.refetch()}
          className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
        >
          Retry
        </Button>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
        {empty}
      </div>
    )
  }

  return (
    <div className="mt-4">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
              {columns.map((column) => (
                <th key={column.header} scope="col" className="px-3 py-2 font-medium">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                {columns.map((column) => (
                  <td key={column.header} className="px-3 py-2 align-top text-text-secondary">
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          Showing {rows.length} of {total} {noun}
        </p>
        {query.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
