import type { Mastra } from '@mastra/core/mastra'
import { isSessionNotStartedError } from '@mastra/core/agent-controller'
import type { AgentController, AgentControllerThread, Session } from '@mastra/core/agent-controller'

// §4.2 — Agent Controller session helpers. Phase 1 wires the read path
// (queryThreads) and basic session creation. Phase 3 adds the approval queue.

/** Registry key of the controller every session helper defaults to. */
export const CRUM_AGENT_CONTROLLER_ID = 'crm-assistant'

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
  /**
   * The conversation handle the browser sends in `x-session-id`. CRUM uses one
   * identifier for a conversation across both planes: the chat lane's
   * `x-thread-id` (see `buildCrumServerConfig`) and the controller's session id
   * are the same value, so a client does not have to track two ids per turn.
   */
  sessionId: string
  tenantId: string
  /**
   * The caller's own resource, built by `resourceIdFor()` from a verified
   * identity. Recovery is scoped to it, which is what makes another tenant's
   * conversation unresumable rather than merely unlisted.
   */
  resourceId: string
  /** Controller registry key. Defaults to the CRUM assistant controller. */
  agentId?: string
}

/**
 * Outcomes are a union rather than exceptions, because every reason here is a
 * different HTTP answer for the caller — and two of them must be
 * indistinguishable to whoever guessed the id.
 */
export type ResolvedSession =
  | { ok: true; session: Session<unknown> }
  /** No live session, and nothing stored to recover under this resource. */
  | { ok: false; reason: 'not-started' }
  /** The id resolves to a different resource than the caller's. */
  | { ok: false; reason: 'wrong-resource' }
  /** No AgentController is registered under `agentId` — a wiring bug, not a client error. */
  | { ok: false; reason: 'controller-missing' }

/**
 * The tenant-qualified resource id the whole app isolates threads with (§4.2).
 * Written once here so the chat middleware, the signal routes and session
 * recovery cannot drift to three different conventions.
 */
export function resourceIdFor(identity: { tenantId: string; userId: string }): string {
  return `${identity.tenantId}:${identity.userId}`
}

/**
 * Recovers an existing AgentController session by its session id, bound to the
 * caller's own resource.
 *
 * The AgentController keeps sessions in memory keyed by id. After a restart the
 * session must be reconstructed from its stored thread, which is what
 * `createSession({ resumeOnly: true })` does — the name is misleading, and the
 * flag is the reason it is safe to call from a request: "Existing threads are
 * resumed; missing threads are created with this id" applies without the flag,
 * and `resumeOnly` never starts a conversation.
 *
 * Ownership is enforced twice, because a session id is a bearer token if it is
 * the only thing checked:
 * - the live path compares `session.identity.getResourceId()` to the caller's
 *   resource (`getSession` is keyed by id alone);
 * - the recovery path passes `resourceId` and `threadId`, and core only binds a
 *   thread when `thread.resourceId === resourceId`, otherwise throwing
 *   `SessionNotStartedError`. Another tenant's thread therefore reads as "not
 *   started", which is the same answer as a nonexistent id — no existence
 *   oracle for anyone enumerating session ids.
 *
 * A recovered `Session` is a real handle, but a session that was never the one
 * running a stream cannot steer that stream. See src/api/signals.ts, which
 * reports what it asked for rather than claiming a run stopped.
 */
export async function resolveSession(
  mastra: Mastra,
  options: ResolveSessionOptions,
): Promise<ResolvedSession> {
  const { sessionId, resourceId } = options
  const agentId = options.agentId ?? CRUM_AGENT_CONTROLLER_ID

  // The resource is derived from a verified identity, so a mismatch here means
  // the caller assembled the pair wrong — refuse rather than widen the scope.
  if (!resourceId.startsWith(`${options.tenantId}:`)) {
    return { ok: false, reason: 'wrong-resource' }
  }

  let controller: AgentController<any>
  try {
    controller = requireController(mastra, agentId)
  } catch {
    return { ok: false, reason: 'controller-missing' }
  }

  const live = await controller.getSession(sessionId)
  if (live) {
    if (live.identity.getResourceId() !== resourceId) return { ok: false, reason: 'wrong-resource' }
    return { ok: true, session: live }
  }

  try {
    const session = await controller.createSession({
      id: sessionId,
      resourceId,
      threadId: sessionId,
      resumeOnly: true,
    })
    if (!session) return { ok: false, reason: 'not-started' }
    return { ok: true, session }
  } catch (err) {
    if (isSessionNotStartedError(err)) return { ok: false, reason: 'not-started' }
    throw err
  }
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
