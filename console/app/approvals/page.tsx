import { redirect } from 'next/navigation'

/**
 * `/approvals` moved to `/governance` in the console IA redesign (§"Route map").
 * The approval queue is unchanged — this route only forwards, so existing links,
 * bookmarks, and the Home "Review approvals" launcher keep working.
 */
export default function ApprovalsRedirect() {
  redirect('/governance')
}
