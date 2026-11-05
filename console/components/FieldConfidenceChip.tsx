'use client'

import { REVIEW_CONFIDENCE_FLOOR } from '../lib/review'

export function FieldConfidenceChip({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="text-xs text-text-muted" data-testid="confidence-chip">no score</span>
  }
  const tone =
    value < REVIEW_CONFIDENCE_FLOOR ? 'text-danger' : value < 0.9 ? 'text-warning' : 'text-success'
  return (
    <span
      className={'text-xs tabular-nums ' + tone}
      data-testid="confidence-chip"
      title={'field confidence ' + value.toFixed(3)}
    >
      {Math.round(value * 100)}%
    </span>
  )
}
