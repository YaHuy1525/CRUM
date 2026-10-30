'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  approveBillingInvoice,
  describeError,
  generateBillingInvoice,
  issueBillingInvoice,
  listBillingInvoices,
  voidBillingInvoice,
} from '../lib/api'
import type { BillingInvoice, InvoiceStatus } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'

// Billing money fields are numbers (the query layer coerces the decimals), so
// they are formatted here. An invoice walks draft -> approved -> issued by a
// human; CRUM never issues or delivers anything itself.

type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

function invoiceStatusVariant(status: InvoiceStatus): 'success' | 'warning' | 'danger' | 'secondary' {
  if (status === 'issued') return 'success'
  if (status === 'approved') return 'warning'
  if (status === 'void') return 'danger'
  return 'secondary'
}

function amount(value: number, currency: string): string {
  return `${value.toFixed(2)} ${currency}`
}

export function VideoBilling() {
  const [invoices, setInvoices] = useState<BillingInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [generating, setGenerating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [customerId, setCustomerId] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const data = await listBillingInvoices()
      setInvoices(data.invoices ?? [])
    } catch (err) {
      setListError(describeError(err))
      setInvoices([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleGenerate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setGenerating(true)
    setNotice(null)
    try {
      const { invoice } = await generateBillingInvoice({
        customerId: customerId.trim(),
        periodStart: periodStart.trim(),
        periodEnd: periodEnd.trim(),
      })
      setNotice({
        kind: 'ok',
        text: `Draft ${invoice.invoice_number ?? invoice.id} generated: ${amount(
          invoice.computed_amount,
          invoice.currency,
        )} (${invoice.status}). Nothing has been issued or sent yet.`,
      })
      setCustomerId('')
      setPeriodStart('')
      setPeriodEnd('')
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setGenerating(false)
    }
  }

  async function handleTransition(
    invoice: BillingInvoice,
    action: 'approve' | 'issue' | 'void',
  ) {
    setNotice(null)
    setBusyId(invoice.id)
    try {
      const run = { approve: approveBillingInvoice, issue: issueBillingInvoice, void: voidBillingInvoice }[action]
      await run(invoice.id)
      setNotice({
        kind: action === 'void' ? 'info' : 'ok',
        text: `Invoice ${invoice.invoice_number ?? invoice.id} is now ${action === 'issue' ? 'issued' : action}. Status change only — CRUM does not deliver or send the invoice.`,
      })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-2 space-y-4">
      <p className="text-sm text-text-muted">
        Invoices are computed from aggregated revenue and the customer&apos;s active fee profile.
        Each one stays a draft until a human approves and issues it — nothing is sent automatically.
      </p>

      <form onSubmit={handleGenerate} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-full max-w-sm">
            <Label htmlFor="billing-customer">Customer id</Label>
            <Input
              id="billing-customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="uuid of the customer"
              aria-label="Customer id"
              required
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="billing-period-start">Period start</Label>
            <Input
              id="billing-period-start"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              aria-label="Period start"
              required
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="billing-period-end">Period end</Label>
            <Input
              id="billing-period-end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              aria-label="Period end"
              required
              className="mt-1"
            />
          </div>
        </div>
        <Button type="submit" disabled={generating}>
          {generating ? 'Generating…' : 'Generate invoice'}
        </Button>
      </form>

      {notice ? (
        <p
          role={notice.kind === 'bad' ? 'alert' : 'status'}
          className={
            notice.kind === 'bad'
              ? 'rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
              : notice.kind === 'ok'
                ? 'rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
                : 'rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-secondary'
          }
        >
          {notice.text}
        </p>
      ) : null}

      {loading ? <p className="text-sm text-text-muted">Loading invoices…</p> : null}

      {listError ? (
        <div
          role="alert"
          className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <p className="break-words">{listError}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && !listError && invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No invoices yet. Generate one above once the customer has an active billing profile.
        </div>
      ) : null}

      {invoices.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Customer</th>
                <th scope="col" className="px-3 py-2 font-medium">Period</th>
                <th scope="col" className="px-3 py-2 font-medium">Amount</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Invoice #</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary" title={invoice.customer_id}>
                    {invoice.customer_id.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-text-secondary">
                    {invoice.period_start} → {invoice.period_end}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary">
                    {amount(invoice.computed_amount, invoice.currency)}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={invoiceStatusVariant(invoice.status)}>{invoice.status}</Badge>
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">
                    {invoice.invoice_number ?? '—'}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === invoice.id || invoice.status !== 'draft'}
                        onClick={() => void handleTransition(invoice, 'approve')}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === invoice.id || invoice.status !== 'approved'}
                        onClick={() => void handleTransition(invoice, 'issue')}
                      >
                        Issue
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === invoice.id || invoice.status === 'issued' || invoice.status === 'void'}
                        onClick={() => void handleTransition(invoice, 'void')}
                      >
                        Void
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
