import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { RiskAssessment } from './risk'
import {
  RiskFileSchema,
  ToolsFileSchema,
  type Gate,
  type RiskFile,
  type ToolClass,
  type ToolPolicyEntry,
  type ToolsFile,
} from './schema'

/** Raised for every policy loading failure, so callers can catch one type. */
export class PolicyLoadError extends Error {
  readonly issues: unknown[]

  constructor(message: string, issues: unknown[] = []) {
    super(message)
    this.name = 'PolicyLoadError'
    this.issues = issues
  }
}

/**
 * Caller-supplied context for a gate decision.
 *
 * `workflow` and `step` resolve the `{workflow}:{step}` scope template that
 * policy/tools.yaml declares on `run.side-effect`. `requestContext` is a plain
 * record rather than a RequestContext instance on purpose: a tool-level
 * `requireApproval` predicate receives `requestContext?: Record<string, unknown>`
 * per @mastra/core@1.79.0/dist/tools/types.d.ts:655, so governance code that
 * assumed a Map-like `.get()` would work from `execute` and throw from the gate.
 */
export interface GovernanceContext {
  workflow?: string
  step?: string
  requestContext?: Record<string, unknown>
}

/** Gate severity ordering. Floors only ever raise; they never lower a refuse. */
const GATE_RANK: Record<Gate, number> = { auto: 0, approval: 1, refuse: 2 }

function raise(current: Gate, floor: Gate): Gate {
  return GATE_RANK[current] >= GATE_RANK[floor] ? current : floor
}

function declaredGate(klass: ToolClass | undefined): Gate {
  // An unknown tool name has no declared class. Refusing is the only safe
  // default: a typo in a tool id must not silently produce an ungated write.
  if (klass === undefined) return 'refuse'
  if (klass === 'read-only' || klass === 'auto') return 'auto'
  if (klass === 'approval') return 'approval'
  return 'refuse'
}

export interface Policy {
  readonly risk: RiskFile
  readonly tools: ToolsFile
  readonly toolByName: ReadonlyMap<string, ToolPolicyEntry>

  /**
   * Resolve the permission gate for one call.
   *
   * Starts from the declared class, then raises it by score band, then raises it
   * again by the sensitive-marker floor. Never lowers. TECHNICAL_PLAN.md §12.2.
   */
  gateFor(toolName: string, risk: RiskAssessment, context?: GovernanceContext): Gate

  /**
   * Resolve the audit scope string for one call. For every tool except
   * `run.side-effect` this is the declared `scope`. For `run.side-effect` the
   * `{workflow}:{step}` template is filled from `context`, and an incomplete
   * context throws rather than emitting a scope with a literal brace in it.
   */
  scopeFor(toolName: string, context?: GovernanceContext): string

  toolsByClass(klass: ToolClass): string[]
}

function readPolicyFile(path: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new PolicyLoadError(`cannot read policy file ${path}: ${(cause as Error).message}`)
  }
  try {
    return parseYaml(raw)
  } catch (cause) {
    throw new PolicyLoadError(`${path} is not valid YAML: ${(cause as Error).message}`)
  }
}

function parseOrThrow<T>(schema: { safeParse(data: unknown): { success: boolean; data?: T; error?: { issues: unknown[] } } }, data: unknown, path: string): T {
  const result = schema.safeParse(data)
  if (result.success) return result.data as T
  const issues = result.error?.issues ?? []
  const summary = issues
    .map((issue) => {
      const i = issue as { path?: (string | number)[]; message?: string }
      return `  ${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`
    })
    .join('\n')
  throw new PolicyLoadError(`${path} failed validation:\n${summary}`, issues)
}

/**
 * Load and validate the governance policy from a directory holding risk.yaml
 * and tools.yaml. Defaults to `<cwd>/policy`, overridable with POLICY_DIR (§13.4).
 *
 * Pure and side-effect free apart from two file reads, so tests can point it at
 * a temporary directory.
 */
export function loadPolicy(dir?: string): Policy {
  const root = dir ?? join(process.cwd(), 'policy')
  const riskPath = join(root, 'risk.yaml')
  const toolsPath = join(root, 'tools.yaml')

  const risk = parseOrThrow<RiskFile>(RiskFileSchema, readPolicyFile(riskPath), riskPath)
  const tools = parseOrThrow<ToolsFile>(ToolsFileSchema, readPolicyFile(toolsPath), toolsPath)

  const toolByName = new Map<string, ToolPolicyEntry>(tools.tools.map((t) => [t.name, t]))
  const { gates } = risk.preflight

  return {
    risk,
    tools,
    toolByName,

    gateFor(toolName, assessment, context) {
      void context // reserved for per-tenant overrides, Phase 3
      let gate = declaredGate(toolByName.get(toolName)?.class)
      if (assessment.score >= gates.refuse_at) gate = raise(gate, 'refuse')
      else if (assessment.score >= gates.approval_at) gate = raise(gate, 'approval')
      if (assessment.sensitive) gate = raise(gate, risk.sensitive.required_gate)
      return gate
    },

    scopeFor(toolName, context) {
      const entry = toolByName.get(toolName)
      if (!entry) throw new PolicyLoadError(`scopeFor: unknown tool ${toolName}`)
      if (!entry.scope.includes('{')) return entry.scope

      const workflow = context?.workflow
      const step = context?.step
      if (!workflow || !step) {
        throw new PolicyLoadError(
          `run.side-effect needs context.workflow and context.step to resolve scope template "${entry.scope}" (tool ${toolName})`,
        )
      }
      return entry.scope.replace('{workflow}', workflow).replace('{step}', step)
    },

    toolsByClass(klass) {
      return tools.tools.filter((t) => t.class === klass).map((t) => t.name)
    },
  }
}
