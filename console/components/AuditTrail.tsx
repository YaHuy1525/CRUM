'use client'

import { cellText, shortTime } from '../lib/review'
import type { AuditRow } from '../lib/review'

const SOURCE_WORDS: Record<string, string> = {
  extraction: 'extraction',
  manual_correction: 'manual correction',
  're-parse': 're-parse',
  import: 'import',
  system: 'system',
}

export function AuditTrail({ rows, onReload }: { rows: readonly AuditRow[]; onReload: () => void }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.06em] text-text-muted">Field history</p>
        <button type="button" className="text-xs underline text-text-muted" onClick={onReload}>
          reload
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">No field changes recorded yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row, index) => (
            <li key={row.document_id + '-' + row.field_name + '-' + row.changed_at + '-' + index} className="text-xs">
              <span className="text-text-muted">{shortTime(row.changed_at)}</span>
              <span className="mx-1 font-semibold text-text-primary">{row.field_name}</span>
              {row.old_value === null || row.old_value === undefined ? null : (
                <span className="line-through text-text-muted">{cellText(row.old_value)} </span>
              )}
              <span className="text-text-primary">{cellText(row.new_value)}</span>
              <span className="ml-1 text-text-muted">{SOURCE_WORDS[row.change_source] ?? row.change_source}</span>
              {row.reason ? <span className="ml-1 text-text-primary">{row.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
