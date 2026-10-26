import { redirect } from 'next/navigation'

export default async function CustomerRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/records/customers/${id}`)
}
