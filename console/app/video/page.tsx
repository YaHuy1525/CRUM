import { PageHeader } from '../../components/PageHeader'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { VideoOverview } from '../../components/VideoOverview'
import { VideoAlerts } from '../../components/VideoAlerts'
import { VideoBilling } from '../../components/VideoBilling'

export default function VideoPage() {
  return (
    <main>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
        <PageHeader
          title="Video revenue"
          description="Roll up platform earnings and confirmed sponsorship deals, review detected anomalies, and walk invoices from draft to issued. Everything here is read-and-decide: nothing is sent automatically."
        />

        <div className="mt-6">
          <Tabs defaultValue="overview">
            <TabsList aria-label="Video revenue sections">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="alerts">Alerts</TabsTrigger>
              <TabsTrigger value="billing">Billing</TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <VideoOverview />
            </TabsContent>

            <TabsContent value="alerts">
              <VideoAlerts />
            </TabsContent>

            <TabsContent value="billing">
              <VideoBilling />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </main>
  )
}
