'use client'

import { useCallback, useEffect, useState } from 'react'

import { getReviewAnalytics } from '../lib/review'
import type { ReviewAnalytics as Analytics } from '../lib/review'
import { describeError } from '../lib/api'

function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'no data' : (value * 100).toFixed(1) + '%'
}

function hours(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'no corrections yet' : value.toFixed(1) + ' h'
}

function Bar({ value, max }: { value: number; max: number }) {
  const width = max <= 0 ? 0 : Math.round((value / max) * 100)
  return (
    <span className="inline-block h-2 align-middle bg-accent" data-testid="bar"
      style={{ width: width + '%', minWidth: value > 0 ? '2px' : '0' }} />
  )
}

export function ReviewAnalytics({ kind }: { kind: 'invoice' | 'contract' | null }) {
  // Constraint 6's frame rule (R45), browser side: the day the operator means by "today" is their
  // own local day. A `toISOString()` read here would show yesterday for the first 11 hours of every
  // day on this machine, and the default window would silently stop a day short. `defaultFrom` below
  // stays in UTC because it both builds and renders there, which is the pair rule, not a third frame.
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const [from, setFrom] = useState(defaultFrom(today))
  const [to, setTo] = useState(today)
  const [data, setData] = useState<Analytics | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    try {
      const query = '?from=' + from + '&to=' + to + (kind ? '&kind=' + kind : '')
      setData(await getReviewAnalytics(query))
    } catch (err) {
      setProblem(describeError(err))
      setData(null)
    } finally {
      setBusy(false)
    }
  }, [from, to, kind])

  useEffect(() => { void refresh() }, [refresh])

  const maxRule = data ? Math.max(0, ...data.byRule.map((r) => r.total)) : 0

  async function exportCsv() {
    setProblem(null)
    const query = 'from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + (kind ? '&kind=' + kind : '')
    const res = await fetch('/api/documents/audit/export?' + query, { headers: { Accept: 'text/csv' } })
    if (res.status === 204) { setProblem('Nothing in this window to export.'); return }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; max?: number } | null
      setProblem(body?.error === 'too_many_rows'
        ? 'Too many rows for one file (cap ' + body.max + '). Narrow the window.'
        : 'Export failed: ' + (body?.error ?? res.status))
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'field-audit-' + from + '-to-' + to + '.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-bg-card p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-text-muted">
          From
          <input className="ml-1 rounded border border-border bg-bg-raised px-2 py-1 text-sm"
            value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-text-muted">
          To
          <input className="ml-1 rounded border border-border bg-bg-raised px-2 py-1 text-sm"
            value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="text-xs underline" onClick={() => void refresh()} disabled={busy}>apply</button>
        <button type="button" className="text-xs underline" onClick={() => void exportCsv()}>export csv</button>
        {data ? <span className="text-xs text-text-muted">{data.window.from} to {data.window.to}</span> : null}
      </div>

      {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      {busy && !data ? <p className="text-sm text-text-muted">Loading review stats…</p> : null}

      {data ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">Findings by rule</caption>
                <tbody>
                  {data.byRule.map((r) => (
                    <tr key={r.ruleId}>
                      <td className="py-1">{r.ruleId}</td>
                      <td className="w-1/3 py-1"><Bar value={r.total} max={maxRule} /></td>
                      <td className="py-1 text-right tabular-nums">{r.total}</td>
                      <td className="py-1 text-right text-text-muted">open {r.open} · waived {r.waived}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">Most corrected fields</caption>
                <tbody>
                  {data.topFields.map((f) => (
                    <tr key={f.field}>
                      <td className="py-1">{f.field}</td>
                      <td className="py-1 text-right tabular-nums">{f.corrections}</td>
                      <td className="py-1 text-right text-text-muted">{f.violations} findings</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <dl className="grid gap-2 text-sm md:grid-cols-3">
            <div>
              <dt className="text-xs text-text-muted">Corrected in window</dt>
              <dd>{data.correctionRate.corrected} of {data.correctionRate.documents} corrected, {pct(data.correctionRate.rate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Created to first correction</dt>
              <dd>{hours(data.turnaround.p50Hours)} median, {hours(data.turnaround.p90Hours)} p90</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Changes by source</dt>
              <dd>{data.bySource.map((s) => s.changeSource + ' ' + s.count).join(' · ') || 'none'}</dd>
            </div>
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">By week</caption>
              <tbody>
                {data.confidenceTrend.map((w) => (
                  <tr key={w.week}>
                    <td className="py-1">{w.week}</td>
                    <td className="py-1 text-right tabular-nums">{w.avgConfidence === null ? 'no data' : (w.avgConfidence * 100).toFixed(0) + '%'}</td>
                    <td className="py-1 text-right text-text-muted">corrected (lifetime) {pct(w.correctionRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">By customer</caption>
                <tbody>
                  {(data.byCustomer?.length ?? 0) === 0 ? (
                    <tr><td className="py-1 text-text-muted">No data</td></tr>
                  ) : (
                    (data.byCustomer ?? []).map((c) => (
                      <tr key={c.customer}>
                        <td className="py-1">{c.customer}</td>
                        <td className="py-1 text-right tabular-nums">{c.documents} docs</td>
                        <td className="py-1 text-right text-text-muted">{c.documentsWithFindings} with findings</td>
                        <td className="py-1 text-right tabular-nums">{c.totalFindings} findings</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">By vendor</caption>
                <tbody>
                  {(data.byVendor?.length ?? 0) === 0 ? (
                    <tr><td className="py-1 text-text-muted">No data</td></tr>
                  ) : (
                    (data.byVendor ?? []).map((v) => (
                      <tr key={v.vendor}>
                        <td className="py-1">{v.vendor}</td>
                        <td className="py-1 text-right tabular-nums">{v.documents} docs</td>
                        <td className="py-1 text-right text-text-muted">{v.documentsWithFindings} with findings</td>
                        <td className="py-1 text-right tabular-nums">{v.totalFindings} findings</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left text-xs uppercase tracking-[0.06em] text-text-muted">Field correction heatmap</caption>
              <tbody>
                {(data.heatmap?.length ?? 0) === 0 ? (
                  <tr><td className="py-1 text-text-muted">No data</td></tr>
                ) : (
                  (() => {
                    const maxCorrections = Math.max(...(data.heatmap ?? []).map((x) => x.corrections))
                    return (data.heatmap ?? []).map((h) => {
                      const intensity = maxCorrections > 0 ? (h.corrections / maxCorrections) * 100 : 0
                      return (
                        <tr key={`${h.kind}-${h.field}`}>
                        <td className="py-1">{h.kind}</td>
                        <td className="py-1">{h.field}</td>
                        <td className="py-1">
                          <span
                            data-testid="heatmap-cell"
                            className="inline-block rounded px-2 py-1 text-right tabular-nums"
                            style={{
                              backgroundColor: `rgba(59, 130, 246, ${intensity / 100})`,
                              minWidth: '60px',
                            }}
                          >
                            {h.corrections}
                          </span>
                        </td>
                      </tr>
                    )
                  })
                  })()
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  )
}

function defaultFrom(today: string): string {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 89)
  return d.toISOString().slice(0, 10)
}
