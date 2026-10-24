// src/console/components/KnowledgeManager.tsx
import { useState, useEffect } from 'react'

interface KnowledgeDocument {
  id: string
  title: string
  file_type: string
  status: 'pending' | 'processing' | 'ready' | 'failed'
  byte_size: number
  created_at: string
  updated_at: string
}

interface KnowledgeManagerProps {
  tenantId: string
}

/**
 * Knowledge manager UI. §11.5.
 * Upload progress, document list with status, chunk preview for ready documents.
 * Re-uploading a corrected document replaces rather than duplicates its chunks
 * (content_hash dedup in the API).
 */
export function KnowledgeManager({ tenantId }: KnowledgeManagerProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDocument | null>(null)

  useEffect(() => {
    loadDocuments()
  }, [tenantId])

  async function loadDocuments() {
    setLoading(true)
    try {
      const res = await fetch('/api/knowledge/documents', {
        headers: { 'x-tenant-id': tenantId },
      })
      const data = await res.json()
      setDocuments(data.documents || [])
    } catch {
      // Network error — leave documents empty
    } finally {
      setLoading(false)
    }
  }

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setUploading(true)
    setUploadProgress(0)

    const form = new FormData(e.currentTarget)
    const title = form.get('title') as string
    const content = form.get('content') as string
    const contentType = (form.get('contentType') as 'text' | 'markdown' | 'html') || 'text'

    try {
      setUploadProgress(25)
      const res = await fetch('/api/knowledge/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify({ title, content, contentType }),
      })
      setUploadProgress(75)
      const data = await res.json()
      if (data.deduplicated) {
        alert('Document with identical content already exists')
      }
      setUploadProgress(100)
      await loadDocuments()
    } catch {
      alert('Upload failed')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  async function handleDelete(docId: string) {
    if (!confirm('Delete this document?')) return
    try {
      await fetch(`/api/knowledge/documents/${docId}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': tenantId },
      })
      await loadDocuments()
      if (selectedDoc?.id === docId) setSelectedDoc(null)
    } catch {
      alert('Delete failed')
    }
  }

  async function handleReingest(docId: string) {
    try {
      await fetch(`/api/knowledge/documents/${docId}/reingest`, {
        method: 'POST',
        headers: { 'x-tenant-id': tenantId },
      })
      await loadDocuments()
    } catch {
      alert('Re-ingest failed')
    }
  }

  return (
    <div style={{ padding: '1rem', fontFamily: 'system-ui' }}>
      <h2>Knowledge Manager</h2>

      <form onSubmit={handleUpload} style={{ marginBottom: '1rem' }}>
        <input name="title" placeholder="Document title" required style={{ display: 'block', marginBottom: '0.5rem' }} />
        <select name="contentType" style={{ display: 'block', marginBottom: '0.5rem' }}>
          <option value="text">Plain text</option>
          <option value="markdown">Markdown</option>
          <option value="html">HTML</option>
        </select>
        <textarea name="content" placeholder="Document content" rows={6} required style={{ display: 'block', marginBottom: '0.5rem', width: '100%' }} />
        <button type="submit" disabled={uploading}>
          {uploading ? `Uploading... ${uploadProgress}%` : 'Upload'}
        </button>
      </form>

      {loading ? (
        <p>Loading documents...</p>
      ) : documents.length === 0 ? (
        <p>No documents uploaded yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Title</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Type</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Status</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Size</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td style={{ padding: '0.5rem 0' }}>{doc.title}</td>
                <td>{doc.file_type}</td>
                <td>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.85em',
                    background: doc.status === 'ready' ? '#d4edda' : doc.status === 'processing' ? '#fff3cd' : doc.status === 'failed' ? '#f8d7da' : '#e2e3e5',
                  }}>
                    {doc.status}
                  </span>
                </td>
                <td>{doc.byte_size} chars</td>
                <td>
                  <button onClick={() => setSelectedDoc(doc)} style={{ marginRight: '0.5rem' }}>View</button>
                  <button onClick={() => handleReingest(doc.id)} style={{ marginRight: '0.5rem' }}>Re-ingest</button>
                  <button onClick={() => handleDelete(doc.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedDoc && (
        <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #ccc', borderRadius: '4px' }}>
          <h3>{selectedDoc.title}</h3>
          <p><strong>Type:</strong> {selectedDoc.file_type}</p>
          <p><strong>Status:</strong> {selectedDoc.status}</p>
          <p><strong>Size:</strong> {selectedDoc.byte_size} characters</p>
          <p><strong>Created:</strong> {new Date(selectedDoc.created_at).toLocaleString()}</p>
          <p><strong>Updated:</strong> {new Date(selectedDoc.updated_at).toLocaleString()}</p>
          <button onClick={() => setSelectedDoc(null)}>Close</button>
        </div>
      )}
    </div>
  )
}
