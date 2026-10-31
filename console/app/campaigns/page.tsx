import { CampaignMetricsDashboard } from '@/components/CampaignMetricsDashboard'


export default function CampaignsPage() {
  const tenantId = process.env.CRUM_DEV_TENANT_ID ?? ''

  if (!tenantId) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No tenant configured. Set CRUM_DEV_TENANT_ID in your environment.
        </div>
      </main>
    )
  }

  return <CampaignMetricsDashboard tenantId={tenantId} />
}
