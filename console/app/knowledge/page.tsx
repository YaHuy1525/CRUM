import { KnowledgeManager } from '../../components/KnowledgeManager'

/**
 * The knowledge base. §11.5.
 *
 * Same history as the approvals page: the component existed, nothing rendered it,
 * and its own upload button was pointing at a route that stored a row without ever
 * running the ingest workflow. Both halves are now real.
 */
export default function KnowledgePage() {
  return (
    <main>
      <KnowledgeManager />
    </main>
  )
}
