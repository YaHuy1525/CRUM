'use client'

import { useState } from 'react'

import { FieldConfidenceChip } from './FieldConfidenceChip'
import { FindingList } from './FindingList'
import { patchContractField, patchInvoiceField } from '../lib/review'
import type { CorrectionResult, StoredViolation } from '../lib/review'
import { describeError } from '../lib/api'

const MIN_REASON = 8

export function EditableField({
  documentId,
  tableName,
  field,
  label,
  value,
  confidence,
  findings,
  requiredReason,
  onCorrected,
  onWaive,
}: {
  documentId: string
  tableName: 'invoices' | 'contracts'
  field: string
  label: string
  value: string
  confidence: number | null | undefined
  findings: readonly StoredViolation[]
  requiredReason: boolean
  onCorrected: (result: CorrectionResult) => Promise<void> | void
  onWaive?: (violationId: string, reason: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<CorrectionResult | null>(null)

  const start = () => {
    setDraft(value)
    setReason('')
    setProblem(null)
    setOutcome(null)
    setEditing(true)
  }

  async function save() {
    if (requiredReason && reason.trim().length < MIN_REASON) {
      setProblem('A reason is required for a field with an open error (at least 8 characters).')
      return
    }
    setSaving(true)
    setProblem(null)
    try {
      const patch = tableName === 'invoices' ? patchInvoiceField : patchContractField
      const result = await patch(documentId, field, draft, reason.trim() === '' ? undefined : reason.trim())
      setOutcome(result)
      setEditing(false)
      await onCorrected(result)
    } catch (err) {
      setProblem(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  const openErrors = outcome ? outcome.openErrors : 0
  const openWarnings = outcome ? outcome.openWarnings : 0

  return (
    <div className="border-b border-border py-1 text-sm last:border-0">
      <div className="flex items-center justify-between gap-4">
        <span className="text-text-muted">{label}</span>
        <span className="flex items-center gap-2 text-right text-text-primary">
          {!editing ? value : null}
          <FieldConfidenceChip value={confidence} />
          {!editing ? (
            <button type="button" className="text-xs underline text-text-muted" onClick={start}>
              edit
            </button>
          ) : null}
        </span>
      </div>

      {editing ? (
        <div className="mt-1 space-y-1">
          <label className="block text-xs text-text-muted">
            {label}
            <input
              className="mt-1 w-full rounded border border-border bg-bg-card px-2 py-1 text-sm text-text-primary"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <label className="block text-xs text-text-muted">
            Reason{requiredReason ? ' (required)' : ' (optional)'}
            <input
              className="mt-1 w-full rounded border border-border bg-bg-card px-2 py-1 text-sm text-text-primary"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button type="button" className="text-xs underline" onClick={() => { void save() }} disabled={saving}>
              {saving ? 'saving' : 'save'}
            </button>
            <button type="button" className="text-xs underline text-text-muted" onClick={() => setEditing(false)}>
              cancel
            </button>
          </div>
        </div>
      ) : null}

      {problem ? <p className="mt-1 text-xs text-danger">{problem}</p> : null}
      {outcome && !editing ? (
        <p className="mt-1 text-xs text-text-muted">
          {openErrors === 0 && openWarnings === 0
            ? 'correction saved, nothing left open'
            : `${openErrors} error${openErrors === 1 ? '' : 's'} and ${openWarnings} warning${openWarnings === 1 ? '' : 's'} still open`}
        </p>
      ) : null}

      {findings.length > 0 && onWaive ? <FindingList violations={findings} onWaive={onWaive} /> : null}
    </div>
  )
}
