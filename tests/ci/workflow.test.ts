import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = process.cwd()

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
}

interface WorkflowJob {
  'runs-on': string
  services?: Record<string, { image: string }>
  steps: WorkflowStep[]
}

interface Workflow {
  name: string
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

const workflow = parse(
  readFileSync(path.join(ROOT, '.github/workflows/crum-ci.yml'), 'utf8'),
) as Workflow

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  engines: { node: string }
}

const devcontainer = JSON.parse(
  readFileSync(path.join(ROOT, '.devcontainer/devcontainer.json'), 'utf8'),
) as { image: string; postCreateCommand: string }

const job = workflow.jobs.verify
if (!job) throw new Error('the verify job is missing from the workflow')
const steps = job.steps

/** Index of the first step whose `run` starts with the given command. */
function stepIndex(prefix: string): number {
  return steps.findIndex((step) => step.run?.startsWith(prefix) === true)
}

describe('the verify job', () => {
  it('exists and runs on ubuntu', () => {
    expect(job).toBeDefined()
    expect(job['runs-on']).toBe('ubuntu-latest')
  })

  it('provisions a pgvector service, not a bare postgres', () => {
    const postgres = job.services?.postgres
    expect(postgres).toBeDefined()
    expect(postgres?.image).toMatch(/^pgvector\/pgvector:pg1[6-9]$/)
  })

  it('pins Node to the major version the engines field requires', () => {
    const setup = steps.find((step) => step.uses?.startsWith('actions/setup-node'))
    expect(setup).toBeDefined()
    expect(manifest.engines.node).toBe('>=22.18.0')
    // The version lives under `with:`, which the WorkflowStep interface above
    // does not model, so read it from the raw text. A Node 20 pin here would let
    // CI pass against a runtime production cannot use (§16 Phase 0).
    const raw = readFileSync(path.join(ROOT, '.github/workflows/crum-ci.yml'), 'utf8')
    expect(raw).toMatch(/node-version:\s*'?22'?/)
  })

  it('installs from the lockfile rather than resolving afresh', () => {
    expect(steps.some((step) => step.run === 'npm ci')).toBe(true)
    expect(steps.some((step) => step.run?.startsWith('npm install') === true)).toBe(false)
  })
})

describe('every step calls a script that exists', () => {
  const npmRunSteps = steps.filter((step) => step.run?.startsWith('npm run ') === true)

  it('finds npm run steps to check', () => {
    expect(npmRunSteps.length).toBeGreaterThanOrEqual(6)
  })

  /**
   * The failure this prevents is a green-looking pipeline that dies on its first
   * real run because somebody renamed a script. Reading package.json back keeps
   * the two files in one assertion instead of two people's memories.
   */
  it('references only declared scripts', () => {
    for (const step of npmRunSteps) {
      const script = (step.run ?? '').replace(/^npm run /, '').split(/\s/)[0] ?? ''
      expect(Object.keys(manifest.scripts), `${step.name ?? step.run}`).toContain(script)
    }
  })

  it('does not run Phase 1 or Phase 6 jobs that do not exist yet', () => {
    const raw = JSON.stringify(workflow)
    expect(raw).not.toContain('eval:crum')
    expect(raw).not.toContain('test:a11y')
  })
})

describe('step order', () => {
  it('checks out before installing', () => {
    expect(stepIndex('npm ci')).toBeGreaterThan(
      steps.findIndex((step) => step.uses?.startsWith('actions/checkout')),
    )
  })

  it('typechecks, which is also the alarm for every @ts-expect-error directive', () => {
    expect(steps.some((step) => step.run === 'npm run typecheck')).toBe(true)
  })

  it('regenerates the schema snapshot before diffing it', () => {
    const generate = stepIndex('npm run db:export-schema')
    const diff = stepIndex('git diff --exit-code migrations/')
    expect(generate).toBeGreaterThan(-1)
    expect(diff).toBeGreaterThan(generate)
  })

  it('migrates before running integration tests', () => {
    expect(stepIndex('npm run db:migrate')).toBeLessThan(stepIndex('npm run test:integration'))
  })

  it('runs unit tests before touching the database', () => {
    expect(stepIndex('npm run test:unit')).toBeLessThan(stepIndex('npm run db:migrate'))
  })

  it('gives the integration step a real database URL', () => {
    const integration = steps.find((step) => step.run === 'npm run test:integration')
    expect(integration?.env?.CRUM_INTEGRATION_DATABASE_URL).toBeTruthy()
  })
})

describe('least privilege', () => {
  it('requests read-only contents permission', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('cancels a superseded run on the same ref', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })

  /**
   * Phase 0 makes no model call and contacts no third party. Any secret in this
   * file is therefore either premature or a mistake, and both are cheaper to
   * catch here than to find in the repository's secret audit.
   */
  it('uses no secret', () => {
    expect(readFileSync(path.join(ROOT, '.github/workflows/crum-ci.yml'), 'utf8')).not.toContain(
      'secrets.',
    )
  })

  it('scans tracked files for credential shapes', () => {
    expect(steps.some((step) => step.name === 'Credential shapes')).toBe(true)
  })
})

describe('triggers', () => {
  it('runs on pull requests', () => {
    expect(workflow.on).toHaveProperty('pull_request')
  })

  it('runs on main and on phase branches', () => {
    const branches = (workflow.on.push as { branches: string[] }).branches
    expect(branches).toContain('main')
    expect(branches.some((pattern) => pattern.includes('phase/'))).toBe(true)
  })
})

describe('the devcontainer', () => {
  it('uses a Node 22 image matching the engines floor', () => {
    expect(devcontainer.image).toMatch(/typescript-node:22/)
  })

  it('installs dependencies on create', () => {
    expect(devcontainer.postCreateCommand).toContain('npm ci')
  })
})
