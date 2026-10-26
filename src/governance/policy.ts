import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

export class PolicyLoadError extends Error {
  readonly issues: unknown[]

  constructor(message: string, issues: unknown[] = []) {
    super(message)
    this.name = 'PolicyLoadError'
    this.issues = issues
  }
}

export interface GovernanceContext {
  workflow?: string
  step?: string
  requestContext?: Record<string, unknown>
}

const GATE_RANK: Record<Gate, number> = { auto: 0, approval: 1, refuse: 2 }

function raise(current: Gate, floor: Gate): Gate {
  return GATE_RANK[current] >= GATE_RANK[floor] ? current : floor
}

function declaredGate(klass: ToolClass | undefined): Gate {
  if (klass === undefined) return 'refuse'
  if (klass === 'read-only' || klass === 'auto') return 'auto'
  if (klass === 'approval') return 'approval'
  return 'refuse'
}

export interface Policy {
  readonly risk: RiskFile
  readonly tools: ToolsFile
  readonly toolByName: ReadonlyMap<string, ToolPolicyEntry>

  gateFor(toolName: string, risk: RiskAssessment, context?: GovernanceContext): Gate

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

function findPolicyRoot(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, 'policy')
    if (existsSync(join(candidate, 'risk.yaml')) && existsSync(join(candidate, 'tools.yaml'))) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function defaultPolicyDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return findPolicyRoot(process.cwd()) ?? findPolicyRoot(moduleDir) ?? join(process.cwd(), 'policy')
}

export function loadPolicy(dir?: string): Policy {
  const root = dir ?? defaultPolicyDir()
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
      void context
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
