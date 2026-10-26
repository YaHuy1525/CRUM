'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { post, describeError } from '@/lib/api'
import type { PrefillResponse } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'


const OBJECT_TYPES = ['customer', 'contact', 'schedule', 'task'] as const
type ObjectType = (typeof OBJECT_TYPES)[number]

function printable(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

function handoffPrompt(objectType: ObjectType, text: string, result: PrefillResponse): string {
  const lines = [`Create a ${objectType} from this note:`, '', text.trim()]
  if (!result.usedFallbackValue) {
    lines.push('', 'Parsed fields:')
    for (const [key, value] of Object.entries(result.data)) {
      lines.push(`- ${key}: ${printable(value)}`)
    }
  }
  return lines.join('\n')
}

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
  const prompt = result ? handoffPrompt(objectType, text, result) : ''

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-10">
      <PageHeader
        title="New from text"
        description="Paste whatever you have. The parser fills in the fields, and creating the record stays in the chat."
        actions={
          <Button variant="outline" asChild>
            <Link href="/records">All records</Link>
          </Button>
        }
      />

      <form onSubmit={parse} className="mt-6 space-y-4">
        <div>
          <Label htmlFor="object-type">Object type</Label>
          <select
            id="object-type"
            value={objectType}
            onChange={(e) => setObjectType(e.target.value as ObjectType)}
            className="focus-ring mt-1 h-9 w-44 rounded-md border border-border bg-bg-card px-2 text-sm text-text-primary capitalize"
          >
            {OBJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="source-text">Source text</Label>
          <Textarea
            id="source-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Maria Chen, Nordwind GmbH, wants a Q3 review. Enterprise plan."
            required
            className="mt-1"
          />
        </div>

        <Button type="submit" disabled={busy || text.trim().length === 0}>
          {busy ? 'Parsing…' : 'Parse fields'}
        </Button>
      </form>

      {error ? (
        <div
          role="alert"
          className="mt-6 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {error}
        </div>
      ) : null}

      {result ? (
        <section aria-labelledby="parsed-fields" className="mt-10">
          <h2 id="parsed-fields" className="font-display text-lg text-text-primary">
            Parsed {result.objectType} fields
          </h2>

          <p className="mt-1 text-sm text-text-muted">
            {result.usedFallbackValue
              ? `These are blank fallbacks — the structured parse did not produce a valid result${
                  result.error ? ` (${result.error})` : ''
                }. Fill them in by hand.`
              : 'Parsed from the text above.'}
          </p>

          <dl className="mt-4 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2 rounded-lg border border-border bg-bg-card p-4 text-sm">
            {fields.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-text-muted">{key}</dt>
                <dd className="text-text-primary">{printable(value)}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href={`/chats/new?prompt=${encodeURIComponent(prompt)}`}>
                Continue in chat
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </Button>
            <p className="text-sm text-text-muted">
              The chat stages the record and the approval queue commits it. That path is what signs
              the receipt.
            </p>
          </div>
        </section>
      ) : null}
    </main>
  )
}
