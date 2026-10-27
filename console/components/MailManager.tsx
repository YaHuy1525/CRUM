'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  createMailDraft,
  describeError,
  getMailConnectUrl,
  getMailStatus,
  searchMailThreads,
  ApiError,
} from '../lib/api'
import type { MailStatus, MailThreadSummary } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'


type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

const gmailThreadUrl = (id: string) => `https://mail.google.com/mail/#inbox/${encodeURIComponent(id)}`
const gmailDraftsUrl = 'https://mail.google.com/mail/#drafts'

export function MailManager() {
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)

  const [query, setQuery] = useState('in:inbox')
  const [threads, setThreads] = useState<MailThreadSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [draftTo, setDraftTo] = useState('')
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftSaving, setDraftSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    setStatusError(null)
    try {
      setStatus(await getMailStatus())
    } catch (err) {
      setStatus(null)
      setStatusError(describeError(err))
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  async function handleConnect() {
    setNotice(null)
    try {
      const { url } = await getMailConnectUrl()
      window.open(url, '_blank', 'noopener')
      setNotice({
        kind: 'info',
        text: 'Google consent opened in a new tab. Finish it there, then Refresh this page.',
      })
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    }
  }

  async function handleSearch(event: React.FormEvent) {
    event.preventDefault()
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError(null)
    try {
      const data = await searchMailThreads(q)
      setThreads(data.threads ?? [])
      setSearched(true)
    } catch (err) {
      setThreads([])
      setSearchError(err instanceof ApiError && err.code === 'reconnect_required'
        ? `${err.detail ?? 'Gmail link is dead.'} Reconnect below.`
        : describeError(err))
    } finally {
      setSearching(false)
    }
  }

  async function handleDraft(event: React.FormEvent) {
    event.preventDefault()
    setDraftSaving(true)
    setNotice(null)
    try {
      const data = await createMailDraft({ to: draftTo.trim(), subject: draftSubject.trim(), body: draftBody.trim() })
      setDraftTo('')
      setDraftSubject('')
      setDraftBody('')
      setNotice({ kind: 'ok', text: `Draft created (${data.draftId}) — review and send it from your Gmail drafts.` })
      window.open(data.url, '_blank', 'noopener')
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setDraftSaving(false)
    }
  }

  if (loadingStatus) {
    return <p className="mt-6 text-sm text-text-muted">Checking the mailbox…</p>
  }

  if (statusError) {
    return (
      <div role="alert" className="mt-6 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
        <p className="break-words">{statusError}</p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger"
          onClick={() => void loadStatus()}
        >
          Retry
        </Button>
      </div>
    )
  }

  if (status && !status.configured) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
        The Gmail connector is not configured on this server.
        {status.detail ? <p className="mt-2 font-mono text-xs">{status.detail}</p> : null}
      </div>
    )
  }

  if (status && !status.connected) {
    return (
      <div className="mt-6 space-y-4">
        <div className="rounded-lg border border-border bg-bg-card p-6">
          <h2 className="font-display text-lg text-text-primary">No mailbox linked</h2>
          <p className="mt-1 text-sm text-text-muted">
            Connect a Gmail account so the assistant can search it and keep drafts.
            Reading happens with the Gmail read-only scope; nothing is ever sent from here.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => void handleConnect()}>Connect Gmail</Button>
            <Button variant="outline" onClick={() => void loadStatus()}>Refresh</Button>
          </div>
          {notice ? <NoticeLine notice={notice} /> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="success">connected</Badge>
        <span className="text-sm text-text-secondary">{status?.email}</span>
        <a
          href="https://mail.google.com/mail/u/0/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-accent-bright hover:underline"
        >
          Open Gmail
        </a>
        <Button variant="ghost" size="sm" onClick={() => void handleConnect()}>
          Reconnect
        </Button>
      </div>

      <form onSubmit={(e) => void handleSearch(e)} className="flex flex-wrap items-center gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Gmail search query"
          placeholder="in:inbox, subject:invoice, from:customer@example.com"
          className="max-w-md font-mono text-xs"
        />
        <Button type="submit" disabled={searching || query.trim() === ''}>
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {searchError ? <NoticeLine notice={{ kind: 'bad', text: searchError }} /> : null}

      {searched && threads.length === 0 && !searchError ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No threads matched that search.
        </div>
      ) : null}

      {threads.length > 0 ? (
        <ul className="space-y-2">
          {threads.map((thread) => (
            <li key={thread.id} className="rounded-lg border border-border bg-bg-card px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-text-primary">{thread.subject || '(no subject)'}</p>
                <span className="shrink-0 text-xs text-text-muted">{thread.date || ''}</span>
              </div>
              <p className="mt-1 truncate text-xs text-text-muted">{thread.senders.join(', ')}</p>
              <p className="mt-2 text-sm text-text-secondary">{thread.snippet}</p>
              <a
                href={gmailThreadUrl(thread.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs text-accent-bright hover:underline"
              >
                Open in Gmail
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <section aria-labelledby="mail-draft-heading" className="rounded-lg border border-border bg-bg-raised p-4">
        <h2 id="mail-draft-heading" className="text-sm font-semibold text-text-primary">New draft</h2>
        <p className="mt-1 text-xs text-text-muted">
          Saves to the mailbox&apos;s Gmail drafts folder. It is never sent from here.
        </p>
        <form onSubmit={(e) => void handleDraft(e)} className="mt-3 space-y-3">
          <Input
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
            aria-label="Draft recipient"
            placeholder="recipient@example.com"
            required
          />
          <Input value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} aria-label="Draft subject" placeholder="Subject" />
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            aria-label="Draft body"
            placeholder="Write the draft…"
            required
            rows={4}
            className="focus-ring w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
          />
          <Button type="submit" disabled={draftSaving || draftTo.trim() === '' || draftBody.trim() === ''}>
            {draftSaving ? 'Saving draft…' : 'Create draft'}
          </Button>
        </form>
        {notice ? <NoticeLine notice={notice} /> : null}
      </section>
    </div>
  )
}

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p
      role={notice.kind === 'bad' ? 'alert' : 'status'}
      className={
        notice.kind === 'bad'
          ? 'mt-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
          : notice.kind === 'ok'
            ? 'mt-3 rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
            : 'mt-3 rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-secondary'
      }
    >
      {notice.text}
    </p>
  )
}
