'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  acknowledgeVideoAlert,
  describeError,
  dismissVideoAlert,
  listVideoAlerts,
  scanVideoAlerts,
} from '../lib/api'
import type { RevenueAlert, RevenueAlertSeverity, RevenueAlertStatus } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Label } from './ui/label'

// No-auto-send truth: detection only writes rows to this workspace. Nothing is
// emailed, messaged, or pushed anywhere — a human reads each alert and decides.

type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

function severityVariant(severity: RevenueAlertSeverity): 'secondary' | 'warning' | 'danger' {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'secondary'
}

function statusVariant(status: RevenueAlertStatus): 'warning' | 'success' | 'secondary' {
  if (status === 'open') return 'warning'
  if (status === 'acknowledged') return 'success'
  return 'secondary'
}

export function VideoAlerts() {
  const [status, setStatus] = useState<RevenueAlertStatus | ''>('open')
  const [alerts, setAlerts] = useState<RevenueAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const data = await listVideoAlerts({ status: status === '' ? undefined : status })
      setAlerts(data.alerts ?? [])
    } catch (err) {
      setListError(describeError(err))
      setAlerts([])
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  async function handleTransition(alert: RevenueAlert, action: 'acknowledge' | 'dismiss') {
    setNotice(null)
    setBusyId(alert.id)
    try {
      await (action === 'acknowledge'
        ? acknowledgeVideoAlert(alert.id)
        : dismissVideoAlert(alert.id))
      setNotice({
        kind: 'info',
        text: `Alert marked ${action === 'acknowledge' ? 'acknowledged' : 'dismissed'} — recorded in this workspace only; nothing was sent to anyone.`,
      })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setBusyId(null)
    }
  }

  async function handleScan() {
    setNotice(null)
    setScanning(true)
    try {
      const result = await scanVideoAlerts()
      setNotice({
        kind: 'ok',
        text: `Detection finished: ${result.created} created, ${result.skipped} skipped. Alerts are rows for you to review — nothing was sent.`,
      })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="mt-2 space-y-4">
      <p className="text-sm text-text-muted">
        Revenue anomalies and new sponsorship leads appear here for a human to review. The scan
        only writes rows — CRUM never sends anything on its own.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="alerts-status">Status</Label>
          <select
            id="alerts-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as RevenueAlertStatus | '')}
            aria-label="Status filter"
            className="focus-ring mt-1 h-9 rounded-md border border-border bg-bg-card px-2 text-sm text-text-primary"
          >
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </select>
        </div>
        <Button onClick={() => void handleScan()} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Run detection'}
        </Button>
      </div>

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

      {loading ? <p className="text-sm text-text-muted">Loading alerts…</p> : null}

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

      {!loading && !listError && alerts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No {status === '' ? '' : `${status} `}alerts right now.
        </div>
      ) : null}

      {alerts.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                <th scope="col" className="px-3 py-2 font-medium">Severity</th>
                <th scope="col" className="px-3 py-2 font-medium">Message</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Created</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary">{alert.kind}</td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={severityVariant(alert.severity)}>{alert.severity}</Badge>
                  </td>
                  <td className="px-3 py-2 align-top text-text-secondary">{alert.message}</td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={statusVariant(alert.status)}>{alert.status}</Badge>
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-text-muted">
                    {new Date(alert.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === alert.id || alert.status !== 'open'}
                        onClick={() => void handleTransition(alert, 'acknowledge')}
                      >
                        Acknowledge
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === alert.id || alert.status !== 'open'}
                        onClick={() => void handleTransition(alert, 'dismiss')}
                      >
                        Dismiss
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
