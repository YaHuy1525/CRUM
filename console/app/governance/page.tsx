import { ApprovalQueue } from '@/components/ApprovalQueue'

/**
 * Governance: the approval queue and its receipts. §"Route map" — this replaces
 * `/approvals`, which now redirects here. Same component, same behavior; only the
 * route moved so the governance surface has a name that matches the sidebar.
 */
export default function GovernancePage() {
  return (
    <main>
      <ApprovalQueue />
    </main>
  )
}
