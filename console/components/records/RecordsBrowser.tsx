'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

import {
  listContacts,
  listCustomers,
  listFollowups,
  listSchedules,
  listTasks,
} from '@/lib/api'
import { RECORD_TABS as TABS, type RecordObject } from '@/lib/records'
import type { CrmContact, CrmFollowup, CrmSchedule, CrmTask, CustomerRow } from '@/lib/types'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  CONTACT_COLUMNS,
  CUSTOMER_COLUMNS,
  FOLLOWUP_COLUMNS,
  SCHEDULE_COLUMNS,
  TASK_COLUMNS,
} from './columns'
import { RECORDS_PAGE_SIZE, RecordsTable } from './RecordsTable'

/**
 * The `/records` browser. §"Route map": "CRM objects with sub-tabs: Customers,
 * Contacts, Follow-ups, Tasks, Schedules. Backed by new read only list
 * endpoints."
 *
 * Three decisions worth stating:
 *
 * 1. **Filters are per object, not global.** Customers and contacts filter by
 *    name, schedules by calendar date, and follow-ups and tasks have no filter at
 *    all — the plane only offers a parent-customer filter for those two, and a
 *    search box that silently did nothing would be worse than none. Their rows
 *    carry a customer link instead, which is the drill-down that exists.
 * 2. **Switching a tab clears the filters.** A name typed for customers would
 *    otherwise still be filtering contacts, and the empty result would look like a
 *    data problem rather than a leftover query.
 * 3. **Empty states are per entity and never generic.** "No tasks yet" and "No
 *    customers yet" are different facts, and only the customer one has a capture
 *    path to offer.
 *
 * The tab list itself lives in `lib/records.ts`, because this module is client
 * code and the server page has to validate `?object=` against the same keys.
 */

const FILTER_KIND: Partial<Record<RecordObject, 'name' | 'date'>> = {
  customers: 'name',
  contacts: 'name',
  schedules: 'date',
}

function CaptureLink() {
  return (
    <Link href="/records/new" className="text-accent-bright underline-offset-4 hover:underline">
      Capture one from text
    </Link>
  )
}

export function RecordsBrowser({ initialObject = 'customers' }: { initialObject?: RecordObject }) {
  const [tab, setTab] = useState<RecordObject>(initialObject)
  const [name, setName] = useState('')
  const [debouncedName, setDebouncedName] = useState('')
  const [date, setDate] = useState('')

  // Same 300ms debounce the conversation search uses: one read per pause, not one
  // per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedName(name.trim()), 300)
    return () => clearTimeout(handle)
  }, [name])

  const select = (next: string) => {
    setTab(next as RecordObject)
    setName('')
    setDebouncedName('')
    setDate('')
  }

  const filterKind = FILTER_KIND[tab]
  const noun = TABS.find((entry) => entry.key === tab)?.noun ?? tab
  const nameFilter = debouncedName.length > 0 ? debouncedName : undefined
  const dateFilter = date.length > 0 ? date : undefined

  return (
    <div className="mt-6">
      <Tabs value={tab} onValueChange={select}>
        <TabsList aria-label="Record types">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.key} value={entry.key}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {filterKind === 'name' ? (
          <div className="w-full max-w-xs">
            <label htmlFor="records-name" className="mb-1 block text-xs text-text-muted">
              Filter by name
            </label>
            <Input
              id="records-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tab === 'customers' ? 'Nordwind' : 'Maria'}
            />
          </div>
        ) : null}

        {filterKind === 'date' ? (
          <div>
            <label htmlFor="records-date" className="mb-1 block text-xs text-text-muted">
              Filter by date
            </label>
            <Input
              id="records-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
          </div>
        ) : null}

        {filterKind === undefined ? (
          <p className="text-xs text-text-muted">
            Listed tenant-wide. Open a customer to see its own {noun}.
          </p>
        ) : null}
      </div>

      {tab === 'customers' ? (
        <RecordsTable<CustomerRow>
          queryKey={['records', 'customers', nameFilter]}
          fetchPage={(offset) =>
            listCustomers({ limit: RECORDS_PAGE_SIZE, offset, name: nameFilter })
          }
          columns={CUSTOMER_COLUMNS}
          noun="customers"
          empty={
            <p>
              No customers yet. <CaptureLink />, or ask the assistant to stage one for approval.
            </p>
          }
        />
      ) : null}

      {tab === 'contacts' ? (
        <RecordsTable<CrmContact>
          queryKey={['records', 'contacts', nameFilter]}
          fetchPage={(offset) =>
            listContacts({ limit: RECORDS_PAGE_SIZE, offset, name: nameFilter })
          }
          columns={CONTACT_COLUMNS}
          noun="contacts"
          empty={<p>No contacts match this view. Contacts are created as children of a customer.</p>}
        />
      ) : null}

      {tab === 'followups' ? (
        <RecordsTable<CrmFollowup>
          queryKey={['records', 'followups']}
          fetchPage={(offset) => listFollowups({ limit: RECORDS_PAGE_SIZE, offset })}
          columns={FOLLOWUP_COLUMNS}
          noun="follow-ups"
          empty={<p>No follow-ups on record yet.</p>}
        />
      ) : null}

      {tab === 'tasks' ? (
        <RecordsTable<CrmTask>
          queryKey={['records', 'tasks']}
          fetchPage={(offset) => listTasks({ limit: RECORDS_PAGE_SIZE, offset })}
          columns={TASK_COLUMNS}
          noun="tasks"
          empty={<p>No tasks yet. The assistant stages them, and the queue commits them.</p>}
        />
      ) : null}

      {tab === 'schedules' ? (
        <RecordsTable<CrmSchedule>
          queryKey={['records', 'schedules', dateFilter]}
          fetchPage={(offset) =>
            listSchedules({ limit: RECORDS_PAGE_SIZE, offset, date: dateFilter })
          }
          columns={SCHEDULE_COLUMNS}
          noun="schedules"
          empty={
            <p>
              {dateFilter
                ? `Nothing scheduled on ${dateFilter}.`
                : 'No schedules on record yet.'}
            </p>
          }
        />
      ) : null}
    </div>
  )
}
