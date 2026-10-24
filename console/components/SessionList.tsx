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
    <ul className="session-list" role="listbox" aria-label="Conversation sessions">
      {sessions.length === 0 && (
        <li className="empty-state">No sessions yet</li>
      )}
      {sessions.map((session) => {
        const isActive = activeSession === session.threadId
        return (
          <li
            key={session.threadId}
            className={`session-item ${isActive ? 'active' : ''}`}
            role="option"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => setActiveSession(session.threadId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveSession(session.threadId)
              }
            }}
          >
            <div>{session.threadId}</div>
            <div style={{ fontSize: '12px', color: '#666' }}>
              {new Date(session.createdAt).toLocaleString()}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
