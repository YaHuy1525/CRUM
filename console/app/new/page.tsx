import { redirect } from 'next/navigation'

/**
 * `/new` moved to `/records/new` in the console IA redesign (§"Route map"). The
 * capture flow itself is unchanged — this route only forwards, so every old link
 * and bookmark keeps working.
 */
export default function NewRedirect() {
  redirect('/records/new')
}
