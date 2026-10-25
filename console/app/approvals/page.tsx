import { ApprovalQueue } from '../../components/ApprovalQueue'

/**
 * The approval queue. §11.3.
 *
 * Reachable from the nav, which is the point: until now `ApprovalQueue` lived in
 * `src/console/components/` where no page imported it, so the governance surface
 * the plan keeps describing had no entry point at all.
 */
export default function ApprovalsPage() {
  return (
    <main>
      <ApprovalQueue />
    </main>
  )
}
