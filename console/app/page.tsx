'use client'

import { useState } from 'react'
import { SessionList } from '../components/SessionList'
import { ChatPane } from '../components/ChatPane'
import { ObjectPanel, type Customer } from '../components/ObjectPanel'
import { ModeSwitch, type Mode } from '../components/ModeSwitch'

export default function Home() {
  const [boundCustomer, setBoundCustomer] = useState<Customer | null>(null)
  const [mode, setMode] = useState<Mode>('explore')

  return (
    <div className="container">
      <div className="pane">
        <div className="pane-header">Sessions</div>
        <SessionList />
      </div>
      <div className="pane chat-pane">
        <div className="pane-header">Chat</div>
        <ModeSwitch currentMode={mode} onModeChange={setMode} />
        <ChatPane />
      </div>
      <div className="pane">
        <div className="pane-header">Context</div>
        <ObjectPanel customer={boundCustomer} />
      </div>
    </div>
  )
}
