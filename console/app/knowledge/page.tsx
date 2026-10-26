import { KnowledgeManager } from '../../components/KnowledgeManager'
import { DocumentManager } from '../../components/DocumentManager'
import { PageHeader } from '../../components/PageHeader'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'

export default function KnowledgePage() {
  return (
    <main>
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <PageHeader
          title="Knowledge base"
          description="Upload reference text for retrieval, or ingest invoice and contract documents into structured, queryable records."
        />

        <div className="mt-6">
          <Tabs defaultValue="knowledge">
            <TabsList aria-label="Knowledge base sections">
              <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="contracts">Contracts</TabsTrigger>
            </TabsList>

            <TabsContent value="knowledge">
              <KnowledgeManager />
            </TabsContent>

            <TabsContent value="invoices">
              <DocumentManager kind="invoice" />
            </TabsContent>

            <TabsContent value="contracts">
              <DocumentManager kind="contract" />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </main>
  )
}
