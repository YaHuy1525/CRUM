/**
 * The five CRM objects the console browses, and the only list of them.
 * §"Route map": "CRM objects with sub-tabs: Customers, Contacts, Follow-ups,
 * Tasks, Schedules. Backed by new read only list endpoints."
 *
 * This lives outside `components/records/RecordsBrowser.tsx` on purpose. That
 * module is `'use client'`, and a server component that imports a value from it
 * receives a client reference instead of the value. `RECORD_OBJECTS.includes()`
 * type checked, then threw `includes is not a function` at request time, which
 * is how this file came to exist: `/records` rendered an error page while `tsc`
 * and the component tests stayed green, because the type of the import was
 * correct and only the value was missing. Types may cross the server and client
 * boundary, values do not.
 */
export const RECORD_TABS = [
  { key: 'customers', label: 'Customers', noun: 'customers' },
  { key: 'contacts', label: 'Contacts', noun: 'contacts' },
  { key: 'followups', label: 'Follow-ups', noun: 'follow-ups' },
  { key: 'tasks', label: 'Tasks', noun: 'tasks' },
  { key: 'schedules', label: 'Schedules', noun: 'schedules' },
] as const

export type RecordObject = (typeof RECORD_TABS)[number]['key']

export const RECORD_KEYS: readonly RecordObject[] = RECORD_TABS.map((tab) => tab.key)

export function isRecordObject(value: string | undefined): value is RecordObject {
  return value !== undefined && (RECORD_KEYS as readonly string[]).includes(value)
}
