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
