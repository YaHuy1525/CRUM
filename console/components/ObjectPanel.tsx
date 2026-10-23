'use client'

export function ObjectPanel() {
  // Phase 1: empty. Phase 2: show bound object and context.
  return (
    <div className="object-panel">
      <h3>Active Object</h3>
      <div className="empty-state">No object bound</div>

      <h3 style={{ marginTop: '24px' }}>Working Memory</h3>
      <div className="empty-state">No facts noted</div>
    </div>
  )
}
