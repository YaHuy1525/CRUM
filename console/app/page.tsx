'use client'

import { SessionList } from '../components/SessionList'
import { ChatPane } from '../components/ChatPane'
import { ObjectPanel } from '../components/ObjectPanel'

export default function Home() {
  return (
    <div className="container">
      <div className="pane">
        <div className="pane-header">Sessions</div>
        <SessionList />
      </div>
      <div className="pane chat-pane">
        <div className="pane-header">Chat</div>
        <ChatPane />
      </div>
      <div className="pane">
        <div className="pane-header">Context</div>
        <ObjectPanel />
      </div>
    </div>
  )
}
