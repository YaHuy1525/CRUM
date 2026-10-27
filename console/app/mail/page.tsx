import { MailManager } from '../../components/MailManager'
import { PageHeader } from '../../components/PageHeader'

export default function MailPage() {
  return (
    <main>
      <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8 md:py-10">
        <PageHeader
          title="Mailbox"
          description="Search the linked Gmail account and save drafts. Nothing here ever sends — outgoing mail stays approval-gated."
        />
        <MailManager />
      </div>
    </main>
  )
}
