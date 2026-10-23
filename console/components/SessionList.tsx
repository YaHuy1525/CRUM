'use client'

import { useState, useEffect } from 'react'

interface Session {
  threadId: string
  resourceId: string
  createdAt: string
}

export function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)

  useEffect(() => {
    // Phase 1: mock data. Phase 2: fetch from API.
    const mockSessions: Session[] = [
      {
        threadId: 'thread-1',
        resourceId: 'user-1',
        createdAt: new Date().toISOString(),
      },
      {
        threadId: 'thread-2',
        resourceId: 'user-1',
        createdAt: new Date().toISOString(),
      },
    ]
    setSessions(mockSessions)
  }, [])

  return (
    <ul className="session-list">
      {sessions.length === 0 && (
        <li className="empty-state">No sessions yet</li>
      )}
      {sessions.map((session) => (
        <li
          key={session.threadId}
          className={`session-item ${activeSession === session.threadId ? 'active' : ''}`}
          onClick={() => setActiveSession(session.threadId)}
        >
          <div>{session.threadId}</div>
          <div style={{ fontSize: '12px', color: '#666' }}>
            {new Date(session.createdAt).toLocaleString()}
          </div>
        </li>
      ))}
    </ul>
  )
}
