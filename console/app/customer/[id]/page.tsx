import { redirect } from 'next/navigation'

/**
 * `/customer/[id]` moved to `/records/customers/[id]` in the console IA redesign
 * (§"Route map"). The detail view is unchanged — this route only forwards,
 * carrying the id so deep links and bookmarks keep resolving to the same record.
 */
export default async function CustomerRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/records/customers/${id}`)
}
