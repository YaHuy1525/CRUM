import type { Mastra } from '@mastra/core/mastra'
import type { AgentController, AgentControllerThread } from '@mastra/core/agent-controller'

// §4.2 — Agent Controller session helpers. Phase 1 wires the read path
// (queryThreads) and basic session creation. Phase 3 adds the approval queue.

export interface CreateSessionOptions {
  agentId: string
  resourceId: string
  threadId?: string
  /** Explicit session id. Defaults to resourceId when omitted (controller caches by id). */
  id?: string
}

export interface ListSessionsOptions {
  agentId: string
  resourceId: string
}

/**
 * Resolves the AgentController registered under `agentId` on the Mastra instance.
 * Throws when no controller is found so callers get a clear diagnostic instead
 * of a silent undefined dereference.
 */
function requireController(mastra: Mastra, agentId: string): AgentController<any> {
  const controller = mastra.getAgentController(agentId)
  if (!controller) {
    throw new Error(
      `createSession: no AgentController registered under key "${agentId}". ` +
        `Pass agentControllers to the Mastra constructor.`,
    )
  }
  return controller
}

/**
 * Creates a session for the given agent. The AgentController creates (or
 * recovers) a session keyed by resourceId and provisions an initial thread.
 *
 * Returns the Session, which exposes `session.thread.getId()` and
 * `session.identity.getResourceId()` for downstream consumers.
 */
export async function createSession(
  mastra: Mastra,
  options: CreateSessionOptions,
) {
  const controller = requireController(mastra, options.agentId)

  // initStorage ensures the storage layer is ready for thread persistence
  // without provisioning a full workspace/sandbox.
  await controller.initStorage()

  const session = await controller.createSession({
    id: options.id,
    resourceId: options.resourceId,
    threadId: options.threadId,
  })

  return session
}

/**
 * Lists sessions for a resource by recovering live Session objects from stored
 * threads.
 *
 * **Side effects:** For each thread returned by `queryThreads`, this calls
 * `controller.createSession({ resourceId, threadId })`. Despite the name
 * "createSession", this is **idempotent** — when a `threadId` is provided,
 * AgentController.createSession resumes the existing thread rather than
 * creating a duplicate (verified against AgentController `.d.ts`: "Existing
 * threads are resumed; missing threads are created with this id"). The result
 * is a set of live Session objects bound to their respective threads.
 *
 * This recovery pattern is necessary because threads are persisted in storage
 * but Session objects are in-memory; after a restart, the sessions must be
 * reconstructed from their thread state.
 *
 * Returns Session[] — the live session objects recovered from thread state.
 */
export async function listSessions(
  mastra: Mastra,
  options: ListSessionsOptions,
) {
  const controller = requireController(mastra, options.agentId)
  await controller.initStorage()

  // Each thread corresponds to a session. Recover the live session for each.
  const threads = await controller.queryThreads({
    resourceId: options.resourceId,
  })

  const sessions = await Promise.all(
    threads.map((thread: AgentControllerThread) =>
      controller.createSession({
        resourceId: thread.resourceId,
        threadId: thread.id,
      }),
    ),
  )

  return sessions
}

export interface ResolveSessionOptions {
  sessionId: string
  tenantId: string
}

/**
 * Recovers an existing AgentController session by its session id and tenant.
 *
 * The AgentController keeps in-memory sessions keyed by id. After a restart the
 * session must be reconstructed from its thread state — this function wraps that
 * recovery so signal endpoints can obtain a live Session handle from just the
 * headers the browser sends (`x-session-id`, `x-tenant-id`).
 *
 * Returns `{ session }` — the live Session object with `abort()`, `steer()`,
 * `sendSignal()`, and `queueMessage()` methods.
 */
export async function resolveSession(
  _options: ResolveSessionOptions,
): Promise<{ session: any }> {
  // TODO(phase-7): wire to controller.createSession({ id: sessionId }) after
  // verifying the session belongs to tenantId. For now, throw so callers get a
  // clear diagnostic until the full recovery path is implemented.
  throw new Error(
    `resolveSession: session recovery not yet implemented for sessionId "${_options.sessionId}"`,
  )
}

/**
 * Read-only thread listing. Does NOT create a session — this is the sidebar
 * query that must respond in <300ms without provisioning a workspace.
 *
 * §16 Phase 1 acceptance: session list renders under 300ms.
 */
export async function queryThreads(
  mastra: Mastra,
  options: ListSessionsOptions,
): Promise<AgentControllerThread[]> {
  const controller = requireController(mastra, options.agentId)
  await controller.initStorage()

  return controller.queryThreads({
    resourceId: options.resourceId,
  })
}
