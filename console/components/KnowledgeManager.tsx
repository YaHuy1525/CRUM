'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError, del, get, post, describeError } from '../lib/api'
import type { KnowledgeDocument, UploadResponse } from '../lib/types'

/**
 * Knowledge manager. §11.5, §6.4.
 *
 * Moved out of `src/console/components/` (where nothing imported it) and rewritten
 * against the routes as they now behave:
 *
 * - `POST /api/knowledge/upload` runs the ingest workflow, so a success says
 *   `status: 'ready'` with a `chunk_count`, an identical re-upload is reported as
 *   deduplicated rather than silently stored twice, and a router without the
 *   workflow answers 503 `ingest-not-wired` — which is relayed, not swallowed.
 * - `POST /api/knowledge/documents/:id/reingest` answers **409**. The table stores
 *   the content hash and never the content, so there is nothing to re-chunk. The
 *   old component fired the request, ignored the status, and refreshed the list as
 *   if it had worked. The button stays (it is the route's own answer that explains
 *   the limitation) and its response is shown verbatim.
 * - No `tenantId` prop: identity is attached server-side, and a prop for it would
 *   be a tenant selector in the browser (§13.2).
 */

type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

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
      // 415 (a PDF handed to the text path) and 503 (stored but not indexed) each
      // carry a sentence written for exactly this moment — show it.
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
    <div className="console-page">
      <h1>Knowledge</h1>
      <p className="lede">
        Documents are chunked and embedded on upload, then retrieved for this tenant only. Text formats
        only — .txt, .md, .html, .json.
      </p>

      <form onSubmit={handleUpload} className="console-form">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title"
          aria-label="Document title"
          required
          className="focus-ring"
        />
        <select
          value={contentType}
          onChange={(e) => setContentType(e.target.value as typeof contentType)}
          aria-label="Content type"
          className="focus-ring"
        >
          <option value="text">Plain text</option>
          <option value="markdown">Markdown</option>
          <option value="html">HTML</option>
        </select>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Document content"
          rows={6}
          aria-label="Document content"
          required
          className="focus-ring"
        />
        <button type="submit" disabled={uploading} className="focus-ring">
          {uploading ? 'Uploading and indexing…' : 'Upload'}
        </button>
      </form>

      {notice && (
        <div className={notice.kind === 'bad' ? 'error-banner' : 'hint'} role={notice.kind === 'bad' ? 'alert' : 'status'}>
          {notice.text}
        </div>
      )}

      {loading && <p>Loading documents…</p>}

      {listError && (
        <div className="error-banner" role="alert">
          {listError}
          <button onClick={() => void load()} className="focus-ring">
            Retry
          </button>
        </div>
      )}

      {!loading && !listError && documents.length === 0 && <p>No documents uploaded yet.</p>}

      {documents.length > 0 && (
        <table className="console-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Status</th>
              <th>Size</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.title}</td>
                <td>{doc.file_type}</td>
                <td>
                  <span className={`status-pill ${doc.status}`}>{doc.status}</span>
                </td>
                <td>{doc.byte_size} bytes</td>
                <td>{new Date(doc.updated_at).toLocaleString()}</td>
                <td>
                  <button onClick={() => void handleReingest(doc)} className="focus-ring">
                    Re-ingest
                  </button>
                  <button onClick={() => void handleDelete(doc)} className="focus-ring">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
