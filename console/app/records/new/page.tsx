'use client'

import { useState } from 'react'
import { post, describeError } from '@/lib/api'
import type { PrefillResponse } from '@/lib/types'

/**
 * New record from pasted text. §4.4, §12.
 *
 * The route behind the button is `POST /api/crm/prefill/:objectType`: a small
 * structured-output agent turns "Maria at Nordwind, wants a Q3 review, tags she +
 * enterprise" into a field map. What this page deliberately does NOT do is create
 * the record. There is no un-governed CRM write endpoint in this build — creating a
 * row means the `crm-assistant` staging a draft and the approval queue committing it
 * (§12.1), so the honest last step here is to hand the parsed fields to the user and
 * tell them where the write actually happens. A "Create" button that POSTed straight
 * to the table would look like a finished feature and be a governance bypass.
 */

const OBJECT_TYPES = ['customer', 'contact', 'schedule', 'task'] as const
type ObjectType = (typeof OBJECT_TYPES)[number]

export default function NewPage() {
  const [objectType, setObjectType] = useState<ObjectType>('customer')
  const [text, setText] = useState('')
  const [result, setResult] = useState<PrefillResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function parse(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await post<PrefillResponse>(`/api/crm/prefill/${objectType}`, { text }))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const fields = result ? Object.entries(result.data) : []

  return (
    <main className="console-page">
      <h1>New from text</h1>
      <p className="lede">
        Paste whatever you have — an email, a call note, a sentence — and the parser fills in the
        fields for a {objectType}. Creating the record stays in the chat, where it can be staged and
        approved.
      </p>

      <form onSubmit={parse} className="console-form">
        <select
          value={objectType}
          onChange={(e) => setObjectType(e.target.value as ObjectType)}
          aria-label="Object type"
          className="focus-ring"
        >
          {OBJECT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="Maria Chen, Nordwind GmbH, wants a Q3 review. Enterprise plan."
          aria-label="Source text"
          required
          className="focus-ring"
        />

        <button type="submit" disabled={busy || text.trim().length === 0} className="focus-ring">
          {busy ? 'Parsing…' : 'Parse fields'}
        </button>
      </form>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {result && (
        <section aria-label="Parsed fields">
          <h2>Parsed {result.objectType} fields</h2>

          {/* `usedFallbackValue` is the difference between "the model read this" and
              "the model could not, so you are looking at empty defaults". Showing the
              fields without that would be a silent lie. */}
          {result.usedFallbackValue ? (
            <p className="hint bad">
              These are blank fallbacks — the structured parse did not produce a valid result
              {result.error ? ` (${result.error})` : ''}. Fill them in by hand.
            </p>
          ) : (
            <p className="hint ok">Parsed from the text above.</p>
          )}

          <dl className="field-grid">
            {fields.map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
              </div>
            ))}
          </dl>

          <p className="hint">
            To create it: open the chat, describe the same record, and approve the staged draft in the
            approval queue. That path is what signs the receipt.
          </p>
        </section>
      )}
    </main>
  )
}
