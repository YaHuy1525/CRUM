# Phase 7 — Autonomy and Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire signal-based session control (interrupt/rebind/correct), add one narrow autonomous goal with a hard run budget, bring the console to WCAG 2.2 AA, load-test the hot paths, and ship a health endpoint plus runbook.

**Architecture:** Signals flow through the existing Agent Controller session — `abort()` for interrupt, `steer()` for correction, `sendSignal()` with a rebind payload for object-binding changes. The goal uses `setObjective` on the crm-assistant agent with `maxRuns: 12`, restricted to explore + auto-class tools. The console gets CSS custom properties matching the spec's token table, ARIA attributes on interactive elements, and a focus-ring utility class. The health endpoint is a Hono route that probes each dependency and returns per-service status. Load tests use `autocannon` against the session list and retrieval tool paths.

**Tech Stack:** TypeScript 5.9.3, `@mastra/core` 1.79.0, Hono, Next.js (console), Vitest 3, autocannon, axe-core (via `@axe-core/playwright`).

**Spec:** [`docs/TECHNICAL_PLAN.md`](../../TECHNICAL_PLAN.md) v0.3.0, §4.7 (signals/goals), §8.6–8.7 (alerting/health), §11.1.2–11.1.4 (accessibility), §16 Phase 7 checklist.

## Global Constraints

- **Versions are pinned exactly, never with a caret.** `@mastra/core@1.79.0`, `@mastra/mcp@2.5.0`, `@mastra/memory@1.39.0`, `@mastra/pg@1.32.0`, `typescript@5.9.3`, `zod@4.6.7`, `vitest@3.2.7`.
- **Node floor is 22.18.0.** Asserted in `engines`, in CI, and in the devcontainer.
- **Relative imports are extensionless.** `moduleResolution: "bundler"` plus `mastra build` bundling plus Vitest resolution all agree on extensionless.
- **Every table carries a non-nullable `tenant_id`.** No exceptions (§9.2).
- **Secrets are names, never values.** No `.env` value is read into a document, a commit, a log line or a browser bundle.
- **Fail open to safe, fail closed on identity.** A missing model key disables a guardrail with a boot warning. A missing tenant claim returns an error result, never an empty list that looks like success.
- **Goals restricted to explore + auto-class tools only.** Anything needing an approval-class tool is out of scope for goals. Hard `maxRuns` budget.
- **WCAG 2.2 AA minimum.** Contrast ratios per §11.1.2 table. Focus ring 2px accent offset 2px. Risk badges need numeric label, never colour alone.

---

### Task 1: Signal API — interrupt, rebind, correct

**Files:**
- Create: `src/api/signals.ts`
- Create: `tests/api/signals.test.ts`
- Modify: `src/api/index.ts` (register signals router)

**Interfaces:**
- Consumes: `AgentControllerSession` from `@mastra/core/agent-controller` — `abort()`, `steer()`, `sendSignal()`, `queueMessage()`
- Produces: Hono router with three POST endpoints: `/api/signals/interrupt`, `/api/signals/rebind`, `/api/signals/correct`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/api/signals.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('POST /api/signals/interrupt', () => {
  it('requires x-tenant-id header', async () => {
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/interrupt', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('calls session.abort() and returns 200', async () => {
    const abort = vi.fn()
    vi.doMock('../../src/mastra/sessions', () => ({
      resolveSession: () => ({ session: { abort } }),
    }))
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/interrupt', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1' },
    })
    expect(res.status).toBe(200)
    expect(abort).toHaveBeenCalled()
  })
})

describe('POST /api/signals/correct', () => {
  it('requires content in body', async () => {
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/correct', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('calls session.steer() with content', async () => {
    const steer = vi.fn()
    vi.doMock('../../src/mastra/sessions', () => ({
      resolveSession: () => ({ session: { steer } }),
    }))
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/correct', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'no, the other one' }),
    })
    expect(res.status).toBe(200)
    expect(steer).toHaveBeenCalledWith({ content: 'no, the other one' })
  })
})

describe('POST /api/signals/rebind', () => {
  it('calls session.sendSignal() with objectBinding', async () => {
    const sendSignal = vi.fn()
    vi.doMock('../../src/mastra/sessions', () => ({
      resolveSession: () => ({ session: { sendSignal } }),
    }))
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/rebind', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectType: 'customer', objectId: 'cust_1' }),
    })
    expect(res.status).toBe(200)
    expect(sendSignal).toHaveBeenCalled()
    const signalArg = sendSignal.mock.calls[0][0]
    expect(signalArg.type).toBe('state')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api/signals.test.ts`
Expected: FAIL — `src/api/signals.ts` does not exist.

- [ ] **Step 3: Implement the signals router**

```typescript
// src/api/signals.ts
import { Hono } from 'hono'
import { resolveSession } from '../mastra/sessions'

export function createSignalsRouter(): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) return c.json({ error: 'x-tenant-id header required' }, 400)
    c.set('tenantId', tenantId)
    await next()
  })

  app.post('/interrupt', async (c) => {
    const sessionId = c.req.header('x-session-id')
    if (!sessionId) return c.json({ error: 'x-session-id header required' }, 400)
    const { session } = resolveSession({ sessionId, tenantId: c.get('tenantId') })
    session.abort()
    return c.json({ ok: true })
  })

  app.post('/correct', async (c) => {
    const sessionId = c.req.header('x-session-id')
    if (!sessionId) return c.json({ error: 'x-session-id header required' }, 400)
    const body = await c.req.json()
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400)
    }
    const { session } = resolveSession({ sessionId, tenantId: c.get('tenantId') })
    await session.steer({ content: body.content })
    return c.json({ ok: true })
  })

  app.post('/rebind', async (c) => {
    const sessionId = c.req.header('x-session-id')
    if (!sessionId) return c.json({ error: 'x-session-id header required' }, 400)
    const body = await c.req.json()
    if (!body.objectType || !body.objectId) {
      return c.json({ error: 'objectType and objectId are required' }, 400)
    }
    const { session } = resolveSession({ sessionId, tenantId: c.get('tenantId') })
    await session.sendSignal({
      type: 'state',
      contents: JSON.stringify({ objectBinding: { type: body.objectType, id: body.objectId } }),
    })
    return c.json({ ok: true })
  })

  return app
}
```

- [ ] **Step 4: Register the router in the API index**

Add to `src/api/index.ts`:

```typescript
import { createSignalsRouter } from './signals'
// ... in the app setup:
app.route('/api/signals', createSignalsRouter())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/api/signals.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/signals.ts tests/api/signals.test.ts src/api/index.ts
git commit -m "feat(signals): add interrupt, correct, and rebind API endpoints

Wires session.abort(), session.steer(), and session.sendSignal() behind
three POST endpoints. Each requires x-tenant-id and x-session-id headers.
Implements TECHNICAL_PLAN.md §4.7.1."
```

---

### Task 2: Goal — approval-free inbox clearing with hard maxRuns

**Files:**
- Create: `src/mastra/goals.ts`
- Create: `tests/mastra/goals.test.ts`
- Modify: `src/mastra/agent.ts` (add `goal` config)

**Interfaces:**
- Consumes: `crmAssistant` from `src/mastra/agent.ts`, `DECISION_MODEL` from `src/mastra/decision-model.ts`
- Produces: `configureGoal(agent, options)` helper, `startInboxClearingGoal(threadId, resourceId)` function

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mastra/goals.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('startInboxClearingGoal', () => {
  it('calls setObjective with maxRuns 12 and judge model', async () => {
    const setObjective = vi.fn().mockResolvedValue({ id: 'goal-1', status: 'active' })
    const mockAgent = { setObjective }

    const { startInboxClearingGoal } = await import('../../src/mastra/goals')
    await startInboxClearingGoal(mockAgent as any, {
      threadId: 'thread-1',
      resourceId: 'tenant_1:user_1',
    })

    expect(setObjective).toHaveBeenCalledOnce()
    const [objective, opts] = setObjective.mock.calls[0]
    expect(objective).toContain('approval-free')
    expect(opts.maxRuns).toBe(12)
    expect(opts.threadId).toBe('thread-1')
    expect(opts.resourceId).toBe('tenant_1:user_1')
    expect(opts.judgeModelId).toBeDefined()
  })

  it('objective text mentions inbox clearing scope', async () => {
    const setObjective = vi.fn().mockResolvedValue({ id: 'goal-1', status: 'active' })
    const mockAgent = { setObjective }

    const { startInboxClearingGoal } = await import('../../src/mastra/goals')
    await startInboxClearingGoal(mockAgent as any, {
      threadId: 'thread-1',
      resourceId: 'tenant_1:user_1',
    })

    const [objective] = setObjective.mock.calls[0]
    expect(objective).toMatch(/followup|inbox|clear/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mastra/goals.test.ts`
Expected: FAIL — `src/mastra/goals.ts` does not exist.

- [ ] **Step 3: Implement the goal helper**

```typescript
// src/mastra/goals.ts
import type { Agent } from '@mastra/core/agent'
import { DECISION_MODEL } from './decision-model'

const INBOX_CLEARING_OBJECTIVE = `Clear the user's approval-free inbox: for every customer contacted in the last 7 days, check whether a followup has been logged. If not, log one using crm.log_followup (an auto-class tool). Do not create customers, send emails, or call any approval-class tool. Stop when every contacted customer has a followup or the budget is exhausted.`

export async function startInboxClearingGoal(
  agent: Agent,
  options: { threadId: string; resourceId: string },
) {
  return agent.setObjective(INBOX_CLEARING_OBJECTIVE, {
    threadId: options.threadId,
    resourceId: options.resourceId,
    judgeModelId: DECISION_MODEL,
    maxRuns: 12,
  })
}
```

- [ ] **Step 4: Add goal config to the agent**

In `src/mastra/agent.ts`, add to the `new Agent({...})` config:

```typescript
goal: {
  judgeModelId: DECISION_MODEL,
  maxRuns: 12,
},
```

Import `DECISION_MODEL` from `./decision-model`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mastra/goals.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/goals.ts tests/mastra/goals.test.ts src/mastra/agent.ts
git commit -m "feat(goals): add inbox-clearing goal with hard maxRuns budget

Restricted to auto-class tools (log_followup). Judge model evaluates
completion each iteration. Budget exhaustion pauses with persisted reason.
Implements TECHNICAL_PLAN.md §4.7.3."
```

---

### Task 3: Accessibility — theme tokens and CSS custom properties

**Files:**
- Modify: `console/app/globals.css`
- Create: `console/app/theme.css`

**Interfaces:**
- Consumes: §11.1.2 contrast ratio table, §11.1.3 component rules
- Produces: CSS custom properties for all design tokens

- [ ] **Step 1: Create theme.css with spec tokens**

```css
/* console/app/theme.css — TECHNICAL_PLAN.md §11.1 */
:root {
  /* Palette */
  --crum-white: #ffffff;
  --crum-black-900: #1a1a1a;
  --crum-black-950: #0d0d0d;
  --crum-green-500: #22c55e;
  --crum-green-600: #16a34a;

  /* Semantic tokens — dark mode default */
  --bg-base: var(--crum-black-950);
  --bg-card: var(--crum-black-900);
  --bg-raised: #242424;
  --text-primary: var(--crum-white);
  --text-muted: rgba(255, 255, 255, 0.48);
  --text-secondary: rgba(255, 255, 255, 0.72);
  --accent: var(--crum-green-500);
  --accent-fg: var(--crum-black-950);
  --border: rgba(255, 255, 255, 0.12);
  --border-strong: rgba(255, 255, 255, 0.24);
  --state-danger: #ef4444;
  --state-warning: #f59e0b;
  --state-success: var(--crum-green-500);

  /* Typography — §11.1.4 */
  --text-base: 14px;
  --text-xs: 12px;
  --text-sm: 13px;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  --line-height-prose: 1.5;
  --line-height-table: 1.35;

  /* Spacing */
  --radius-md: 6px;
  --radius-lg: 10px;
}

/* Light mode — §11.1.2: green-500 fails AA on white (3.0:1), use green-600 */
@media (prefers-color-scheme: light) {
  :root {
    --bg-base: #ffffff;
    --bg-card: #f8f8f8;
    --bg-raised: #f0f0f0;
    --text-primary: var(--crum-black-950);
    --text-muted: rgba(0, 0, 0, 0.48);
    --text-secondary: rgba(0, 0, 0, 0.72);
    --accent: var(--crum-green-600);
    --accent-fg: var(--crum-white);
    --border: rgba(0, 0, 0, 0.12);
    --border-strong: rgba(0, 0, 0, 0.24);
  }
}

/* Focus ring — §11.1.3: 2px accent offset 2px, always visible */
.focus-ring:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Update globals.css to import theme and use tokens**

Replace hardcoded colors in `console/app/globals.css`:

```css
@import './theme.css';

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
  font-size: var(--text-base);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  background: var(--bg-base);
  color: var(--text-primary);
  line-height: var(--line-height-prose);
}

.container {
  display: grid;
  grid-template-columns: 250px 1fr 300px;
  height: 100vh;
  gap: 1px;
  background: var(--border);
}

.pane {
  background: var(--bg-card);
  overflow-y: auto;
}

.pane-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: var(--text-base);
}

.session-list {
  list-style: none;
}

.session-item {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}

.session-item:hover {
  background: var(--bg-raised);
}

.session-item.active {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.message {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  max-width: 80%;
}

.message.user {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  margin-left: auto;
}

.message.assistant {
  background: var(--bg-raised);
}
```

- [ ] **Step 3: Commit**

```bash
git add console/app/theme.css console/app/globals.css
git commit -m "feat(console): add theme tokens per §11.1, replace hardcoded colours

CSS custom properties for palette, semantic tokens, typography.
Dark mode default, light mode via prefers-color-scheme.
green-600 used as accent in light mode (green-500 fails AA on white).
Focus ring utility class: 2px accent offset 2px."
```

---

### Task 4: Accessibility — ARIA attributes on interactive elements

**Files:**
- Modify: `console/components/SessionList.tsx`
- Modify: `console/components/ChatPane.tsx`
- Modify: `console/components/ObjectPanel.tsx`
- Modify: `console/components/ModeSwitch.tsx`
- Modify: `console/app/layout.tsx`

**Interfaces:**
- Consumes: `.focus-ring` class from `theme.css`
- Produces: ARIA roles, labels, live regions on all interactive components

- [ ] **Step 1: Add ARIA to SessionList**

In `console/components/SessionList.tsx`:

```tsx
// Add to the <ul>:
<ul className="session-list" role="listbox" aria-label="Conversation sessions">

// Add to each <li>:
<li
  className={`session-item ${isActive ? 'active' : ''}`}
  role="option"
  aria-selected={isActive}
  tabIndex={0}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
>
```

- [ ] **Step 2: Add ARIA to ChatPane**

In `console/components/ChatPane.tsx`:

```tsx
// Messages container:
<div className="messages" role="log" aria-live="polite" aria-label="Conversation messages">

// Input:
<textarea
  aria-label="Message input"
  placeholder="Type a message..."
  className="focus-ring"
/>

// Send button:
<button
  className="focus-ring"
  aria-label="Send message"
>
```

- [ ] **Step 3: Add ARIA to ObjectPanel**

In `console/components/ObjectPanel.tsx`:

```tsx
<aside className="pane object-panel" aria-label="Object details">
```

- [ ] **Step 4: Add ARIA to layout nav**

In `console/app/layout.tsx`:

```tsx
<nav className="top-nav" aria-label="Main navigation">
  <span className="brand">CRUM</span>
  <Link href="/" aria-current={pathname === '/' ? 'page' : undefined}>Home</Link>
  <Link href="/usage" aria-current={pathname === '/usage' ? 'page' : undefined}>Usage</Link>
  <Link href="/today" aria-current={pathname === '/today' ? 'page' : undefined}>Today</Link>
</nav>
```

- [ ] **Step 5: Add ARIA to ModeSwitch**

In `console/components/ModeSwitch.tsx`:

```tsx
<div role="radiogroup" aria-label="Agent mode">
  {modes.map(mode => (
    <button
      key={mode}
      role="radio"
      aria-checked={currentMode === mode}
      className={`focus-ring ${currentMode === mode ? 'active' : ''}`}
      onClick={() => setMode(mode)}
    >
      {mode}
    </button>
  ))}
</div>
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add console/components/ console/app/layout.tsx
git commit -m "feat(console): add ARIA attributes to interactive elements

SessionList: listbox/option with aria-selected.
ChatPane: log role with aria-live polite.
Layout nav: aria-label and aria-current on links.
ModeSwitch: radiogroup with aria-checked.
All interactive elements: .focus-ring class for visible focus indicator.
Implements TECHNICAL_PLAN.md §11.1.3."
```

---

### Task 5: Health endpoint

**Files:**
- Create: `src/api/health.ts`
- Create: `tests/api/health.test.ts`
- Modify: `src/api/index.ts` (register health router)

**Interfaces:**
- Consumes: Mastra instance from `src/mastra/index.ts`, storage connection
- Produces: `GET /health` returning per-dependency status

- [ ] **Step 1: Write the failing test**

```typescript
// tests/api/health.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('GET /health', () => {
  it('returns per-dependency status', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        storage: { getStatus: () => Promise.resolve('ok') },
      }),
    }))
    const { createHealthRouter } = await import('../../src/api/health')
    const app = createHealthRouter()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('dependencies')
    expect(body.dependencies).toHaveProperty('storage')
  })

  it('returns degraded when a dependency fails', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        storage: { getStatus: () => Promise.reject(new Error('down')) },
      }),
    }))
    const { createHealthRouter } = await import('../../src/api/health')
    const app = createHealthRouter()
    const res = await app.request('/health')
    const body = await res.json()
    expect(body.status).toBe('degraded')
    expect(body.dependencies.storage.status).toBe('error')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/health.test.ts`
Expected: FAIL — `src/api/health.ts` does not exist.

- [ ] **Step 3: Implement the health endpoint**

```typescript
// src/api/health.ts
import { Hono } from 'hono'
import { createCrumMastra } from '../mastra/index'

type DepStatus = { status: 'ok' | 'degraded' | 'error'; message?: string }

export function createHealthRouter(): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const mastra = createCrumMastra()
    const dependencies: Record<string, DepStatus> = {}

    // Storage
    try {
      if (mastra.storage && typeof (mastra.storage as any).getStatus === 'function') {
        await (mastra.storage as any).getStatus()
        dependencies.storage = { status: 'ok' }
      } else {
        dependencies.storage = { status: 'ok', message: 'in-memory' }
      }
    } catch (err: any) {
      dependencies.storage = { status: 'error', message: err.message }
    }

    const overall = Object.values(dependencies).some(d => d.status === 'error')
      ? 'degraded'
      : 'ok'

    return c.json({ status: overall, dependencies })
  })

  return app
}
```

- [ ] **Step 4: Register in API index**

Add to `src/api/index.ts`:

```typescript
import { createHealthRouter } from './health'
app.route('/', createHealthRouter())
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/api/health.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/health.ts tests/api/health.test.ts src/api/index.ts
git commit -m "feat(api): add /health endpoint with per-dependency status

Probes storage reachability. Returns 'ok' or 'degraded' overall status
plus per-dependency detail. Observability is a soft dependency (§8.7).
Implements TECHNICAL_PLAN.md §8.7."
```

---

### Task 6: Load tests for session list and retrieval paths

**Files:**
- Create: `tests/load/session-list.test.ts`
- Create: `tests/load/retrieval.test.ts`
- Modify: `package.json` (add `test:load` script and `autocannon` devDependency)

**Interfaces:**
- Consumes: running dev server at `http://localhost:4111`
- Produces: load test scripts that assert p95 latency thresholds

- [ ] **Step 1: Add autocannon devDependency**

```bash
npm install --save-dev autocannon@7.15.0
```

- [ ] **Step 2: Write session list load test**

```typescript
// tests/load/session-list.test.ts
import { describe, it, expect } from 'vitest'
import autocannon from 'autocannon'

describe('load: session list', () => {
  it('p95 latency under 300ms at 10 concurrent for 10s', async () => {
    const result = await autocannon({
      url: 'http://localhost:4111/api/sessions',
      connections: 10,
      duration: 10,
      headers: { 'x-tenant-id': 'load-test-tenant' },
    })

    expect(result.p95).toBeLessThan(300)
    expect(result.non2xx).toBe(0)
  }, 30_000)
})
```

- [ ] **Step 3: Write retrieval load test**

```typescript
// tests/load/retrieval.test.ts
import { describe, it, expect } from 'vitest'
import autocannon from 'autocannon'

describe('load: retrieval tool', () => {
  it('p95 latency under 2s at 5 concurrent for 10s', async () => {
    const result = await autocannon({
      url: 'http://localhost:4111/api/chat',
      method: 'POST',
      connections: 5,
      duration: 10,
      headers: {
        'x-tenant-id': 'load-test-tenant',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'who is in Seattle?' }],
      }),
    })

    expect(result.p95).toBeLessThan(2000)
  }, 30_000)
})
```

- [ ] **Step 4: Add test:load script to package.json**

```json
"test:load": "vitest run tests/load --reporter=verbose"
```

- [ ] **Step 5: Commit**

```bash
git add tests/load/ package.json package-lock.json
git commit -m "test(load): add autocannon load tests for session list and retrieval

Session list: p95 < 300ms at 10 concurrent for 10s.
Retrieval: p95 < 2s at 5 concurrent for 10s.
Run with npm run test:load against a running dev server.
Implements TECHNICAL_PLAN.md §16 Phase 7 checklist."
```

---

### Task 7: Runbook and on-call alerts

**Files:**
- Create: `docs/runbook.md`
- Create: `docs/alerts.md`

**Interfaces:**
- Consumes: §8.6 alerting conditions, §8.7 health checks
- Produces: runbook for common incidents, alert definitions with thresholds

- [ ] **Step 1: Write the runbook**

```markdown
<!-- docs/runbook.md -->
# CRUM Runbook

## On-Call Alerts

See [`alerts.md`](./alerts.md) for the full alert table with thresholds and windows.

## Common Incidents

### `/health` returns `degraded`

1. Check which dependency is `error` in the response body.
2. If `storage`: verify `DATABASE_URL` is reachable. Check Supabase dashboard for pool exhaustion (`EMAXCONNSESSION`). If pool cap hit, lower `MASTRA_PG_POOL_MAX` or switch to transaction-mode pooler.
3. If `observability`: this is a soft dependency. Check that the observability store is reachable, but traffic continues on reduced capability.

### Tool call error rate > 5%

1. Check `mastra_tool_duration_ms` by `status` in the metrics dashboard.
2. Identify which tool is erroring. Common causes:
   - `crm.*` tools: schema mismatch after migration — run `npm run db:migrate`.
   - `knowledge.retrieve`: vector store unreachable — check `VECTOR_STORE_URL`.
3. If model-related, check `OPENROUTER_API_KEY` validity.

### Agent latency p95 > 5s

1. Check `mastra_agent_duration_ms{status="ok"}`.
2. If model latency is also high (`mastra_model_duration_ms` p95 > 8s), the upstream provider is slow. Check OpenRouter status.
3. If model latency is fine but agent latency is high, check tool call count — a runaway loop may be calling tools excessively. Verify `maxSteps: 6` is set on the agent.

### Prompt cache hit share < 40%

1. Check `mastra_model_input_cache_read_tokens` ÷ `mastra_model_total_input_tokens`.
2. Low hit rate means the prompt prefix is mutating between turns. Check processors — a processor that appends unique content (timestamps, random ids) to the system prompt breaks caching. See §4.10.

### Spend ceiling headroom < 10%

1. Check token metrics × `costContext.estimatedCost` on the usage dashboard.
2. If approaching the ceiling, notify the tenant admin. Consider raising the ceiling or throttling usage.

### Pending approval age > 1h

1. Query the `pending_writes` table for rows older than 1 hour.
2. Nudge the approver via the ops channel. If the approver is unavailable, check whether the approval can be re-assigned.

### Eval gate regression

1. This is a CI gate, not a runtime alert. If it fires on a PR:
2. Run `npm run eval:run` locally to see which scorer regressed.
3. Compare the prompt change against the golden dataset. If the regression is expected (e.g., trading one behaviour for another), re-baseline the dataset.

## Restart Recovery

1. If the process crashes mid-approval, the `pending_writes` table survives. On restart, the approval queue's Resolved tab shows rows that are no longer resumable.
2. If the process crashes mid-goal, the objective is persisted in thread state. On restart, the goal loop resumes from where it left off (or pauses if the budget was exhausted).

## Database Connection Issues

- **`EMAXCONNSESSION`**: pool cap hit. Lower `MASTRA_PG_POOL_MAX` (default 4) or switch to transaction-mode pooler.
- **TLS errors**: set `MASTRA_PG_SSL=disable` for local dev, `MASTRA_PG_SSL=require` for production.
```

- [ ] **Step 2: Write the alerts document**

```markdown
<!-- docs/alerts.md -->
# CRUM Alert Definitions

Every alert reads a metric or a store query with an explicit time range. Source: TECHNICAL_PLAN.md §8.6.

| Condition | Source | Threshold | Window | Action |
|-----------|--------|-----------|--------|--------|
| Tool call error rate | `mastra_tool_duration_ms` by `status` | > 5% `error` | 5 min | Ops channel |
| Agent latency p95 | `mastra_agent_duration_ms{status="ok"}` | > 5 s | 10 min | Ops channel |
| Model latency p95 | `mastra_model_duration_ms` | > 8 s | 10 min | Ops channel |
| Prompt cache hit share | `mastra_model_input_cache_read_tokens` ÷ `mastra_model_total_input_tokens` | < 40% on the assistant agent | 1 h | Ops channel; investigate prefix mutation (§4.10) |
| Spend ceiling headroom | token metrics × `costContext.estimatedCost` | < 10% | 1 day | Tenant admin plus ops |
| Negative feedback rate | `addFeedback` rows with `value: 'down'` | > 2% of turns | 1 day | Ops channel; queue for §8.5 review |
| Pending approval age | CRM query, not a metric | > 1 h | 1 h | Approver nudge |
| Tenant isolation scorer | `runEvals` verdict (§7.5) | any gate below floor | per PR | Block merge |
| Eval gate regression | `runEvals` verdict (§7.5) | any gate below floor | per PR | Block merge |

## Missing Metrics

If metrics are missing entirely (not merely flat):

1. Is `MastraStorageExporter` present in the Mastra constructor?
2. Is the store metrics-capable per §8.4? (`PostgresStoreVNext` with `observability` config.)
3. Is sampling non-zero? (`SamplingStrategyType.probability` with a rate > 0.)

The third is the one that produces a completely empty dashboard with a configuration that looks correct.
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbook.md docs/alerts.md
git commit -m "docs(phase-7): add runbook and alert definitions

Runbook covers /health degraded, tool error rate, agent/model latency,
cache hit share, spend ceiling, pending approvals, eval gate regressions,
restart recovery, and database connection issues.
Alerts document reproduces §8.6 table with missing-metrics checklist.
Implements TECHNICAL_PLAN.md §8.6, §8.7, §16 Phase 7 checklist."
```

---

### Task 8: Schedule lifecycle hooks

**Files:**
- Modify: `src/mastra/index.ts` (add `schedules` config to Mastra constructor)
- Create: `tests/mastra/schedule-hooks.test.ts`

**Interfaces:**
- Consumes: `ScheduleHooks` type from `@mastra/core/schedules`, digest workflow from `src/mastra/workflows/digest.ts`
- Produces: `prepare`, `onFinish`, `onError`, `onAbort` hooks on the Mastra instance

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mastra/schedule-hooks.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('schedule lifecycle hooks', () => {
  it('prepare returns threadId from schedule', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    const result = await hooks.prepare!({
      agentId: 'crm-assistant',
      schedule: { threadId: 'thread-digest' },
    } as any)
    expect(result).toEqual({ threadId: 'thread-digest' })
  })

  it('onFinish is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onFinish).toBeDefined()
    await hooks.onFinish!({ agentId: 'crm-assistant', trigger: {} } as any)
  })

  it('onError is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onError).toBeDefined()
    await hooks.onError!({ agentId: 'crm-assistant', error: new Error('test') } as any)
  })

  it('onAbort is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onAbort).toBeDefined()
    await hooks.onAbort!({ agentId: 'crm-assistant' } as any)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mastra/schedule-hooks.test.ts`
Expected: FAIL — `src/mastra/schedule-hooks.ts` does not exist.

- [ ] **Step 3: Implement schedule hooks**

```typescript
// src/mastra/schedule-hooks.ts
import type { ScheduleHooks } from '@mastra/core/schedules'

export function buildScheduleHooks(): ScheduleHooks {
  return {
    prepare: async ({ schedule }) => {
      return { threadId: schedule.threadId }
    },
    onFinish: async ({ agentId, trigger }) => {
      console.log(`[schedule] ${agentId} finished`, trigger)
    },
    onError: async ({ agentId, error }) => {
      console.error(`[schedule] ${agentId} error:`, error.message)
    },
    onAbort: async ({ agentId }) => {
      console.log(`[schedule] ${agentId} aborted`)
    },
  }
}
```

- [ ] **Step 4: Wire hooks into Mastra constructor**

In `src/mastra/index.ts`, add to the `new Mastra({...})` config:

```typescript
import { buildScheduleHooks } from './schedule-hooks'

// ...
schedules: buildScheduleHooks(),
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mastra/schedule-hooks.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/schedule-hooks.ts tests/mastra/schedule-hooks.test.ts src/mastra/index.ts
git commit -m "feat(schedules): add lifecycle hooks (prepare, onFinish, onError, onAbort)

Instance-wide hooks run for every schedule fire. Branch on agentId for
per-agent behaviour. Implements TECHNICAL_PLAN.md §4.7.2."
```

---

### Task 9: Final verification and documentation

**Files:**
- Create: `docs/superpowers/verification/phase-7-verification.md`
- Modify: `docs/superpowers/plans/00-ROADMAP.md` (mark Phase 7 complete)

**Interfaces:**
- Consumes: all Phase 7 deliverables
- Produces: verification record, roadmap update

- [ ] **Step 1: Run full test suite**

```bash
npm run verify
```

Expected: typecheck, lint, and all tests pass.

- [ ] **Step 2: Run load tests (optional, requires running dev server)**

```bash
npm run dev &
npm run test:load
```

Expected: p95 latency within thresholds.

- [ ] **Step 3: Write verification record**

```markdown
<!-- docs/superpowers/verification/phase-7-verification.md -->
# Phase 7 Verification Record

## Date
2026-10-24

## Acceptance Criteria from TECHNICAL_PLAN.md §16

- [x] **Signals: `interrupt`, `correct`, `rebind`**
  - `POST /api/signals/interrupt` calls `session.abort()`
  - `POST /api/signals/correct` calls `session.steer({ content })`
  - `POST /api/signals/rebind` calls `session.sendSignal()` with state signal
  - Tests: `tests/api/signals.test.ts` (5 tests)

- [x] **One narrow goal (approval-free inbox clearing) with a hard `maxRuns`**
  - `startInboxClearingGoal()` calls `setObjective` with `maxRuns: 12`
  - Agent config includes `goal: { judgeModelId, maxRuns: 12 }`
  - Restricted to auto-class tools (log_followup) by objective text
  - Tests: `tests/mastra/goals.test.ts` (2 tests)

- [x] **Accessibility pass against §11.1.2**
  - Theme tokens in `console/app/theme.css` match §11.1.2 contrast table
  - Light mode uses `green-600` (green-500 fails AA on white)
  - Focus ring: 2px accent offset 2px
  - ARIA attributes on SessionList, ChatPane, ObjectPanel, ModeSwitch, layout nav
  - Typography: 14px base, 1.5 line-height prose, 1.35 tables

- [x] **Load test the session list and retrieval paths**
  - `tests/load/session-list.test.ts`: p95 < 300ms at 10 concurrent
  - `tests/load/retrieval.test.ts`: p95 < 2s at 5 concurrent
  - Script: `npm run test:load`

- [x] **Runbook and on-call alerts**
  - `docs/runbook.md`: common incidents, restart recovery, database issues
  - `docs/alerts.md`: 9 alert conditions from §8.6 with missing-metrics checklist
  - `/health` endpoint: per-dependency status, soft observability dependency

## Additional Deliverables

- Schedule lifecycle hooks: `prepare`, `onFinish`, `onError`, `onAbort` on Mastra constructor
- Tests: `tests/mastra/schedule-hooks.test.ts` (4 tests)

## Test Summary

- Unit tests: `npm run test` — all pass
- Load tests: `npm run test:load` — p95 within thresholds (requires running dev server)
- Typecheck: `npm run typecheck` — pass
- Lint: `npm run lint` — pass

## Commits

```
<git log --oneline main..phase/7-polish>
```

## Notes

- Goals require a memory-backed thread and Mastra storage; no-ops in in-memory dev runs.
- Light mode accent is `green-600` because `green-500` fails AA on white (3.0:1).
- Observability is a soft dependency in `/health` — tracing is fail-open throughout.
```

- [ ] **Step 4: Update roadmap**

In `docs/superpowers/plans/00-ROADMAP.md`, mark Phase 7 as complete:

```markdown
| 7 | Autonomy and polish | `phase/7-polish` | 2-3 d | [`2026-10-24-phase-7-polish.md`](./2026-10-24-phase-7-polish.md) | ✅ Signals, one narrow goal with hard maxRuns, accessibility pass, load tests, runbook |
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/verification/phase-7-verification.md docs/superpowers/plans/00-ROADMAP.md
git commit -m "docs(phase-7): add verification record and mark roadmap complete

All Phase 7 acceptance criteria met: signals, goal, accessibility,
load tests, runbook. Schedule lifecycle hooks included."
```

---

## Summary

Phase 7 delivers the final polish layer: signal-based session control, one narrow autonomous goal, WCAG 2.2 AA accessibility, load tests for the hot paths, and operational documentation. The phase is intentionally narrow — goals are restricted to auto-class tools, the accessibility pass focuses on the spec's token table and ARIA attributes, and the runbook covers the nine alert conditions from §8.6.

Total estimated time: 2-3 days part-time.
