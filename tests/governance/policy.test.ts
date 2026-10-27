import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy, PolicyLoadError } from '@/governance/policy'
import type { RiskAssessment } from '@/governance/risk'

const REPO_POLICY = join(process.cwd(), 'policy')

/** The repository's real policy files, loaded from disk. */
const real = loadPolicy(REPO_POLICY)

function tempPolicy(risk: string, tools: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crum-policy-'))
  writeFileSync(join(dir, 'risk.yaml'), risk, 'utf8')
  writeFileSync(join(dir, 'tools.yaml'), tools, 'utf8')
  return dir
}

const MINIMAL_RISK = `
version: 1
preflight:
  irreversible_terms: [delete]
  high_blast_terms: [bulk]
  scores: { irreversible_high_blast: 90, single_risk: 55, benign: 10 }
  gates: { refuse_at: 80, approval_at: 40 }
  domains: {}
sensitive:
  clause: sensitive/personal-data
  markers: [salary]
  required_gate: approval
`

const MINIMAL_TOOLS = `
version: 1
tools:
  - name: crm.list_customers
    description: List customers.
    scope: crm-read
    class: read-only
  - name: crm.delete_customer
    description: Soft delete.
    scope: crm:delete
    class: approval
    idempotent: true
    idempotency_key: draftHash
connectors: []
`

function benign(): RiskAssessment {
  return { score: 10, sensitive: false, reasons: [] }
}

describe('loadPolicy', () => {
  it('loads the repository policy files', () => {
    expect(real.risk.version).toBe(1)
    expect(real.tools.tools).toHaveLength(26)
    expect(real.tools.connectors).toHaveLength(3)
  })

  it('indexes every tool by name', () => {
    expect(real.toolByName.get('crm.delete_customer')?.class).toBe('approval')
    expect(real.toolByName.get('crm.list_customers')?.class).toBe('read-only')
    expect(real.toolByName.get('nope.not_a_tool')).toBeUndefined()
  })

  it('groups tools by class', () => {
    expect(real.toolsByClass('read-only')).toHaveLength(14)
    expect(real.toolsByClass('auto')).toHaveLength(3)
    expect(real.toolsByClass('approval')).toHaveLength(8)
    expect(real.toolsByClass('refuse')).toEqual(['crm.bulk_import'])
  })

  it('defaults a missing connectors block to an empty array', () => {
    const dir = tempPolicy(MINIMAL_RISK, 'version: 1\ntools:\n  - {name: a.b, description: d, scope: s, class: auto, idempotent: true, idempotency_key: correlationId}\n')
    expect(loadPolicy(dir).tools.connectors).toEqual([])
  })
})

describe('loadPolicy rejects malformed input', () => {
  it('names the file that failed to parse', () => {
    const dir = tempPolicy('version: 1\npreflight: [not, an, object]\n', MINIMAL_TOOLS)
    expect(() => loadPolicy(dir)).toThrowError(/risk\.yaml/)
  })

  it('throws a PolicyLoadError carrying the zod issues', () => {
    const dir = tempPolicy(MINIMAL_RISK, MINIMAL_TOOLS.replace('class: approval', 'class: sideways'))
    try {
      loadPolicy(dir)
      expect.unreachable('loadPolicy should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyLoadError)
      expect((error as PolicyLoadError).issues.length).toBeGreaterThan(0)
    }
  })

  it('rejects a version other than 1', () => {
    const dir = tempPolicy(MINIMAL_RISK.replace('version: 1', 'version: 2'), MINIMAL_TOOLS)
    expect(() => loadPolicy(dir)).toThrowError(/version/)
  })

  it('rejects refuse_at at or below approval_at', () => {
    const dir = tempPolicy(
      MINIMAL_RISK.replace('refuse_at: 80, approval_at: 40', 'refuse_at: 40, approval_at: 40'),
      MINIMAL_TOOLS,
    )
    expect(() => loadPolicy(dir)).toThrowError(/refuse_at/)
  })

  it('rejects duplicate tool names', () => {
    const dir = tempPolicy(
      MINIMAL_RISK,
      MINIMAL_TOOLS.replace(
        'connectors: []',
        '  - name: crm.list_customers\n    description: Duplicate.\n    scope: crm-read\n    class: read-only\nconnectors: []',
      ),
    )
    expect(() => loadPolicy(dir)).toThrowError(/duplicate/i)
  })

  it('rejects a mutating tool that does not declare idempotent', () => {
    const dir = tempPolicy(
      MINIMAL_RISK,
      'version: 1\ntools:\n  - {name: crm.create_task, description: d, scope: crm-write, class: auto}\nconnectors: []\n',
    )
    expect(() => loadPolicy(dir)).toThrowError(/must declare idempotent/)
  })

  it('rejects an idempotent tool with no idempotency_key', () => {
    const dir = tempPolicy(
      MINIMAL_RISK,
      'version: 1\ntools:\n  - {name: crm.create_task, description: d, scope: crm-write, class: auto, idempotent: true}\nconnectors: []\n',
    )
    expect(() => loadPolicy(dir)).toThrowError(/idempotency_key/)
  })

  it('accepts a refuse-class tool with no idempotency key', () => {
    // Ruling A4: §4.6.2 assigns crm.bulk_import `—` for the idempotency key.
    // A tool that never executes cannot be committed twice, so the idempotency
    // rule does not apply to the refuse class.
    const dir = tempPolicy(
      MINIMAL_RISK,
      'version: 1\ntools:\n  - {name: crm.bulk_import, description: d, scope: crm:bulk, class: refuse}\nconnectors: []\n',
    )
    expect(() => loadPolicy(dir)).not.toThrow()
  })

  it('reports a missing directory rather than a raw ENOENT', () => {
    expect(() => loadPolicy(join(tmpdir(), 'crum-does-not-exist'))).toThrowError(PolicyLoadError)
  })
})

describe('gateFor', () => {
  it('resolves read-only and auto tools to auto', () => {
    expect(real.gateFor('crm.list_customers', benign())).toBe('auto')
    expect(real.gateFor('crm.log_followup', benign())).toBe('auto')
  })

  it('resolves a declared approval tool to approval', () => {
    expect(real.gateFor('crm.create_customer', benign())).toBe('approval')
  })

  it('resolves a declared refuse tool to refuse even on a benign score', () => {
    expect(real.gateFor('crm.bulk_import', benign())).toBe('refuse')
  })

  it('fails closed on an unknown tool name', () => {
    expect(real.gateFor('crm.nuke_everything', benign())).toBe('refuse')
  })

  it('raises a read-only tool to refuse on a score at or above refuse_at', () => {
    expect(real.gateFor('crm.list_customers', { score: 80, sensitive: false, reasons: [] })).toBe(
      'refuse',
    )
  })
})

describe('scopeFor', () => {
  it('returns the declared scope for a concrete tool', () => {
    expect(real.scopeFor('mail.send')).toBe('mail:send')
  })

  it('resolves the run.side-effect template from context', () => {
    expect(
      real.scopeFor('run.side-effect', { workflow: 'ingestWorkflow', step: 'embed' }),
    ).toBe('ingestWorkflow:embed')
  })

  it('refuses to resolve the template without both halves', () => {
    expect(() => real.scopeFor('run.side-effect', { workflow: 'ingestWorkflow' })).toThrowError(
      /run\.side-effect/,
    )
  })
})
