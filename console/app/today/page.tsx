import { redirect } from 'next/navigation'

/**
 * `/today` retires. §"Route map": "The standalone `/today` page retires and its
 * digest folds into Home."
 *
 * The digest still exists — it is `TodayCard` on `/`, reading the same
 * `/api/digest` endpoint through the same typed client. This route only
 * forwards, so bookmarks and the old rail link keep working.
 */
export default function TodayRedirect() {
  redirect('/')
}
