import type { Mastra } from '@mastra/core/mastra'
import { isSessionNotStartedError } from '@mastra/core/agent-controller'
import type { AgentControllerThread, Session } from '@mastra/core/agent-controller'


export const CRUM_AGENT_CONTROLLER_ID = 'crm-assistant'

export interface CreateSessionOptions {
  agentId: string
  resourceId: string
  threadId?: string
  id?: string
}

export interface ListSessionsOptions {
  agentId: string
  resourceId: string
}

type RegisteredAgentController = NonNullable<ReturnType<Mastra['getAgentController']>>

function requireController(mastra: Mastra, agentId: string): RegisteredAgentController {
  const controller = mastra.getAgentController(agentId)
  if (!controller) {
    throw new Error(
      `createSession: no AgentController registered under key "${agentId}". ` +
        `Pass agentControllers to the Mastra constructor.`,
    )
  }
  return controller
}

export async function createSession(
  mastra: Mastra,
  options: CreateSessionOptions,
) {
  const controller = requireController(mastra, options.agentId)

  await controller.initStorage()

  const session = await controller.createSession({
    id: options.id,
    resourceId: options.resourceId,
    threadId: options.threadId,
  })

  return session
}

export async function listSessions(
  mastra: Mastra,
  options: ListSessionsOptions,
) {
  const controller = requireController(mastra, options.agentId)
  await controller.initStorage()

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
  resourceId: string
  agentId?: string
}

export type ResolvedSession =
  | { ok: true; session: Session<unknown> }
  | { ok: false; reason: 'not-started' }
  | { ok: false; reason: 'wrong-resource' }
  | { ok: false; reason: 'controller-missing' }

export function resourceIdFor(identity: { tenantId: string; userId: string }): string {
  return `${identity.tenantId}:${identity.userId}`
}

export async function resolveSession(
  mastra: Mastra,
  options: ResolveSessionOptions,
): Promise<ResolvedSession> {
  const { sessionId, resourceId } = options
  const agentId = options.agentId ?? CRUM_AGENT_CONTROLLER_ID

  if (!resourceId.startsWith(`${options.tenantId}:`)) {
    return { ok: false, reason: 'wrong-resource' }
  }

  let controller: RegisteredAgentController
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
