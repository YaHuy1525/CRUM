'use client'

import { useCallback, useEffect, useState } from 'react'

import { ApiError, del, get, post, describeError } from '../lib/api'
import type { KnowledgeDocument, UploadResponse } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'


type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

function statusVariant(status: KnowledgeDocument['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

export function KnowledgeManager() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [uploading, setUploading] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [contentType, setContentType] = useState<'text' | 'markdown' | 'html'>('text')

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const data = await get<{ documents: KnowledgeDocument[]; total: number }>('/api/knowledge/documents')
      setDocuments(data.documents ?? [])
    } catch (err) {
      setListError(describeError(err))
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setUploading(true)
    setNotice(null)
    try {
      const data = await post<UploadResponse>('/api/knowledge/upload', {
        title,
        content,
        contentType,
      })
      setNotice({
        kind: data.deduplicated ? 'info' : 'ok',
        text: data.deduplicated
          ? `Identical content is already indexed as ${data.documentId}; nothing was re-embedded.`
          : `Ingested ${data.title ?? data.documentId} as "${data.status}"${
              data.chunk_count != null ? ` (${data.chunk_count} chunks)` : ''
            }.`,
      })
      setTitle('')
      setContent('')
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(doc: KnowledgeDocument) {
    setNotice(null)
    if (!window.confirm(`Delete "${doc.title}"? Its chunks stay in the index until the next sweep.`)) return
    try {
      await del(`/api/knowledge/documents/${encodeURIComponent(doc.id)}`)
      setNotice({ kind: 'ok', text: `Deleted ${doc.title}.` })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    }
  }

  async function handleReingest(doc: KnowledgeDocument) {
    setNotice(null)
    try {
      await post(`/api/knowledge/documents/${encodeURIComponent(doc.id)}/reingest`)
      setNotice({ kind: 'ok', text: 'Re-ingest accepted.' })
      await load()
    } catch (err) {
      const detail = err instanceof ApiError ? (err.detail ?? err.code) : describeError(err)
      setNotice({ kind: 'info', text: `Re-ingest ${doc.title}: ${detail}` })
    }
  }

  return (
    <div className="mt-2 space-y-4">
      <p className="text-sm text-text-muted">
        Documents are chunked and embedded on upload, then retrieved for this tenant only. Text formats only — .txt, .md, .html, .json.
      </p>

      <form onSubmit={handleUpload} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-full max-w-sm">
            <Label htmlFor="knowledge-title">Document title</Label>
            <Input
              id="knowledge-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Return policy 2026"
              aria-label="Document title"
              required
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="knowledge-type">Content type</Label>
            <select
              id="knowledge-type"
              value={contentType}
              onChange={(e) => setContentType(e.target.value as typeof contentType)}
              aria-label="Content type"
              className="focus-ring mt-1 h-9 rounded-md border border-border bg-bg-card px-2 text-sm text-text-primary"
            >
              <option value="text">Plain text</option>
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
            </select>
          </div>
        </div>

        <div>
          <Label htmlFor="knowledge-content">Document content</Label>
          <Textarea
            id="knowledge-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Document content"
            rows={6}
            aria-label="Document content"
            required
            className="mt-1"
          />
        </div>

        <Button type="submit" disabled={uploading}>
          {uploading ? 'Uploading and indexing…' : 'Upload'}
        </Button>
      </form>

      {notice ? (
        <p
          role={notice.kind === 'bad' ? 'alert' : 'status'}
          className={
            notice.kind === 'bad'
              ? 'mt-4 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
              : notice.kind === 'ok'
                ? 'mt-4 rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
                : 'mt-4 rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-secondary'
          }
        >
          {notice.text}
        </p>
      ) : null}

      {loading ? <p className="mt-4 text-sm text-text-muted">Loading documents…</p> : null}

      {listError ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
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

      {!loading && !listError && documents.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No documents uploaded yet.
        </div>
      ) : null}

      {documents.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Title</th>
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Size</th>
                <th scope="col" className="px-3 py-2 font-medium">Updated</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top font-medium text-text-primary">{doc.title}</td>
                  <td className="px-3 py-2 align-top text-text-secondary">{doc.file_type}</td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={statusVariant(doc.status)}>{doc.status}</Badge>
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">
                    {doc.byte_size} bytes
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-text-muted">
                    {new Date(doc.updated_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => void handleReingest(doc)}>
                        Re-ingest
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void handleDelete(doc)}>
                        Delete
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
