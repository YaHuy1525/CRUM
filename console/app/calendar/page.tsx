import { CalendarBoard } from '../../components/CalendarBoard'
import { PageHeader } from '../../components/PageHeader'

export default function CalendarPage() {
  return (
    <main>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8 md:py-10">
        <PageHeader
          title="Calendar"
          description="The week's customer meetings, coloured per customer. Meetings are booked through the agent and its approval gate — this board reads them."
        />
        <CalendarBoard />
      </div>
    </main>
  )
}
