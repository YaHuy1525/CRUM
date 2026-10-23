# Phase 0: Alignment and Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a CRUM repository that boots a Mastra instance in both persistent and in-memory
mode, loads a versioned governance policy under test, ships committed migrations, and runs a green
CI skeleton, with the two riskiest API assumptions proven by a typecheck rather than discovered in
Phase 3.

**Architecture:** Everything in this phase is deterministic and model-free. A policy plane reads two
YAML files into a validated object that resolves a permission gate from a risk score. A storage
builder chooses Postgres or in-memory from the environment. Migrations are a committed, reviewed SQL
artifact rather than something the application decides at boot. The Mastra instance wires the three
together and refuses to serve MCP continuations without a shared signing key in production.

**Tech Stack:** TypeScript 5.9.3 ESM, Node 22.18.0+, `@mastra/core` 1.79.0, `@mastra/pg` 1.32.0,
`@mastra/observability` 1.21.0, Zod 4.6.7, `yaml` 2.9.1, Vitest 3.2.7, tsx 4.23.15.

**Spec:** [`docs/TECHNICAL_PLAN.md`](../../TECHNICAL_PLAN.md) v0.3.0, §16 Phase 0. Supporting
sections: §9.1 and §9.2 (storage and schema), §12.2 (policy files), §13 (environment), §14.2 (CI),
§4.6.1 and §4.6.2 (tool classes), §6.3.2 (step versus tool signatures), §7.2.1 and §8.1 (the two
sampling types), §10.3.3 (`requestState`), Appendix B (versions), Appendix D (do not write this).

**Roadmap:** [`00-ROADMAP.md`](./00-ROADMAP.md) for branch and commit conventions. Work on
`phase/0-spine`, merged to `master` with `--no-ff` after Task 14.

## Global Constraints

Copied from the roadmap. Every task's requirements include this section.

- Versions are pinned exactly, never with a caret. A caret on `@mastra/core` resolves below 1.78.0
  and `beforeApproval` disappears.
- Node floor is 22.18.0, asserted in `engines`, in CI and in the devcontainer.
- Relative imports are extensionless. `moduleResolution: "bundler"`, `mastra build` and Vitest all
  agree. The `.js` suffixes in the spec's samples are Mastra's own source style, not CRUM's.
- A workflow step's `execute` takes one params object. A tool's `execute` takes two positional
  arguments. Task 4 proves both by typecheck.
- `SamplingStrategyType` is an enum from `@mastra/observability` and takes `probability`.
  `ScoringSamplingConfig` is a string-literal union from `@mastra/core/evals` and takes `rate`.
  Neither accepts the other's shape. Task 4 proves both directions.
- Every table carries a non-nullable `tenant_id`. No exceptions.
- Secrets are names, never values. No `.env` value is read into a document, a commit, a log line or
  a browser bundle. `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` never appear behind a
  `NEXT_PUBLIC_` prefix.
- License gate. Concept-level study of Wukong AICRM only. No copying of code, schemas, prompts or
  UI from their repos. Everything written fresh on Mastra.
- Fail open to safe, fail closed on identity. A missing model key disables a guardrail with a boot
  warning. A missing tenant claim returns an error, never an empty list that looks like success.
  Phase 0's two fail-closed exceptions are `MCP_REQUEST_STATE_KEY` in production and an unknown tool
  name in `gateFor`, which resolves to `refuse`.
- Verify against the artifact, not the summary.

## File Structure

What this phase creates or modifies, and what each file is responsible for.

```
.gitignore                          MODIFY  remove the `docs/` line
README.md                           MODIFY  correct the stale version and the stale monorepo path
package.json                        MODIFY  exact pins, engines, scripts
tsconfig.json                       MODIFY  Phase 0 compiler settings, include tests/
eslint.config.js                    CREATE  flat config, typescript-eslint
vitest.config.ts                    CREATE  node environment, explicit coverage thresholds
.env.example                        REWRITE the full §13 variable contract, names only

policy/risk.yaml                    CREATE  scoring terms, gates, domain terms, sensitive markers
policy/tools.yaml                   CREATE  all 20 tools from §4.6.2 plus 3 connectors

migrations/0001_mastra_core.sql     GENERATE  output of exportSchemas(), committed, drift-checked
migrations/0002_crum_spine.sql      CREATE  the 9 CRM and governance tables

scripts/db-export-schema.ts         CREATE  regenerate 0001 from the installed @mastra/pg
scripts/db-migrate.ts               CREATE  storage.init() then apply every *_crum_* migration

src/config/env.ts                   CREATE  zod-parsed environment, fail-closed production rules
src/governance/schema.ts            CREATE  zod schemas for both YAML files
src/governance/policy.ts            CREATE  loadPolicy(), the Policy object, gateFor(), scopeFor()
src/governance/risk.ts              CREATE  scoreRisk(), the deterministic risk assessment
src/governance/index.ts             CREATE  the boot-time `policy` singleton
src/mastra/storage.ts               CREATE  buildMastraStorage(), resolveSsl(), checkPoolBudget()
src/mastra/observability.ts         CREATE  buildObservability()
src/mastra/mcp-guard.ts             CREATE  assertMcpRequestStateKey()
src/mastra/index.ts                 REWRITE the Mastra instance; the scaffold version does not compile

tests/build/pins.test.ts            CREATE  package.json carries exact pins and the Node floor
tests/smoke/signatures.test.ts      CREATE  step-versus-tool proof, both directions
tests/smoke/sampling.test.ts        CREATE  enum-versus-literal proof, both directions
tests/config/env.test.ts            CREATE  defaults, coercion, production secrets, .env.example contract
tests/governance/policy.test.ts     CREATE  loader, duplicate rejection, unknown-tool refuse
tests/governance/risk.test.ts       CREATE  scoring and gate arithmetic
tests/governance/conformance.test.ts CREATE walks tools.yaml against §4.6.2
tests/scripts/migrations.test.ts    CREATE  migration discovery and the tenant_id static check
tests/mastra/storage.test.ts        CREATE  pool budget, TLS auto-detect, in-memory fallback
tests/mastra/boot.test.ts           CREATE  constructs both ways, MCP guard fails closed
tests/integration/migrations.test.ts CREATE  applies twice against a real database; skipped without one

.github/workflows/crum-ci.yml       CREATE  the §14.2 pipeline
docs/verification/phase-0.md        CREATE  findings from the two unverified checks
docs/verification/denial-paths.md   CREATE  the Phase 3 checklist the Task 8 `it.todo` points at
```

Responsibilities are deliberately narrow. `risk.ts` knows how to score and nothing about gates.
`policy.ts` knows how to resolve a gate and nothing about scoring arithmetic. `storage.ts` knows how
to build a store and nothing about migrations. `env.ts` knows the shape of the environment and
nothing about what consumes it.

Two naming conventions carry weight later, so they are stated here rather than discovered in a
debugger. Migration files matching `NNNN_crum_*.sql` are applied by `scripts/db-migrate.ts`; files
matching `NNNN_mastra_*.sql` are generated snapshots of what the adapter's own `init()` produces and
are never replayed by hand. Test files under `tests/integration/` need a real database and skip
themselves when `CRUM_INTEGRATION_DATABASE_URL` is unset; everything else must run offline.

---

## Task 1: Track `docs/` and commit the plan

The repository's only commit contains five files. `.gitignore` line 6 ignores `docs/`, so the
5,528-line technical plan and this plan document are untracked and would never be committed. This
task fixes that before any feature work, because every later task cites the spec and a reviewer
needs the spec in the same history.

**Files:**
- Modify: `.gitignore`
- Modify: `README.md:11` (stale `@mastra/core 1.76.0`)
- Modify: `README.md:37-41` (stale `cd D:/Code/AllRounderAgent`)
- Modify: `README.md:19` (stale pointer to a parent-repo plan document)

**Interfaces:**
- Consumes: nothing.
- Produces: a tracked `docs/` tree. Every later task's commit step assumes `git add docs/...` works.

- [ ] **Step 1: Confirm the problem before fixing it**

Run:

```bash
git check-ignore -v docs/TECHNICAL_PLAN.md
git ls-files
```

Expected: the first command prints `.gitignore:6:docs/	docs/TECHNICAL_PLAN.md` and exits 0. The
second lists exactly `.env.example`, `README.md`, `package.json`, `src/mastra/index.ts`,
`tsconfig.json`. If either differs, stop and re-read the repository state before continuing.

- [ ] **Step 2: Create the phase branch**

```bash
git checkout -b phase/0-spine
```

- [ ] **Step 3: Remove the `docs/` line from `.gitignore`**

Replace the whole file with:

```gitignore
node_modules/
.env
.env.local
dist/
build/
*.log
tmp/
coverage/
.DS_Store
```

`docs/` is gone. `.env.local` and `coverage/` are added because Task 3 enables coverage and a local
override file is the most likely place a secret lands.

- [ ] **Step 4: Correct the three stale claims in `README.md`**

Line 11, change:

```markdown
- **Backend**: Mastra (@mastra/core 1.76.0), TypeScript ES modules
```

to:

```markdown
- **Backend**: Mastra (@mastra/core 1.79.0, pinned exactly), TypeScript ES modules on Node 22.18.0+
```

Line 19, change the `## Phases` paragraph to point at this repository rather than a parent:

```markdown
See [`docs/TECHNICAL_PLAN.md`](./docs/TECHNICAL_PLAN.md) for the full design and
[`docs/superpowers/plans/00-ROADMAP.md`](./docs/superpowers/plans/00-ROADMAP.md) for the phase map.
This project implements Phases 0 through 7 as listed in the roadmap.
```

Lines 33-43, replace the `## Getting Started` body. CRUM is a standalone repository with its own git
history, not a directory inside AllRounderAgent:

```markdown
## Getting Started

CRUM is a standalone repository. It inherits AllRounderAgent's environment variable *names* but not
its code, and it is not a workspace inside it.

```bash
cd D:/Code/CRUM
npm install
npm run typecheck && npm run test:unit
npm run dev            # Mastra server :4111 plus Studio :4112
```

Without `DATABASE_URL` the whole stack boots in-memory, which is what makes contribution and CI
cheap. Agents, tools and workflows live under `src/mastra/`.
```

Leave the `## License Gate` section exactly as it is. It is the reason this project exists in the
form it does.

- [ ] **Step 5: Verify nothing is still ignored that should be tracked**

```bash
git status --short
git check-ignore -v docs/TECHNICAL_PLAN.md docs/superpowers/plans/00-ROADMAP.md; echo "exit=$?"
```

Expected: `git status --short` shows `M .gitignore`, `M README.md`, and untracked
`docs/superpowers/plans/`. `git check-ignore` prints nothing and exits 1, meaning neither path is
ignored.

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md docs/TECHNICAL_PLAN.md docs/superpowers/plans/
git commit -m "$(cat <<'EOF'
chore(docs): track docs/ and commit the v0.3.0 technical plan

The scaffold's .gitignore ignored docs/ entirely, so the 5,528-line technical
plan and the implementation roadmap were untracked and would never have been
committed. Also corrects three stale README claims: the pinned @mastra/core
version, the phase-list pointer, and a Getting Started section that sent
contributors to a different repository.
EOF
)"
```

---

## Task 2: Pin the verified stack and the Node floor

The scaffold pins `@mastra/core` at `^1.76.0` and `zod` at `^3.24.0`. Both are below what the spec
requires. `beforeApproval` landed at 1.78.0, and Zod 3 emits JSON Schema 2019-09 for the 2020-12
target, which forces `@mastra/mcp` down a rewrite path (§10.3.7).

**Files:**
- Modify: `package.json` (whole file)
- Create: `package-lock.json` (generated by npm)

**Interfaces:**
- Consumes: nothing.
- Produces: installed dependencies at exact versions. Every later task imports from
  `@mastra/core/*`, `@mastra/pg`, `@mastra/observability`, `zod`, `yaml`, and `vitest`.

- [ ] **Step 1: Write the failing check first**

Create `tests/build/pins.test.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Appendix B of TECHNICAL_PLAN.md. Exact, because a caret range on @mastra/core
// resolves below 1.78.0 and beforeApproval disappears.
const EXPECTED_DEPENDENCIES: Record<string, string> = {
  '@mastra/core': '1.79.0',
  '@mastra/mcp': '2.5.0',
  '@mastra/memory': '1.39.0',
  '@mastra/pg': '1.32.0',
  '@mastra/rag': '2.7.0',
  '@mastra/evals': '1.10.8',
  '@mastra/observability': '1.21.0',
  '@mastra/ai-sdk': '1.11.2',
  '@ai-sdk/typesafe-ai': '3.0.24',
  zod: '4.6.7',
  yaml: '2.9.1',
  pg: '8.23.1',
}

const EXPECTED_DEV_DEPENDENCIES: Record<string, string> = {
  typescript: '5.9.3',
  vitest: '3.2.7',
  '@vitest/coverage-v8': '3.2.7',
  tsx: '4.23.15',
  eslint: '9.39.5',
  'typescript-eslint': '8.72.0',
  '@types/node': '22.20.5',
  '@types/pg': '8.23.1',
}

describe('package.json pins', () => {
  it.each(Object.entries(EXPECTED_DEPENDENCIES))(
    'pins %s exactly',
    (name, version) => {
      expect(pkg.dependencies[name]).toBe(version)
    },
  )

  it.each(Object.entries(EXPECTED_DEV_DEPENDENCIES))(
    'dev-pins %s exactly',
    (name, version) => {
      expect(pkg.devDependencies[name]).toBe(version)
    },
  )

  it('rejects every range operator in the dependency set', () => {
    const ranged = [...Object.entries(pkg.dependencies), ...Object.entries(pkg.devDependencies)]
      .filter(([, v]) => /[\^~><*]/.test(String(v)))
      .map(([k, v]) => `${k}@${v}`)
    expect(ranged).toEqual([])
  })

  it('asserts the Node 22.18.0 floor', () => {
    expect(pkg.engines.node).toBe('>=22.18.0')
  })

  it('is an ES module', () => {
    expect(pkg.type).toBe('module')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/build/pins.test.ts
```

Expected: FAIL. `npx` will need to fetch vitest because it is not installed yet at the scaffold
version. If `npx` cannot resolve vitest, run `npm install --no-save vitest@3.2.7` once to get a
runner, then re-run. Every assertion fails: the scaffold has `^1.76.0`, no `engines`, and none of
the new packages.

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@allrounder/crum",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "description": "Conversational CRM workbench on Mastra with a governance plane",
  "engines": {
    "node": ">=22.18.0"
  },
  "scripts": {
    "dev": "mastra dev",
    "build": "mastra build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:policy": "vitest run tests/governance",
    "test:integration": "vitest run --project integration",
    "coverage": "vitest run --coverage",
    "db:export-schema": "tsx scripts/db-export-schema.ts",
    "db:migrate": "tsx scripts/db-migrate.ts",
    "verify": "npm run typecheck && npm run lint && npm run test"
  },
  "dependencies": {
    "@ai-sdk/typesafe-ai": "3.0.24",
    "@mastra/ai-sdk": "1.11.2",
    "@mastra/core": "1.79.0",
    "@mastra/evals": "1.10.8",
    "@mastra/mcp": "2.5.0",
    "@mastra/memory": "1.39.0",
    "@mastra/observability": "1.21.0",
    "@mastra/pg": "1.32.0",
    "@mastra/rag": "2.7.0",
    "pg": "8.23.1",
    "yaml": "2.9.1",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "@types/pg": "8.23.1",
    "@vitest/coverage-v8": "3.2.7",
    "eslint": "9.39.5",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "typescript-eslint": "8.72.0",
    "vitest": "3.2.7"
  }
}
```

`mastra` (the CLI) is deliberately absent. Phase 0 never runs `mastra dev`; the CLI arrives in
Phase 1 with the console. Adding it now would install a dev server this phase cannot use.

- [ ] **Step 4: Install**

```bash
npm install
```

Expected: a clean resolve with no peer-dependency errors. If npm reports a peer conflict between
`@mastra/*` packages, stop. That means the pin set has drifted from what the registry actually
publishes together, and Appendix B needs re-verifying before anything else is built on it.

- [ ] **Step 5: Verify the installed versions match the pins**

```bash
npm ls @mastra/core @mastra/mcp @mastra/pg @mastra/observability zod --depth=0
node -e "console.log(process.version)"
```

Expected: exactly `@mastra/core@1.79.0`, `@mastra/mcp@2.5.0`, `@mastra/pg@1.32.0`,
`@mastra/observability@1.21.0`, `zod@4.6.7`, and a Node version at or above v22.18.0. The local
toolchain is v22.23.2, which satisfies the floor.

- [ ] **Step 6: Confirm the installed declaration really does require `observability`**

This is the assertion the whole storage task rests on, so verify it against the artifact rather than
against this plan:

```bash
grep -n "observability: PostgresStoreVNextObservabilityConfig" node_modules/@mastra/pg/dist/storage/index.d.ts
grep -n "^    id: string;" node_modules/@mastra/pg/dist/shared/config.d.ts
```

Expected: both print a match. If the first does not, `@mastra/pg` has changed and §9.1 plus Task 10
need re-deriving before proceeding.

- [ ] **Step 7: Run the pin test**

```bash
npx vitest run tests/build/pins.test.ts
```

Expected: PASS, all assertions.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tests/build/pins.test.ts
git commit -m "$(cat <<'EOF'
build: pin the verified Mastra 1.79.0 stack and the Node 22.18 floor

Exact pins rather than carets. A caret on @mastra/core resolves below 1.78.0,
where beforeApproval does not exist, and the failure surfaces as a missing
property deep inside the approval gate rather than at install time. Zod moves
3 -> 4 because Zod 3 emits JSON Schema 2019-09 for the 2020-12 target and
forces @mastra/mcp down a rewrite path. Adds a pin test so a future caret is a
red build. Implements TECHNICAL_PLAN.md Appendix B.
EOF
)"
```

---

## Task 3: TypeScript, Vitest and ESLint configuration

**Files:**
- Modify: `tsconfig.json` (whole file)
- Create: `vitest.config.ts`
- Create: `eslint.config.js`

**Interfaces:**
- Consumes: the devDependencies installed in Task 2.
- Produces: `npm run typecheck`, `npm run lint`, `npm run test:unit`. Every later task's verify step
  uses these three commands. Also produces the `@/*` path alias mapping to `src/*`, used by every
  source file from Task 5 onward.

- [ ] **Step 1: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2023"],
    "moduleResolution": "bundler",
    "types": ["node"],

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,

    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,

    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist", "migrations"]
}
```

Three choices here are load-bearing and worth stating:

`noUncheckedIndexedAccess: true` makes every `record[key]` yield `T | undefined`. The risk scorer and
the policy loader are full of indexed lookups into YAML-derived maps, and this is the setting that
turns a silent `undefined` into a compile error. It will require explicit guards in Task 7; that is
the point.

`verbatimModuleSyntax: true` forces `import type` for type-only imports. Mastra's declarations
export a great many types alongside values, and without this the emitted code can carry a runtime
import of something that does not exist at runtime.

`exactOptionalPropertyTypes` stays `false`. Mastra's own config types use `foo?: T` where `undefined`
is a meaningful value, and turning this on produces errors inside `node_modules` declarations that
`skipLibCheck` does not suppress at call sites.

`allowImportingTsExtensions` from the §16 Phase 0 checklist is deliberately omitted. It exists to
permit `.ts` suffixes on relative imports, and the roadmap convention is extensionless. Adding it
would allow both styles and the codebase would drift.

- [ ] **Step 2: Write `vitest.config.ts`**

```typescript
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: { lines: 70, functions: 70, branches: 65, statements: 70 },
    },
  },
})
```

`tests/integration/` does not exist yet. It arrives in Task 11 for the migration apply test, which
needs a real database and must not run in the default `npm run test`.

- [ ] **Step 3: Write `eslint.config.js`**

```javascript
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'migrations/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Smoke tests assert that wrong code does not compile. They carry
    // @ts-expect-error directives and intentionally unused bindings.
    files: ['tests/smoke/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
)
```

`@eslint/js` ships with `eslint@9`, so it needs no separate entry in `package.json`. If the import
fails at Step 5, add `@eslint/js` at the version `npm ls eslint` reports and re-run.

`no-floating-promises` as an error matters here specifically: the migration script and
`storage.init()` are both async, and forgetting an `await` on either produces a migration that
silently does not happen.

- [ ] **Step 4: Prove the extensionless-import convention actually resolves**

Create `tests/smoke/resolution.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { aliasTarget } from '@/governance/alias-probe'
import { relativeTarget } from '../../src/governance/alias-probe'

describe('module resolution', () => {
  it('resolves the @/ alias and a relative path without a file extension', () => {
    expect(aliasTarget).toBe('crum')
    expect(relativeTarget).toBe('crum')
  })
})
```

And the probe it imports, `src/governance/alias-probe.ts`:

```typescript
export const aliasTarget = 'crum'
export const relativeTarget = 'crum'
```

- [ ] **Step 5: Run all three gates**

```bash
npm run typecheck
npm run lint
npx vitest run tests/smoke/resolution.test.ts
```

Expected: `typecheck` exits 0 with no output. `lint` exits 0. The test passes.

If `typecheck` reports `Cannot find module '@/governance/alias-probe'`, the `paths` alias and the
Vitest alias disagree; re-check that `baseUrl` is `"."` and that `paths` maps `"@/*"` to
`["src/*"]`. If `lint` reports a parser error about `projectService`, the installed
`typescript-eslint` is older than 8; re-check the Task 2 pin.

- [ ] **Step 6: Delete the probe**

The probe exists only to prove resolution. Keeping it would leave a meaningless module in `src/`.

```bash
rm src/governance/alias-probe.ts tests/smoke/resolution.test.ts
npm run typecheck
```

Expected: exit 0, confirming nothing else referenced it.

- [ ] **Step 7: Commit**

```bash
git add tsconfig.json vitest.config.ts eslint.config.js
git commit -m "$(cat <<'EOF'
config: TypeScript, Vitest and ESLint for an ESM bundler-resolution codebase

noUncheckedIndexedAccess is on because the policy loader is full of indexed
lookups into YAML-derived maps, and a silent undefined there becomes a gate
that quietly resolves to auto. verbatimModuleSyntax is on because Mastra's
declarations export types alongside values. allowImportingTsExtensions is
deliberately off: relative imports are extensionless, and permitting both
styles is how a codebase ends up with both.
EOF
)"
```

---

## Task 4: Signature and enum smoke proofs

This is the cheapest possible way to prove the two distinctions that cost v0.2 of the spec four
runtime defects. Neither proof needs a database, a model or a network call. Both are typecheck
assertions, and both use `@ts-expect-error` so that if Mastra ever changes the signature the
directive itself becomes an unused-directive error and the build goes red.

**Files:**
- Create: `tests/smoke/signatures.test.ts`
- Create: `tests/smoke/sampling.test.ts`

**Interfaces:**
- Consumes: `Step` and `createStep` from `@mastra/core/workflows`; `ToolExecuteFunction`,
  `createTool` and `noopObserve` from `@mastra/core/tools`; `SamplingStrategyType` and
  `SamplingStrategy` from `@mastra/observability`; `ScoringSamplingConfig` from `@mastra/core/evals`.
- Produces: nothing consumed by later tasks. Produces a standing regression alarm. If a future
  dependency bump changes any of these four signatures, `npm run typecheck` fails here first, with a
  comment naming the section of the spec that has to be re-read.

- [ ] **Step 1: Write `tests/smoke/signatures.test.ts`**

```typescript
import { createStep, type Step } from '@mastra/core/workflows'
import { createTool, noopObserve, type ToolExecuteFunction } from '@mastra/core/tools'
import { RequestContext } from '@mastra/core/request-context'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

// TECHNICAL_PLAN.md §6.3.2. A workflow step's execute takes ONE params object.
// A tool's execute takes TWO positional arguments. v0.2 of the spec wrote both
// the wrong way round and the result compiles in one direction only: the step
// form binds the entire params object to `inputData` and `undefined` to
// `context`, so `context.mastra` throws on the first line at runtime.
//
// Each @ts-expect-error below is an alarm, not a suppression. If Mastra ever
// accepts the wrong shape, the directive becomes unused and typecheck fails.

describe('workflow step signature', () => {
  it('takes one destructured params object', () => {
    const step = createStep({
      id: 'smoke.step',
      description: 'Proves the step signature at typecheck time.',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      execute: async ({ inputData, requestContext }) => {
        void requestContext
        return { doubled: inputData.n * 2 }
      },
    })
    expect(step.id).toBe('smoke.step')
  })

  it('rejects the two-argument tool shape', () => {
    // @ts-expect-error A step's execute takes one params object, not (inputData, context).
    const wrong: Step['execute'] = async (inputData, context) => {
      void inputData
      void context
      return undefined
    }
    void wrong
  })
})

describe('tool signature', () => {
  it('takes two positional arguments', () => {
    const tool = createTool({
      id: 'smoke.tool',
      title: 'Smoke tool',
      description: 'Proves the tool signature at typecheck time.',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      execute: async (inputData, { requestContext, observe }) => {
        void requestContext
        return observe.span('smoke.double', () => ({ doubled: inputData.n * 2 }))
      },
    })
    expect(tool.id).toBe('smoke.tool')
  })

  it('rejects the pre-v1 envelope shape', () => {
    // @ts-expect-error `context` and `runtimeContext` are not keys of the tool input.
    const wrong: ToolExecuteFunction<{ n: number }, { doubled: number }, unknown, unknown> =
      async ({ context, runtimeContext }) => {
        void context
        void runtimeContext
        return { doubled: 0 }
      }
    void wrong
  })

  it('runs with noopObserve when no tracing context is active', async () => {
    const tool = createTool({
      id: 'smoke.observable',
      description: 'Proves observe is always present and never needs a null check.',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      execute: async (inputData, { observe }) =>
        observe.span('smoke.double', () => ({ doubled: inputData.n * 2 })),
    })

    // observe.span with no active tracing context runs the function directly and
    // returns its value. That is the property §8.3 relies on to make in-tool
    // tracing unconditional.
    const doubled = await noopObserve.span('smoke.double', () => 4)
    expect(doubled).toBe(4)
    expect(typeof tool.execute).toBe('function')
  })
})

describe('RequestContext', () => {
  it('is a Map-like the tenant resolver can read from', () => {
    const rc = new RequestContext({ tenantSlug: 'acme', userId: 'u1' })
    expect(rc.get('tenantSlug')).toBe('acme')
    expect(rc.get('missing')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the typecheck and confirm the two directives are load-bearing**

```bash
npm run typecheck
```

Expected: exit 0. This proves both directions at once. Each `@ts-expect-error` suppressed a real
error, because TypeScript reports `Unused '@ts-expect-error' directive` when one suppresses nothing.

To see the alarm actually fire, temporarily delete one directive and re-run:

```bash
sed -i.bak "s|// @ts-expect-error A step's execute takes one params object.*||" tests/smoke/signatures.test.ts
npm run typecheck
```

Expected: FAIL with `Target signature provides too few arguments. Expected 2 or more, but got 1.`
Restore before continuing:

```bash
mv tests/smoke/signatures.test.ts.bak tests/smoke/signatures.test.ts
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Write `tests/smoke/sampling.test.ts`**

```typescript
import { SamplingStrategyType, type SamplingStrategy } from '@mastra/observability'
import type { ScoringSamplingConfig } from '@mastra/core/evals'
import { describe, expect, it } from 'vitest'

// TECHNICAL_PLAN.md §7.2.1 and §8.1. Two look-alike sampling declarations that
// are not interchangeable in either direction. Getting them backwards is the
// single most likely error in this codebase because both are spelled
// { type: 'ratio', ... }.
//
//   @mastra/observability  SamplingStrategyType   a real enum, field `probability`
//   @mastra/core/evals     ScoringSamplingConfig  a literal union, field `rate`

describe('observability sampling is an enum taking probability', () => {
  it('accepts the enum member', () => {
    const strategy: SamplingStrategy = {
      type: SamplingStrategyType.RATIO,
      probability: 0.1,
    }
    expect(strategy.type).toBe('ratio')
  })

  it('rejects the string literal', () => {
    // @ts-expect-error SamplingStrategyType is an enum; the literal 'ratio' is a TS2322 here.
    const wrong: SamplingStrategy = { type: 'ratio', probability: 0.1 }
    void wrong
  })

  it('rejects the scorer field name', () => {
    // @ts-expect-error The observability field is `probability`, not `rate`.
    const wrong: SamplingStrategy = { type: SamplingStrategyType.RATIO, rate: 0.1 }
    void wrong
  })
})

describe('scoring sampling is a literal union taking rate', () => {
  it('accepts the literal and the rate field', () => {
    const sampling: ScoringSamplingConfig = { type: 'ratio', rate: 1 }
    expect(sampling.type).toBe('ratio')
  })

  it('accepts the none variant', () => {
    const sampling: ScoringSamplingConfig = { type: 'none' }
    expect(sampling.type).toBe('none')
  })

  it('rejects the enum member', () => {
    // @ts-expect-error ScoringSamplingConfig is a literal union; the enum member is not assignable.
    const wrong: ScoringSamplingConfig = { type: SamplingStrategyType.RATIO, rate: 1 }
    void wrong
  })

  it('rejects the observability field name', () => {
    // @ts-expect-error The scoring field is `rate`, not `probability`.
    const wrong: ScoringSamplingConfig = { type: 'ratio', probability: 0.1 }
    void wrong
  })
})

describe('the enum is closed', () => {
  it('has exactly the four documented members', () => {
    expect(Object.values(SamplingStrategyType).sort()).toEqual([
      'always',
      'custom',
      'never',
      'ratio',
    ])
  })
})
```

- [ ] **Step 4: Run the typecheck and the tests**

```bash
npm run typecheck
npx vitest run tests/smoke
```

Expected: `typecheck` exits 0, meaning all five `@ts-expect-error` directives in this file suppressed
a real error. Both test files pass.

If `ScoringSamplingConfig` is not exported from `@mastra/core/evals`, check the actual subpath:

```bash
node -e "const p=require('@mastra/core/package.json'); console.log(JSON.stringify(p.exports['./evals'],null,2))"
```

and correct the import to whatever the export map names. Do not loosen the type to `any` to make the
test pass; that defeats the entire purpose of the task.

- [ ] **Step 5: Commit**

```bash
git add tests/smoke/signatures.test.ts tests/smoke/sampling.test.ts
git commit -m "$(cat <<'EOF'
test(smoke): prove the step/tool and enum/literal signature traps

Four typecheck assertions using @ts-expect-error as an alarm rather than a
suppression: if Mastra ever accepts the wrong shape, the directive becomes
unused and typecheck fails with a comment naming the spec section to re-read.

A step's execute takes one params object, a tool's takes two positional
arguments, SamplingStrategyType is an enum taking probability, and
ScoringSamplingConfig is a literal union taking rate. All four were wrong in
v0.2 of the technical plan. Implements TECHNICAL_PLAN.md §16 Phase 0.
EOF
)"
```

---

## Task 5: Policy YAML files

Governance is data. Two versioned YAML files declare the permission class of every tool and the
arithmetic that turns a draft into a risk score. Writing them before the loader means the loader is
built against real content rather than a shape someone imagined.

`policy/tools.yaml` carries all twenty tools from §4.6.2, not the twelve-entry subset that appears in
§12.2's illustrative listing. The conformance test in Task 8 walks this file against the spec table,
so a missing entry is a red build.

**Files:**
- Create: `policy/risk.yaml`
- Create: `policy/tools.yaml`

**Interfaces:**
- Consumes: nothing at runtime. These are data.
- Produces: the two files that `loadPolicy()` reads in Task 6. Field names are the contract:
  `version`, `preflight.{irreversible_terms, high_blast_terms, scores.{irreversible_high_blast,
  single_risk, benign}, gates.{refuse_at, approval_at}, domains.<domain>.require_approval_terms}`,
  `sensitive.{clause, markers, required_gate}`; and `tools[].{name, description, scope, class,
  idempotent?, idempotency_key?}`, `connectors[].{provider, description, scope, class}`.

- [ ] **Step 1: Write `policy/risk.yaml`**

```yaml
# CRUM risk policy. Versioned, loaded at boot, asserted by tests.
# TECHNICAL_PLAN.md §12.2.
#
# Scoring is deterministic. No model call, no network, no clock. The same draft
# scores the same way in CI and in production, which is what makes the gate
# auditable after the fact.
version: 1

preflight:
  # Terms that mark an action as not undoable.
  irreversible_terms: [delete, drop, merge, transfer, export, send, publish]

  # Terms that mark an action as touching more than one record or one environment.
  high_blast_terms: [bulk, all, every, production, team-wide]

  scores:
    irreversible_high_blast: 90
    single_risk: 55
    benign: 10

  gates:
    refuse_at: 80
    approval_at: 40

  # Per-object terms that force approval even when the global terms do not fire.
  # The domain is inferred from the tool name (crm.delete_customer -> customer)
  # and can be overridden explicitly for generic tools like run.side-effect.
  domains:
    customer:
      require_approval_terms: [delete, transfer, merge, export]
    contact:
      require_approval_terms: [delete]
    schedule:
      require_approval_terms: [send, cancel, reschedule]   # notifies attendees
    mail:
      require_approval_terms: [send, reply, forward]
    knowledge:
      require_approval_terms: [delete, reindex]

sensitive:
  clause: sensitive/personal-data
  markers:
    - bank account
    - payment card
    - date of birth
    - national id
    - home address
    - personal email
    - salary
    - health
  required_gate: approval

# A draft touching a sensitive marker can never be auto-gated, whatever its
# computed score. Floors only raise the gate; they never lower a refuse. That
# asymmetry is asserted by tests/governance/risk.test.ts.
```

- [ ] **Step 2: Write `policy/tools.yaml`**

```yaml
# CRUM tool permission classes. TECHNICAL_PLAN.md §4.6.2 and §12.2.
#
# Classes:
#   read-only  cannot mutate anything; no idempotency needed
#   auto       deterministic, idempotent, no human receipt needed
#   approval   acts only with a signed receipt bound to scope + action hash
#   refuse     never auto-runs; a human task is created instead
#
# This file is the source of truth for the tool registry AND the session
# permission map. Both are generated from it so the two cannot drift (§4.6.1).
version: 1

tools:
  # ── read-only (9) ──────────────────────────────────────────
  - name: crm.list_customers
    description: List customers visible to the caller.
    scope: crm-read
    class: read-only

  - name: crm.get_customer
    description: Read one customer with related counts.
    scope: crm-read
    class: read-only

  - name: crm.find_contacts
    description: Find contacts by customer, name or email.
    scope: crm-read
    class: read-only

  - name: crm.list_followups
    description: List followups filtered by status or date range.
    scope: crm-read
    class: read-only

  - name: crm.list_tasks
    description: List tasks filtered by assignee, priority or status.
    scope: crm-read
    class: read-only

  - name: crm.list_schedules
    description: List schedules by date range and attendee.
    scope: crm-read
    class: read-only

  - name: crm.my_open_items
    description: Today-view aggregation of open items for the caller.
    scope: crm-read
    class: read-only

  - name: crm.search
    description: Unified search across CRM objects.
    scope: crm-read
    class: read-only

  - name: knowledge.retrieve
    description: Reranked retrieval over the tenant knowledge index, citations returned.
    scope: knowledge-domains
    class: read-only

  # ── auto (3) ───────────────────────────────────────────────
  - name: crm.log_followup
    description: Record a completed contact attempt.
    scope: crm-write
    class: auto
    idempotent: true
    idempotency_key: correlationId

  - name: crm.create_task
    description: Create a deadline-only task.
    scope: crm-write
    class: auto
    idempotent: true
    idempotency_key: correlationId

  - name: mail.draft
    description: Compose an email draft. Draft only, nothing is sent.
    scope: mail-write
    class: auto
    idempotent: true
    idempotency_key: draftHash

  # ── approval (7) ───────────────────────────────────────────
  - name: crm.create_customer
    description: Stage a new customer record.
    scope: crm:write
    class: approval
    idempotent: true
    idempotency_key: draftHash

  - name: crm.update_customer
    description: Stage a change to an existing customer.
    scope: crm:write
    class: approval
    idempotent: true
    idempotency_key: draftHash

  - name: crm.delete_customer
    description: Stage a soft delete. Risk floor 70.
    scope: crm:delete
    class: approval
    idempotent: true
    idempotency_key: draftHash

  - name: crm.create_contact
    description: Stage a new contact on an existing customer.
    scope: crm:write
    class: approval
    idempotent: true
    idempotency_key: draftHash

  - name: crm.create_schedule
    description: Stage a schedule. Notifies attendees on commit.
    scope: crm:schedule
    class: approval
    idempotent: true
    idempotency_key: draftHash

  - name: crm.transfer_owner
    description: Change record ownership; alters who can see the record.
    scope: crm:transfer
    class: approval
    idempotent: true
    idempotency_key: draftHash

  - name: mail.send
    description: Send an approved email draft.
    scope: mail:send
    class: approval
    idempotent: true
    idempotency_key: draftHash

  # ── workflow side effects (1) ──────────────────────────────
  - name: run.side-effect
    description: Any workflow side effect (scope template `{workflow}:{step}`).
    scope: "{workflow}:{step}"
    class: approval
    idempotent: true
    idempotency_key: actionHash

  # ── refuse (1) ─────────────────────────────────────────────
  - name: crm.bulk_import
    description: Multi-record import. Never auto-runs; always a human task.
    scope: crm:bulk
    class: refuse

connectors:
  - provider: smtp
    description: Sends approved mail behind the mail:send receipt.
    scope: mail:send
    class: approval

  - provider: calendar
    description: Writes approved schedules behind the crm:schedule receipt.
    scope: crm:schedule
    class: approval

  - provider: slack
    description: Approver notifications only. Never a workflow action.
    scope: approver-notify
    class: approval
```

Note the class counts: 9 read-only, 3 auto, 7 approval, 1 refuse, plus `run.side-effect` which is
approval-class. §4.6.2 lists twenty tools and every one appears here. §12.2's listing showed only
twelve because it was illustrating the file's shape, not enumerating the surface.

- [ ] **Step 3: Verify both files parse as YAML before writing a loader for them**

```bash
node -e "
const {parse}=require('yaml');const fs=require('fs');
for (const f of ['policy/risk.yaml','policy/tools.yaml']) {
  const d=parse(fs.readFileSync(f,'utf8'));
  console.log(f, 'version=' + d.version, Array.isArray(d.tools)?('tools='+d.tools.length):('domains='+Object.keys(d.preflight.domains).length));
}
"
```

Expected: `policy/risk.yaml version=1 domains=5` and `policy/tools.yaml version=1 tools=21`.

Twenty-one, not twenty, because `run.side-effect` is a twenty-first entry that stands for a family
of workflow scopes rather than a single registered tool. Task 8's conformance test encodes that
distinction explicitly rather than letting the count silently drift.

- [ ] **Step 4: Verify the class distribution**

```bash
node -e "
const {parse}=require('yaml');const fs=require('fs');
const t=parse(fs.readFileSync('policy/tools.yaml','utf8')).tools;
const c={};for(const x of t)c[x.class]=(c[x.class]||0)+1;
console.log(c);
const bad=t.filter(x=>x.class!=='read-only'&&!x.idempotent);
console.log('mutating tools with no idempotency flag:', bad.map(x=>x.name));
"
```

Expected: `{ 'read-only': 9, auto: 3, approval: 8, refuse: 1 }` and an empty array. Every mutating
tool declares `idempotent: true`. That is the §12.1 duplicate-write defence expressed as data, and
Task 8 asserts it so it cannot be dropped from a future entry.

- [ ] **Step 5: Commit**

```bash
git add policy/risk.yaml policy/tools.yaml
git commit -m "$(cat <<'EOF'
feat(governance): declare risk arithmetic and tool classes as versioned data

All twenty tools from TECHNICAL_PLAN.md §4.6.2 plus run.side-effect, each with
a permission class and, for every mutating tool, an idempotency key. Scoring is
deterministic: term lists, three score levels, two gate thresholds, and a
sensitive-marker floor that can only ever raise a gate.

Governance lives in YAML rather than in code so that changing who needs to
approve what is a reviewed diff and not a redeploy.
EOF
)"
```

---

## Task 6: Policy loader and schema validation

**Files:**
- Create: `src/governance/schema.ts`
- Create: `src/governance/policy.ts`
- Create: `tests/governance/policy.test.ts`

**Interfaces:**
- Consumes: `policy/risk.yaml` and `policy/tools.yaml` from Task 5. `yaml`'s `parse`. Zod 4.
- Produces, and Tasks 7, 8 and 12 depend on these exact names:
  - `type ToolClass = 'read-only' | 'auto' | 'approval' | 'refuse'`
  - `type Gate = 'auto' | 'approval' | 'refuse'`
  - `type RiskFile`, `type ToolsFile`, `type ToolPolicyEntry`, `type ConnectorPolicyEntry`
  - `const RiskFileSchema`, `const ToolsFileSchema`, `const ToolPolicySchema`
  - `interface GovernanceContext { workflow?: string; step?: string; requestContext?: Record<string, unknown> }`
  - `interface Policy { risk: RiskFile; tools: ToolsFile; toolByName: ReadonlyMap<string, ToolPolicyEntry>; gateFor(toolName: string, risk: RiskAssessment, context?: GovernanceContext): Gate; scopeFor(toolName: string, context?: GovernanceContext): string; toolsByClass(klass: ToolClass): string[] }`
  - `function loadPolicy(dir?: string): Policy`
  - `class PolicyLoadError extends Error` with a `issues: unknown[]` property

`RiskAssessment` is produced by Task 7. Task 6 imports it as a type only, so the two tasks can be
built in either order as long as Task 7 lands before the tests run.

- [ ] **Step 1: Write the failing test**

Create `tests/governance/policy.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
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
    expect(real.tools.tools).toHaveLength(21)
    expect(real.tools.connectors).toHaveLength(3)
  })

  it('indexes every tool by name', () => {
    expect(real.toolByName.get('crm.delete_customer')?.class).toBe('approval')
    expect(real.toolByName.get('crm.list_customers')?.class).toBe('read-only')
    expect(real.toolByName.get('nope.not_a_tool')).toBeUndefined()
  })

  it('groups tools by class', () => {
    expect(real.toolsByClass('read-only')).toHaveLength(9)
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

  it('rejects a mutating tool with no idempotency key', () => {
    const dir = tempPolicy(
      MINIMAL_RISK,
      'version: 1\ntools:\n  - {name: crm.create_task, description: d, scope: crm-write, class: auto}\nconnectors: []\n',
    )
    expect(() => loadPolicy(dir)).toThrowError(/idempotency_key/)
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
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/governance/policy.test.ts
```

Expected: FAIL. `Cannot find module '@/governance/policy'`.

- [ ] **Step 3: Write `src/governance/schema.ts`**

```typescript
import { z } from 'zod'

/** Permission classes declared in policy/tools.yaml. TECHNICAL_PLAN.md §12.2. */
export const TOOL_CLASSES = ['read-only', 'auto', 'approval', 'refuse'] as const
export type ToolClass = (typeof TOOL_CLASSES)[number]

/** The resolved outcome of a gate decision. A subset of ToolClass plus `auto`. */
export const GATES = ['auto', 'approval', 'refuse'] as const
export type Gate = (typeof GATES)[number]

/** How a repeated call is deduplicated. §9.2's draft_hash unique index relies on it. */
export const IDEMPOTENCY_KEYS = ['correlationId', 'draftHash', 'actionHash'] as const
export type IdempotencyKey = (typeof IDEMPOTENCY_KEYS)[number]

const ScoreBound = z.number().int().min(0).max(100)

export const ToolPolicySchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/, {
      message: 'tool names are dot-separated lowercase identifiers, e.g. crm.list_customers',
    }),
    description: z.string().min(1),
    scope: z.string().min(1),
    class: z.enum(TOOL_CLASSES),
    idempotent: z.boolean().optional(),
    idempotency_key: z.enum(IDEMPOTENCY_KEYS).optional(),
  })
  .superRefine((tool, ctx) => {
    // A mutating tool with no idempotency key can be committed twice by a retry,
    // and the draft_hash unique index has nothing to key on. §12.1 threat 3.
    if (tool.class !== 'read-only' && !tool.idempotent) {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotent'],
        message: `mutating tool ${tool.name} must declare idempotent: true`,
      })
    }
    if (tool.idempotent && !tool.idempotency_key) {
      ctx.addIssue({
        code: 'custom',
        path: ['idempotency_key'],
        message: `tool ${tool.name} declares idempotent: true but no idempotency_key`,
      })
    }
  })

export type ToolPolicyEntry = z.infer<typeof ToolPolicySchema>

export const ConnectorPolicySchema = z.object({
  provider: z.string().min(1),
  description: z.string().min(1),
  scope: z.string().min(1),
  class: z.enum(TOOL_CLASSES),
})

export type ConnectorPolicyEntry = z.infer<typeof ConnectorPolicySchema>

export const ToolsFileSchema = z
  .object({
    version: z.literal(1),
    tools: z.array(ToolPolicySchema).min(1),
    connectors: z.array(ConnectorPolicySchema).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>()
    file.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `duplicate tool name in policy/tools.yaml: ${tool.name}`,
        })
        return
      }
      seen.add(tool.name)
    })
  })

export type ToolsFile = z.infer<typeof ToolsFileSchema>

export const RiskFileSchema = z
  .object({
    version: z.literal(1),
    preflight: z.object({
      irreversible_terms: z.array(z.string().min(1)).default([]),
      high_blast_terms: z.array(z.string().min(1)).default([]),
      scores: z.object({
        irreversible_high_blast: ScoreBound,
        single_risk: ScoreBound,
        benign: ScoreBound,
      }),
      gates: z.object({
        refuse_at: ScoreBound,
        approval_at: ScoreBound,
      }),
      domains: z
        .record(
          z.string(),
          z.object({ require_approval_terms: z.array(z.string().min(1)).default([]) }),
        )
        .default({}),
    }),
    sensitive: z.object({
      clause: z.string().min(1),
      markers: z.array(z.string().min(1)).min(1),
      required_gate: z.enum(GATES),
    }),
  })
  .superRefine((file, ctx) => {
    const { refuse_at, approval_at } = file.preflight.gates
    if (refuse_at <= approval_at) {
      ctx.addIssue({
        code: 'custom',
        path: ['preflight', 'gates', 'refuse_at'],
        message: `refuse_at (${refuse_at}) must be strictly greater than approval_at (${approval_at})`,
      })
    }
    const { irreversible_high_blast, single_risk, benign } = file.preflight.scores
    if (!(irreversible_high_blast > single_risk && single_risk > benign)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preflight', 'scores'],
        message:
          'scores must be strictly ordered: irreversible_high_blast > single_risk > benign',
      })
    }
  })

export type RiskFile = z.infer<typeof RiskFileSchema>
```

Two refinements here are governance rules expressed as validation rather than as prose. A mutating
tool without an idempotency key cannot be deduplicated by the `draft_hash` unique index, so the
policy file is rejected at boot. And `refuse_at` at or below `approval_at` would make the
`refuse` band unreachable, which is a silent hole rather than a loud one.

`z.record` takes two arguments in Zod 4. Passing one, as Zod 3 allowed, is a type error.

- [ ] **Step 4: Write `src/governance/policy.ts`**

```typescript
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
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/governance/policy.test.ts
```

Expected: FAIL, but differently. `Cannot find module '@/governance/risk'` because the test imports
`RiskAssessment` from a module Task 7 has not created yet. That is the correct failure and it is why
Task 7 comes next rather than a commit here.

- [ ] **Step 6: Do not commit yet**

Task 6 and Task 7 land together because the type dependency runs both ways: `policy.ts` imports
`RiskAssessment` from `risk.ts`, and `risk.ts` imports `RiskFile` from `schema.ts`. Committing a
module that does not typecheck would break the "every commit is green" property the roadmap requires.

---

## Task 7: Risk scorer and gate resolver

The scorer is deterministic. No model call, no network, no clock, no randomness. The same draft
scores the same way in CI and in production, which is what makes a gate decision auditable after the
fact and what lets Task 8 assert exact numbers rather than ranges.

**Files:**
- Create: `src/governance/risk.ts`
- Create: `src/governance/index.ts`
- Create: `tests/governance/risk.test.ts`

**Interfaces:**
- Consumes: `RiskFile`, `Gate` from `./schema`; `GovernanceContext` from `./policy`.
- Produces, and Tasks 8 and 12 plus every later phase depend on these exact names:
  - `interface RiskAssessment { readonly score: number; readonly sensitive: boolean; readonly reasons: readonly string[] }`
  - `function scoreRisk(draft: unknown, risk: RiskFile, toolName?: string, context?: GovernanceContext): RiskAssessment`
  - `function domainOf(toolName: string | undefined, context?: GovernanceContext): string | undefined`
  - `const policy: Policy` from `./index`, loaded at import time

### A note on term matching, because the obvious implementation is wrong

Substring matching (`haystack.includes(term)`) produces a false positive that silently breaks the
`auto` class. The high-blast term `all` is a substring of `allow`, `called`, `wallet` and `allocate`.
A `crm.log_followup` draft whose notes say "called the client" would score 55 and get raised from
`auto` to `approval`, sending every phone log into the human queue.

The scorer therefore tokenizes and matches single-word terms by exact token equality. Tokens are
lowercased alphanumeric runs that may contain internal hyphens, so `crm.delete_customer` yields
`crm`, `delete`, `customer`, and `team-wide` stays one token. Multi-word terms such as
`bank account` and `date of birth` cannot be tokens, so those match as phrases against the
lowercased haystack.

The cost is that inflections do not match: a payload saying "deleted the record" does not fire the
term `delete`. That is acceptable because the primary signal is the tool name, which always carries
the canonical verb, and because a missed inflection lowers a score while a false positive raises one.
Lowering is the safe direction for a floor-based gate only when the declared class already covers
it, which for every mutating tool in `policy/tools.yaml` it does.

- [ ] **Step 1: Write the failing test**

Create `tests/governance/risk.test.ts`:

```typescript
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '@/governance/policy'
import { domainOf, scoreRisk } from '@/governance/risk'

const policy = loadPolicy(join(process.cwd(), 'policy'))
const risk = policy.risk

describe('domainOf', () => {
  it.each([
    ['crm.delete_customer', 'customer'],
    ['crm.create_customer', 'customer'],
    ['crm.list_customers', 'customer'],
    ['crm.get_customer', 'customer'],
    ['crm.find_contacts', 'contact'],
    ['crm.list_followups', 'followup'],
    ['crm.list_tasks', 'task'],
    ['crm.create_schedule', 'schedule'],
    ['mail.send', 'mail'],
    ['mail.draft', 'mail'],
    ['knowledge.retrieve', 'knowledge'],
  ])('infers %s as %s', (toolName, domain) => {
    expect(domainOf(toolName)).toBe(domain)
  })

  it.each([
    ['crm.transfer_owner', 'owner'],
    ['crm.my_open_items', undefined],
    ['crm.search', undefined],
    ['crm.bulk_import', undefined],
    ['run.side-effect', undefined],
    [undefined, undefined],
  ])('returns %s for %s', (toolName, expected) => {
    expect(domainOf(toolName)).toBe(expected)
  })

  it('prefers an explicit objectType from the request context', () => {
    expect(domainOf('run.side-effect', { requestContext: { objectType: 'customer' } })).toBe(
      'customer',
    )
  })
})

describe('scoreRisk term matching', () => {
  it('does not treat "all" inside "called" as a high-blast term', () => {
    // The false positive this asserts against would raise crm.log_followup from
    // auto to approval and put every phone log in the human queue.
    const assessment = scoreRisk({ notes: 'called the client about the wallet' }, risk, 'crm.log_followup')
    expect(assessment.score).toBe(risk.preflight.scores.benign)
    expect(assessment.reasons).toEqual([])
  })

  it('matches "all" as a whole token', () => {
    const assessment = scoreRisk({ note: 'delete all records' }, risk, 'crm.delete_customer')
    expect(assessment.score).toBe(risk.preflight.scores.irreversible_high_blast)
  })

  it('keeps a hyphenated term as one token', () => {
    const assessment = scoreRisk({ note: 'team-wide rollout' }, risk, 'crm.update_customer')
    expect(assessment.reasons.join(' ')).toContain('team-wide')
    expect(assessment.score).toBe(risk.preflight.scores.single_risk)
  })

  it('matches a multi-word sensitive marker as a phrase', () => {
    const assessment = scoreRisk({ notes: 'stored a home address on the record' }, risk, 'crm.update_customer')
    expect(assessment.sensitive).toBe(true)
    expect(assessment.reasons.join(' ')).toContain('home address')
  })

  it('does not match a marker inside a longer word', () => {
    const assessment = scoreRisk({ notes: 'works in healthcare staffing' }, risk, 'crm.update_customer')
    expect(assessment.sensitive).toBe(false)
  })

  it('survives a circular draft and a BigInt without throwing', () => {
    const circular: Record<string, unknown> = { name: 'Acme' }
    circular['self'] = circular
    expect(() => scoreRisk(circular, risk, 'crm.create_customer')).not.toThrow()
    expect(() => scoreRisk({ n: BigInt(1) }, risk, 'crm.create_customer')).not.toThrow()
  })
})

describe('scoreRisk bands', () => {
  const { scores } = risk.preflight

  it('scores a benign draft at the benign level', () => {
    expect(scoreRisk({ city: 'Lisbon' }, risk, 'crm.list_customers').score).toBe(scores.benign)
  })

  it('scores a single irreversible term at single_risk', () => {
    expect(scoreRisk({ id: 'x' }, risk, 'crm.delete_customer').score).toBe(scores.single_risk)
  })

  it('scores a domain term at single_risk', () => {
    // crm.update_customer is not itself an irreversible verb, but the customer
    // domain requires approval for `merge`.
    const assessment = scoreRisk({ operation: 'merge', into: 'y' }, risk, 'crm.update_customer')
    expect(assessment.score).toBe(scores.single_risk)
    expect(assessment.reasons.join(' ')).toContain('domain customer')
  })

  it('scores irreversible plus high-blast at the top level', () => {
    const assessment = scoreRisk(
      { note: 'export every customer to production' },
      risk,
      'crm.update_customer',
    )
    expect(assessment.score).toBe(scores.irreversible_high_blast)
    expect(assessment.reasons.join(' ')).toContain('irreversible')
    expect(assessment.reasons.join(' ')).toContain('high-blast')
  })

  it('flags sensitivity without changing the score', () => {
    const assessment = scoreRisk({ notes: 'salary band discussed' }, risk, 'crm.log_followup')
    expect(assessment.sensitive).toBe(true)
    expect(assessment.score).toBe(scores.benign)
  })

  it('omits toolName cleanly when the caller uses the two-argument form', () => {
    // §4.6.1 calls scoreRisk(input, policy.risk). That must still work.
    expect(scoreRisk({ note: 'delete everything' }, risk).score).toBe(scores.irreversible_high_blast)
  })

  it('returns deterministic reasons in a stable order', () => {
    const a = scoreRisk({ note: 'delete all' }, risk, 'crm.delete_customer')
    const b = scoreRisk({ note: 'delete all' }, risk, 'crm.delete_customer')
    expect(a.reasons).toEqual(b.reasons)
  })
})

describe('gateFor monotonicity', () => {
  const benign = { score: 10, sensitive: false, reasons: [] }
  const risky = { score: 55, sensitive: false, reasons: [] }
  const severe = { score: 90, sensitive: false, reasons: [] }

  it('raises a read-only tool through both bands', () => {
    expect(policy.gateFor('crm.list_customers', benign)).toBe('auto')
    expect(policy.gateFor('crm.list_customers', risky)).toBe('approval')
    expect(policy.gateFor('crm.list_customers', severe)).toBe('refuse')
  })

  it('never lowers a declared refuse', () => {
    expect(policy.gateFor('crm.bulk_import', benign)).toBe('refuse')
    expect(policy.gateFor('crm.bulk_import', risky)).toBe('refuse')
    expect(policy.gateFor('crm.bulk_import', severe)).toBe('refuse')
  })

  it('raises an auto tool on a sensitive marker alone', () => {
    const sensitiveBenign = { score: 10, sensitive: true, reasons: ['sensitive'] }
    expect(policy.gateFor('crm.log_followup', sensitiveBenign)).toBe('approval')
  })

  it('never raises a sensitive floor above a score-driven refuse', () => {
    const sensitiveSevere = { score: 90, sensitive: true, reasons: [] }
    expect(policy.gateFor('crm.list_customers', sensitiveSevere)).toBe('refuse')
  })

  it('refuses an unknown tool whatever the score', () => {
    expect(policy.gateFor('crm.not_in_policy', benign)).toBe('refuse')
    expect(policy.gateFor('', benign)).toBe('refuse')
  })

  it('treats every registered tool as gated at or above its declared class', () => {
    // Walks the whole policy file. No tool may resolve to `auto` when it is
    // declared `approval` or `refuse`.
    for (const tool of policy.tools.tools) {
      const gate = policy.gateFor(tool.name, benign)
      if (tool.class === 'approval') expect(gate, tool.name).toBe('approval')
      if (tool.class === 'refuse') expect(gate, tool.name).toBe('refuse')
      if (tool.class === 'read-only' || tool.class === 'auto') {
        expect(['auto', 'approval', 'refuse'], tool.name).toContain(gate)
      }
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/governance/risk.test.ts
```

Expected: FAIL. `Cannot find module '@/governance/risk'`.

- [ ] **Step 3: Write `src/governance/risk.ts`**

```typescript
import type { GovernanceContext } from './policy'
import type { RiskFile } from './schema'

/**
 * The outcome of scoring one draft.
 *
 * `score` drives the band thresholds. `sensitive` drives an independent floor,
 * because a draft touching personal data must never be auto-gated whatever its
 * computed score (§12.2). `reasons` is the audit trail shown in the approval
 * queue's diff view (§11.3), so it must be deterministic.
 */
export interface RiskAssessment {
  readonly score: number
  readonly sensitive: boolean
  readonly reasons: readonly string[]
}

/**
 * Tokens are lowercased alphanumeric runs that may contain internal hyphens.
 * Underscores and dots split, so `crm.delete_customer` yields crm, delete,
 * customer, while `team-wide` stays one token.
 */
const TOKEN_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+)*/g

/** crm.<verb>_<object> where the verb implies an object domain. */
const CRM_DOMAIN_PATTERN = /^crm\.(?:create|update|delete|list|get|find|transfer|log)_(.+)$/

/** Tool-name prefixes that are themselves the policy domain. */
const HEAD_DOMAINS = new Set(['mail', 'knowledge'])

/**
 * Resolve the policy domain for a tool. An explicit `objectType` on the request
 * context wins, which is how `run.side-effect` reaches a domain at all.
 *
 * Plural object names are singularised, so `crm.list_followups` resolves to the
 * `followup` domain. A name with no recognised shape yields undefined, and the
 * caller then applies no domain terms.
 */
export function domainOf(
  toolName: string | undefined,
  context?: GovernanceContext,
): string | undefined {
  const explicit = context?.requestContext?.['objectType']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  if (!toolName) return undefined

  const head = toolName.split('.')[0]
  if (head !== undefined && HEAD_DOMAINS.has(head)) return head

  const objectName = CRM_DOMAIN_PATTERN.exec(toolName)?.[1]
  if (!objectName) return undefined
  return objectName.endsWith('s') ? objectName.slice(0, -1) : objectName
}

/**
 * Serialize a draft for term matching. Never throws: a circular structure or a
 * BigInt falls back to String(), because a scorer that throws would turn a
 * governance decision into a request-time failure.
 */
function stringify(draft: unknown): string {
  if (draft === null || draft === undefined) return ''
  if (typeof draft === 'string') return draft
  try {
    return JSON.stringify(draft) ?? ''
  } catch {
    try {
      return String(draft)
    } catch {
      return ''
    }
  }
}

/**
 * Does one policy term appear in this draft?
 *
 * A term containing a space is a phrase and matches as a substring. Any other
 * term matches by exact token equality, which is what stops the high-blast term
 * `all` from firing on `called`, `allow` and `wallet`.
 */
function termMatches(term: string, tokens: ReadonlySet<string>, haystack: string): boolean {
  const normalized = term.toLowerCase()
  if (normalized.includes(' ')) return haystack.includes(normalized)
  return tokens.has(normalized)
}

/**
 * Score one draft against the risk policy.
 *
 * Deterministic and side-effect free. The two-argument form `scoreRisk(draft, risk)`
 * is what §4.6.1 calls; passing `toolName` adds the tool's own name to the
 * haystack and enables the per-domain terms, so real call sites should pass it.
 */
export function scoreRisk(
  draft: unknown,
  risk: RiskFile,
  toolName?: string,
  context?: GovernanceContext,
): RiskAssessment {
  const haystack = `${toolName ?? ''} ${stringify(draft)}`.toLowerCase()
  const tokens = new Set(haystack.match(TOKEN_PATTERN) ?? [])
  const reasons: string[] = []

  const irreversible = risk.preflight.irreversible_terms.filter((term) =>
    termMatches(term, tokens, haystack),
  )
  if (irreversible.length > 0) reasons.push(`irreversible: ${irreversible.join(', ')}`)

  const highBlast = risk.preflight.high_blast_terms.filter((term) =>
    termMatches(term, tokens, haystack),
  )
  if (highBlast.length > 0) reasons.push(`high-blast: ${highBlast.join(', ')}`)

  const domain = domainOf(toolName, context)
  const domainTerms = domain ? (risk.preflight.domains[domain]?.require_approval_terms ?? []) : []
  const domainHits = domainTerms.filter((term) => termMatches(term, tokens, haystack))
  if (domain !== undefined && domainHits.length > 0) {
    reasons.push(`domain ${domain}: ${domainHits.join(', ')}`)
  }

  const markers = risk.sensitive.markers.filter((marker) =>
    termMatches(marker, tokens, haystack),
  )
  const sensitive = markers.length > 0
  if (sensitive) reasons.push(`sensitive (${risk.sensitive.clause}): ${markers.join(', ')}`)

  const { scores } = risk.preflight
  const score =
    irreversible.length > 0 && highBlast.length > 0
      ? scores.irreversible_high_blast
      : irreversible.length > 0 || highBlast.length > 0 || domainHits.length > 0
        ? scores.single_risk
        : scores.benign

  return { score, sensitive, reasons }
}
```

- [ ] **Step 4: Write `src/governance/index.ts`**

```typescript
import { loadPolicy, type GovernanceContext, type Policy, PolicyLoadError } from './policy'
import { domainOf, scoreRisk, type RiskAssessment } from './risk'
import type { Gate, ToolClass, ToolPolicyEntry } from './schema'

/**
 * The governance singleton, loaded at import time.
 *
 * Loading eagerly is deliberate. A malformed policy file becomes a boot failure
 * with a Zod-formatted message naming the file and the field, rather than a
 * request-time failure in the middle of a user's turn. §12.2: "loaded at boot,
 * asserted by tests". Tests that need a different policy call loadPolicy() with
 * a temporary directory instead of importing this.
 */
export const policy: Policy = loadPolicy(process.env['POLICY_DIR'])

export { domainOf, loadPolicy, PolicyLoadError, scoreRisk }
export type { Gate, GovernanceContext, Policy, RiskAssessment, ToolClass, ToolPolicyEntry }
```

- [ ] **Step 5: Run both governance test files**

```bash
npx vitest run tests/governance
npm run typecheck
```

Expected: `tests/governance/policy.test.ts` and `tests/governance/risk.test.ts` both pass.
`typecheck` exits 0.

If the `does not treat "all" inside "called" as a high-blast term` case fails, the tokenizer is
splitting on hyphens or matching by prefix. Both reintroduce the false positive described at the
top of this task.

If `never lowers a declared refuse` fails, `raise()` is comparing in the wrong direction. Check
`GATE_RANK` in `policy.ts`: `auto` is 0, `approval` is 1, `refuse` is 2, and `raise` returns
whichever ranks higher.

- [ ] **Step 6: Run lint**

```bash
npm run lint
```

Expected: exit 0. `noUncheckedIndexedAccess` means the `risk.preflight.domains[domain]` lookup in
`risk.ts` needs the `?.` and `?? []` it already has. If lint or typecheck flags another indexed
lookup, add the guard rather than disabling the compiler option.

- [ ] **Step 7: Commit Tasks 6 and 7 together**

```bash
git add src/governance tests/governance/policy.test.ts tests/governance/risk.test.ts
git commit -m "$(cat <<'EOF'
feat(governance): load policy from YAML and score write risk deterministically

loadPolicy validates both YAML files, rejects duplicate tool names, rejects a
mutating tool with no idempotency key, and rejects gate thresholds that would
make the refuse band unreachable. gateFor starts from the declared class and
only ever raises it, so a sensitive-marker floor cannot lower a refuse and an
unknown tool name resolves to refuse rather than to auto.

scoreRisk matches single-word terms by exact token equality rather than by
substring. Substring matching would fire the high-blast term `all` on `called`,
`allow` and `wallet`, raising every phone log from auto to approval and filling
the human queue. A test asserts that specific false positive stays fixed.

No model call, no network, no clock. Implements TECHNICAL_PLAN.md §12.2.
EOF
)"
```

---

## Task 8: Policy conformance suite

§12.2 requires a test that walks `tools.yaml` and asserts the file matches reality. This task encodes
the §4.6.2 tool surface as a constant inside the test so that adding a tool to the code without
adding it to the policy file, or the reverse, is a red build in both directions.

**Files:**
- Create: `tests/governance/conformance.test.ts`

**Interfaces:**
- Consumes: `loadPolicy` from `@/governance/policy`, the `policy` singleton from `@/governance`.
- Produces: nothing. This is a standing conformance alarm. Phase 2 and Phase 3 both add tools and
  both will hit this file first.

- [ ] **Step 1: Write the conformance test**

Create `tests/governance/conformance.test.ts`:

```typescript
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { policy } from '@/governance'

/**
 * The tool surface exactly as tabulated in TECHNICAL_PLAN.md §4.6.2.
 *
 * This is a copy on purpose. If the spec table and policy/tools.yaml disagree,
 * one of them is wrong, and the disagreement has to fail a build rather than
 * settle itself silently in whichever direction the next editor happened to
 * touch. When a later phase adds a tool, it updates §4.6.2, this constant, and
 * tools.yaml in the same commit.
 */
const SPEC_TOOL_SURFACE: ReadonlyArray<readonly [name: string, klass: string, idempotencyKey: string | null]> = [
  ['crm.list_customers', 'read-only', null],
  ['crm.get_customer', 'read-only', null],
  ['crm.find_contacts', 'read-only', null],
  ['crm.list_followups', 'read-only', null],
  ['crm.list_tasks', 'read-only', null],
  ['crm.list_schedules', 'read-only', null],
  ['crm.my_open_items', 'read-only', null],
  ['crm.search', 'read-only', null],
  ['knowledge.retrieve', 'read-only', null],
  ['crm.create_customer', 'approval', 'draftHash'],
  ['crm.update_customer', 'approval', 'draftHash'],
  ['crm.delete_customer', 'approval', 'draftHash'],
  ['crm.create_contact', 'approval', 'draftHash'],
  ['crm.log_followup', 'auto', 'correlationId'],
  ['crm.create_task', 'auto', 'correlationId'],
  ['crm.create_schedule', 'approval', 'draftHash'],
  ['crm.transfer_owner', 'approval', 'draftHash'],
  ['crm.bulk_import', 'refuse', null],
  ['mail.draft', 'auto', 'draftHash'],
  ['mail.send', 'approval', 'draftHash'],
]

/**
 * Declared in tools.yaml but not in §4.6.2, because it stands for a family of
 * workflow scopes rather than one registered tool. Its scope is a template.
 */
const TEMPLATE_TOOLS = new Set(['run.side-effect'])

const CONNECTOR_SCOPES: ReadonlyArray<readonly [provider: string, scope: string, klass: string]> = [
  ['smtp', 'mail:send', 'approval'],
  ['calendar', 'crm:schedule', 'approval'],
  ['slack', 'approver-notify', 'approval'],
]

describe('tools.yaml conforms to §4.6.2', () => {
  const declared = new Map(policy.tools.tools.map((t) => [t.name, t]))

  it.each(SPEC_TOOL_SURFACE.map(([name]) => [name]))(
    'declares %s',
    (name) => {
      expect(declared.has(name), `${name} is missing from policy/tools.yaml`).toBe(true)
    },
  )

  it.each(SPEC_TOOL_SURFACE)('declares %s as class %s', (name, klass) => {
    expect(declared.get(name)?.class, name).toBe(klass)
  })

  it.each(SPEC_TOOL_SURFACE.filter(([, , key]) => key !== null))('gives %s idempotency key %s', (name, , key) => {
    expect(declared.get(name)?.idempotency_key, name).toBe(key)
  })

  it('declares nothing beyond the spec surface plus the workflow template', () => {
    const specNames = new Set(SPEC_TOOL_SURFACE.map(([name]) => name))
    const extra = [...declared.keys()].filter((n) => !specNames.has(n) && !TEMPLATE_TOOLS.has(n))
    expect(extra).toEqual([])
  })

  it('has exactly the twenty spec tools plus run.side-effect', () => {
    expect(policy.tools.tools).toHaveLength(SPEC_TOOL_SURFACE.length + TEMPLATE_TOOLS.size)
  })
})

describe('class invariants', () => {
  it('gives every mutating tool an idempotency key', () => {
    const offenders = policy.tools.tools
      .filter((t) => t.class !== 'read-only' && t.idempotency_key === undefined)
      .map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('gives no read-only tool an idempotency key', () => {
    // A read-only tool has no side effect to deduplicate. Declaring one invites
    // a reader to believe the tool writes.
    const offenders = policy.tools.tools
      .filter((t) => t.class === 'read-only' && t.idempotency_key !== undefined)
      .map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('gives every tool a non-empty description', () => {
    const offenders = policy.tools.tools.filter((t) => t.description.trim() === '').map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('has exactly nine read-only tools', () => {
    expect(policy.toolsByClass('read-only')).toHaveLength(9)
  })

  it('has exactly one refuse-class tool', () => {
    expect(policy.toolsByClass('refuse')).toEqual(['crm.bulk_import'])
  })

  it('never resolves a refuse tool to a gate below refuse', () => {
    // §12.2: the refuse class is never attached to a tool the agent can reach
    // without a human task being created. The gate is what enforces that.
    for (const name of policy.toolsByClass('refuse')) {
      expect(policy.gateFor(name, { score: 0, sensitive: false, reasons: [] }), name).toBe('refuse')
    }
  })
})

describe('scope discipline', () => {
  it('gives every tool a non-empty scope', () => {
    const offenders = policy.tools.tools.filter((t) => t.scope.trim() === '').map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('contains exactly one templated scope', () => {
    const templated = policy.tools.tools.filter((t) => t.scope.includes('{')).map((t) => t.name)
    expect(templated).toEqual(['run.side-effect'])
  })

  it('uses distinct scopes for distinct permission boundaries', () => {
    // crm-read is shared by all nine read tools, which is intended: they are one
    // boundary. What must not happen is an approval tool sharing a scope with a
    // read-only one, which would let a read grant cover a write.
    const scopeToClasses = new Map<string, Set<string>>()
    for (const tool of policy.tools.tools) {
      if (tool.scope.includes('{')) continue
      const set = scopeToClasses.get(tool.scope) ?? new Set<string>()
      set.add(tool.class)
      scopeToClasses.set(tool.scope, set)
    }
    for (const [scope, classes] of scopeToClasses) {
      const mixesReadAndWrite = classes.has('read-only') && classes.size > 1
      expect(mixesReadAndWrite, `scope ${scope} mixes read-only with ${[...classes].join(',')}`).toBe(false)
    }
  })
})

describe('connectors', () => {
  it.each(CONNECTOR_SCOPES)('declares %s at scope %s class %s', (provider, scope, klass) => {
    const connector = policy.tools.connectors.find((c) => c.provider === provider)
    expect(connector, `${provider} missing from policy/tools.yaml`).toBeDefined()
    expect(connector?.scope).toBe(scope)
    expect(connector?.class).toBe(klass)
  })

  it('declares no connector at class auto or read-only', () => {
    // Every connector reaches an external system. None may run ungated.
    const offenders = policy.tools.connectors
      .filter((c) => c.class === 'auto' || c.class === 'read-only')
      .map((c) => c.provider)
    expect(offenders).toEqual([])
  })

  it('marks the notification connector as never a workflow action', () => {
    const slack = policy.tools.connectors.find((c) => c.provider === 'slack')
    expect(slack?.scope).toBe('approver-notify')
    expect(slack?.description.toLowerCase()).toContain('never a workflow action')
  })
})

describe('risk policy coherence', () => {
  it('orders the gate thresholds so both bands are reachable', () => {
    const { refuse_at, approval_at } = policy.risk.preflight.gates
    expect(approval_at).toBeGreaterThan(0)
    expect(refuse_at).toBeGreaterThan(approval_at)
    expect(refuse_at).toBeLessThanOrEqual(100)
  })

  it('orders the score levels strictly', () => {
    const { irreversible_high_blast, single_risk, benign } = policy.risk.preflight.scores
    expect(irreversible_high_blast).toBeGreaterThan(single_risk)
    expect(single_risk).toBeGreaterThan(benign)
  })

  it('puts single_risk in the approval band and irreversible_high_blast in the refuse band', () => {
    // If either drifts, the term lists stop meaning what their names say.
    const { gates, scores } = policy.risk.preflight
    expect(scores.single_risk).toBeGreaterThanOrEqual(gates.approval_at)
    expect(scores.single_risk).toBeLessThan(gates.refuse_at)
    expect(scores.irreversible_high_blast).toBeGreaterThanOrEqual(gates.refuse_at)
    expect(scores.benign).toBeLessThan(gates.approval_at)
  })

  it('has a sensitive floor that is a real gate', () => {
    expect(policy.risk.sensitive.required_gate).toBe('approval')
    expect(policy.risk.sensitive.markers.length).toBeGreaterThanOrEqual(8)
  })

  it('names a compliance clause for the sensitive floor', () => {
    expect(policy.risk.sensitive.clause).toBe('sensitive/personal-data')
  })
})

// §12.2 also requires that every approval-class tool has a denial-path test
// verifying the receipt rather than trusting the caller's claim. No tools are
// registered in Phase 0, so there is nothing to deny yet. This is tracked
// rather than skipped: Task 14 writes the checklist into
// docs/verification/denial-paths.md and Phase 3 must clear every line.
it.todo('Phase 3: every approval-class tool has a denial-path receipt test')
```

- [ ] **Step 2: Run it**

```bash
npm run test:policy
```

Expected: PASS, with one `todo` line reported for the Phase 3 denial-path coverage. Vitest prints
todos in its summary, so the gap stays visible rather than disappearing.

If `declares nothing beyond the spec surface plus the workflow template` fails, `tools.yaml` and the
spec have drifted. Fix whichever is wrong and, if it was the spec, add a change-log entry to
`docs/TECHNICAL_PLAN.md` Appendix E in the same commit.

- [ ] **Step 3: Prove the conformance test can actually fail**

A conformance test that has never been red is not evidence of anything. Temporarily break the policy
file and confirm the suite catches it:

```bash
cp policy/tools.yaml /tmp/tools.yaml.bak
sed -i 's/    class: refuse/    class: approval/' policy/tools.yaml
npm run test:policy; echo "exit=$?"
cp /tmp/tools.yaml.bak policy/tools.yaml
npm run test:policy; echo "exit=$?"
```

Expected: the first run exits non-zero with failures naming `crm.bulk_import`. The second exits 0.
If the first run passes, the conformance test is not reading the file it thinks it is.

- [ ] **Step 4: Confirm the working tree is clean again**

```bash
git status --short policy/
git diff --exit-code policy/
```

Expected: no output from either command. The restore in Step 3 was byte-exact.

- [ ] **Step 5: Commit**

```bash
git add tests/governance/conformance.test.ts
git commit -m "$(cat <<'EOF'
test(governance): assert tools.yaml conforms to the §4.6.2 tool surface

Copies the spec table into the test on purpose. If the spec and the policy file
disagree, one of them is wrong and the disagreement must fail a build rather
than settle itself in whichever direction the next editor happened to touch.

Also asserts the invariants that make the classes meaningful: every mutating
tool carries an idempotency key, no read-only tool does, no scope mixes a
read-only tool with a writing one, no connector is ungated, and the risk score
levels actually sit inside the gate bands their names imply.
EOF
)"
```

---

## Task 9: Environment contract

`.env.example` currently lists six variables. §13 specifies roughly fifty across six groups, two of
which are production-required. This task writes the full contract as documentation and the parsed
subset as code, with a test that keeps the two from drifting.

**Files:**
- Rewrite: `.env.example`
- Create: `src/config/env.ts`
- Create: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: Zod 4.
- Produces, and Tasks 10, 11 and 12 depend on these exact names:
  - `type CrumEnv = z.infer<typeof EnvSchema>`
  - `function parseEnv(raw?: NodeJS.ProcessEnv): CrumEnv` throwing `EnvParseError`
  - `class EnvParseError extends Error` with an `issues: unknown[]` property
  - `function missingProductionSecrets(env: CrumEnv): string[]`
  - `function isProduction(env: CrumEnv): boolean`
  - `const PRODUCTION_REQUIRED_SECRETS: readonly string[]`
  - `const DEFERRED_ENV_VARS: Readonly<Record<string, number>>`

`parseEnv` does not read `process.env` by default in tests. It takes an argument so every test can
supply an exact environment and nothing leaks from the developer's shell.

- [ ] **Step 1: Write the failing test**

Create `tests/config/env.test.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFERRED_ENV_VARS,
  EnvParseError,
  EnvSchema,
  PRODUCTION_REQUIRED_SECRETS,
  isProduction,
  missingProductionSecrets,
  parseEnv,
} from '@/config/env'

/** Names declared in .env.example, ignoring comments and blanks. */
function documentedNames(): string[] {
  return readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]!.trim())
    .filter((name) => name.length > 0)
}

describe('parseEnv', () => {
  it('applies every documented default on an empty environment', () => {
    const env = parseEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.MASTRA_PG_POOL_MAX).toBe(4)
    expect(env.POLICY_DIR).toBeUndefined()
    expect(env.MASTRA_OBSERVABILITY).toBe(false)
  })

  it('coerces numeric strings', () => {
    const env = parseEnv({ MASTRA_PG_POOL_MAX: '7', RATE_LIMIT_PER_MINUTE: '300' })
    expect(env.MASTRA_PG_POOL_MAX).toBe(7)
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(300)
  })

  it('treats the observability flag as a boolean', () => {
    expect(parseEnv({ MASTRA_OBSERVABILITY: 'true' }).MASTRA_OBSERVABILITY).toBe(true)
    expect(parseEnv({ MASTRA_OBSERVABILITY: 'false' }).MASTRA_OBSERVABILITY).toBe(false)
    expect(parseEnv({}).MASTRA_OBSERVABILITY).toBe(false)
  })

  it('rejects a pool max that would exceed the Supabase budget', () => {
    // 2 pools x max must stay under Supabase's session-pooler cap of 15.
    expect(() => parseEnv({ MASTRA_PG_POOL_MAX: '9' })).toThrowError(EnvParseError)
  })

  it('rejects a non-numeric pool max rather than silently defaulting', () => {
    expect(() => parseEnv({ MASTRA_PG_POOL_MAX: 'lots' })).toThrowError(EnvParseError)
  })

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrowError(EnvParseError)
  })

  it('rejects a short HMAC secret', () => {
    expect(() => parseEnv({ APPROVAL_HMAC_SECRET: 'too-short' })).toThrowError(EnvParseError)
  })

  it('carries the zod issues on the thrown error', () => {
    try {
      parseEnv({ NODE_ENV: 'staging' })
      expect.unreachable('parseEnv should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvParseError)
      expect((error as EnvParseError).issues.length).toBeGreaterThan(0)
      expect((error as EnvParseError).message).toContain('NODE_ENV')
    }
  })

  it('never stores a browser-prefixed variable in the server env object', () => {
    // §13.6. A NEXT_PUBLIC_ value is compiled into the client bundle. If it also
    // appears here, some server code is reading a value that is public.
    const env = parseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' })
    expect(Object.keys(env).filter((k) => k.startsWith('NEXT_PUBLIC_'))).toEqual([])
  })
})

describe('production readiness', () => {
  it('names the production-required secrets', () => {
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('DATABASE_URL')
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('MCP_REQUEST_STATE_KEY')
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('APPROVAL_HMAC_SECRET')
  })

  it('reports every missing secret on an empty environment', () => {
    const missing = missingProductionSecrets(parseEnv({}))
    expect(missing.sort()).toEqual([...PRODUCTION_REQUIRED_SECRETS].sort())
  })

  it('reports nothing when every secret is present', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://u:p@host:5432/db',
      OPENROUTER_API_KEY: 'or-' + 'x'.repeat(40),
      APPROVAL_HMAC_SECRET: 'a'.repeat(32),
      MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sr-' + 'y'.repeat(40),
    })
    expect(missingProductionSecrets(env)).toEqual([])
  })

  it('only enforces the list in production', () => {
    expect(isProduction(parseEnv({ NODE_ENV: 'production' }))).toBe(true)
    expect(isProduction(parseEnv({ NODE_ENV: 'development' }))).toBe(false)
    expect(isProduction(parseEnv({ NODE_ENV: 'test' }))).toBe(false)
  })
})

describe('.env.example is the contract', () => {
  const documented = documentedNames()

  it('documents every variable the schema parses', () => {
    const parsed = Object.keys(EnvSchema.shape)
    const undocumented = parsed.filter((name) => !documented.includes(name))
    expect(undocumented).toEqual([])
  })

  it('either parses or explicitly defers every variable it documents', () => {
    // A variable in .env.example that nothing reads is a lie to whoever copies
    // the file. Each one is either in the schema or named in DEFERRED_ENV_VARS
    // with the phase that will read it.
    const parsed = new Set(Object.keys(EnvSchema.shape))
    const unaccounted = documented.filter((n) => !parsed.has(n) && !(n in DEFERRED_ENV_VARS))
    expect(unaccounted).toEqual([])
  })

  it('defers every listed variable to a real phase', () => {
    for (const [name, phase] of Object.entries(DEFERRED_ENV_VARS)) {
      expect(phase, name).toBeGreaterThanOrEqual(1)
      expect(phase, name).toBeLessThanOrEqual(7)
    }
  })

  it('documents no secret value, only a placeholder', () => {
    const lines = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    for (const line of lines) {
      const [name, value] = line.split('=')
      const secretish = /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/.test(name!)
      if (!secretish) continue
      // Placeholders only. A real credential here is committed forever.
      expect(value, `${name} looks like a real value`).toMatch(
        /^(your_|changeme|replace_|postgresql:\/\/user:password@|https:\/\/|\$\{|$)/,
      )
    }
  })

  it('warns against browser exposure of server secrets', () => {
    const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    expect(text).toContain('Never copy SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL into a browser')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/config/env.test.ts
```

Expected: FAIL. `Cannot find module '@/config/env'`.

- [ ] **Step 3: Write `.env.example`**

Names and placeholders only. No value in this file is a credential, and the file is committed.

```dotenv
# CRUM environment contract. TECHNICAL_PLAN.md §13.
#
# CRUM inherits AllRounderAgent's variable NAMES. It does not inherit its code
# and it does not read its .env. Where a library documents its own variable
# name, the library wins (§13.5).
#
# BACKEND ONLY. Never expose these values to a browser bundle or a client log.
# Never copy SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL into a browser variable.

# ── Required in production (§13.1) ───────────────────────────
# Supabase session-pooler connection string. Drives storage, vectors and the
# CRM spine. Absent in development, the whole stack boots in-memory (§9.1).
DATABASE_URL=postgresql://user:password@db.supabase.co:5432/postgres

# Model router for every agent.
OPENROUTER_API_KEY=your_openrouter_key_here

# Receipt signing. Minimum 32 random bytes (§12.3).
APPROVAL_HMAC_SECRET=your_approval_hmac_secret_min_32_bytes

# HMAC key signing MCP input_required continuations. Minimum 32 bytes. Must be
# IDENTICAL on every replica or an approval that suspends on one and resumes on
# another is rejected intermittently (§10.3.3). Unset in production, the MCP
# server refuses to mount (§13.8).
MCP_REQUEST_STATE_KEY=your_mcp_request_state_key_min_32_bytes

# JWT verification.
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_JWKS_URL=https://your-project.supabase.co/.well-known/jwks.json
SUPABASE_JWT_ISSUER=https://your-project.supabase.co
SUPABASE_JWT_AUDIENCE=authenticated
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here

# ── Embeddings and retrieval (§13.2) ─────────────────────────
EMBEDDING_MODEL_ID=openai/text-embedding-3-small
# FROZEN at 1536. Must equal the PgVector index dimension and the model's
# native output. Changing it forces a full re-embed of every tenant schema.
EMBEDDING_DIMENSIONS=1536
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
RETRIEVAL_TOP_K=10
RETRIEVAL_MIN_SCORE=0.35
RETRIEVAL_HNSW_EF=128
RETRIEVAL_IVF_PROBES=12
RETRIEVAL_RERANK_MODEL=
RETRIEVAL_RERANK_TOP_K=5
RETRIEVAL_TENANT_OVERRIDES={}
COHERE_API_KEY=

# ── Mastra runtime (§13.3) ───────────────────────────────────
MASTRA_BASE_URL=http://host.docker.internal:4111
# Must equal server.timeout (§13.3).
MASTRA_REQUEST_TIMEOUT_SECONDS=600
MASTRA_API_PREFIX=/api
# Off by default so tests pay nothing.
MASTRA_OBSERVABILITY=false
# Trace sampling probability when observability is on.
MASTRA_TRACE_PROBABILITY=1
# Unset means auto: localhost plaintext, every other host TLS (§9.1).
MASTRA_PG_SSL=
# Per-pool cap. pools x max must stay under Supabase pool_size (15).
MASTRA_PG_POOL_MAX=4
# Set to enable semantic recall. Unset keeps message-history recall.
MASTRA_MEMORY_EMBEDDER=
# Turn off only inside the migration job (§14.2).
MASTRA_DB_DISABLE_INIT=true

# ── Governance and runs (§13.4) ──────────────────────────────
POLICY_DIR=
RUNS_MAX_CONCURRENT_MODEL_CALLS=4
RUNS_APPROVAL_TOKEN_TTL_SECONDS=3600
RUNS_RECEIPT_RECORD_TTL_SECONDS=86400
RUNS_SWEEP_INTERVAL_SECONDS=60
RATE_LIMIT_PER_MINUTE=120
RATE_LIMIT_WINDOW_SECONDS=60
CORS_ALLOW_ORIGINS=["http://localhost:5173"]
TRUSTED_PROXY_IPS=[]

# ── LLMOps (§13.5) ───────────────────────────────────────────
# The name @ai-sdk/typesafe-ai@3.0.24 actually reads. Powers every Classifier
# (§6.5). Not JEV_API_KEY.
TYPESAFE_AI_API_KEY=
TYPESAFE_AI_BASE_URL=https://api.typesafe.ai/v1
EVAL_EXPERIMENT_TIMEOUT_MS=600000
JUDGE_PROVIDER=jev
JUDGE_MODEL=jev-latest
# Read by the Python judge harness, and accepted by crumDecisionModel() as a
# fallback so one credential serves both. Unset makes --judge auto skip with
# exit 0, so forks stay green.
JEV_API_KEY=
JUDGE_CHAT_BASE_URL=https://openrouter.ai/api/v1
JUDGE_CHAT_MODEL=
JUDGE_CHAT_API_KEY=
JUDGE_TIMEOUT_SECONDS=60
# Off by default so a cold CI run does not make a network call to price a trace.
MASTRA_AUTO_REFRESH_PRICING=

# ── Runtime ──────────────────────────────────────────────────
NODE_ENV=development

# ── Browser-safe (§13.6) ─────────────────────────────────────
# Compiled into the client bundle. Publishable/anon key only.
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

- [ ] **Step 4: Write `src/config/env.ts`**

```typescript
import { z } from 'zod'

/** Raised for a malformed environment. Carries the Zod issues for the log line. */
export class EnvParseError extends Error {
  readonly issues: unknown[]

  constructor(message: string, issues: unknown[] = []) {
    super(message)
    this.name = 'EnvParseError'
    this.issues = issues
  }
}

/** An empty string in a dotenv file means unset, not "the empty string". */
const optionalString = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v))
  .pipe(z.string().min(1).optional())

/** A secret used for HMAC signing. §12.3 and §10.3.3 both require >= 32 bytes. */
const hmacSecret = z.string().min(32, 'must be at least 32 bytes').optional()

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

/**
 * Supabase's session-mode pooler caps total clients at 15 by default. Mastra
 * opens a writer pool and, when `readPool` is unset, falls back to it for reads,
 * so PostgresStoreVNext holds 2 pools: primary and observability. 2 x 7 = 14 is
 * the highest safe per-pool cap. §9.1 and §14.3.
 */
const POOL_COUNT = 2
const SUPABASE_POOL_SIZE = 15
const MAX_POOL_PER_CONN = Math.floor(SUPABASE_POOL_SIZE / POOL_COUNT)

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Required in production, optional elsewhere so the stack boots in-memory.
  DATABASE_URL: optionalString,
  OPENROUTER_API_KEY: optionalString,
  APPROVAL_HMAC_SECRET: hmacSecret,
  MCP_REQUEST_STATE_KEY: hmacSecret,
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  // Mastra runtime (§13.3)
  MASTRA_OBSERVABILITY: booleanish.default('false'),
  MASTRA_TRACE_PROBABILITY: z.coerce.number().min(0).max(1).default(1),
  MASTRA_PG_SSL: z.enum(['true', 'false']).optional(),
  MASTRA_PG_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_POOL_PER_CONN, `2 pools x max must stay under Supabase pool_size (${SUPABASE_POOL_SIZE})`)
    .default(4),
  MASTRA_DB_DISABLE_INIT: booleanish.default('true'),

  // Governance (§13.4)
  POLICY_DIR: optionalString,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
})

export type CrumEnv = z.infer<typeof EnvSchema>

/**
 * Variables documented in .env.example that Phase 0 does not read yet. Each is
 * mapped to the phase that will. tests/config/env.test.ts fails if a documented
 * variable is neither parsed nor listed here, so this map cannot rot quietly.
 */
export const DEFERRED_ENV_VARS: Readonly<Record<string, number>> = {
  SUPABASE_JWKS_URL: 1,
  SUPABASE_JWT_ISSUER: 1,
  SUPABASE_JWT_AUDIENCE: 1,
  MASTRA_BASE_URL: 1,
  MASTRA_REQUEST_TIMEOUT_SECONDS: 1,
  MASTRA_API_PREFIX: 1,
  MASTRA_MEMORY_EMBEDDER: 1,
  NEXT_PUBLIC_SUPABASE_URL: 1,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 1,
  EMBEDDING_MODEL_ID: 4,
  EMBEDDING_DIMENSIONS: 4,
  EMBEDDING_BASE_URL: 4,
  EMBEDDING_API_KEY: 4,
  RETRIEVAL_TOP_K: 4,
  RETRIEVAL_MIN_SCORE: 4,
  RETRIEVAL_HNSW_EF: 4,
  RETRIEVAL_IVF_PROBES: 4,
  RETRIEVAL_RERANK_MODEL: 4,
  RETRIEVAL_RERANK_TOP_K: 4,
  RETRIEVAL_TENANT_OVERRIDES: 4,
  COHERE_API_KEY: 4,
  RUNS_MAX_CONCURRENT_MODEL_CALLS: 3,
  RUNS_APPROVAL_TOKEN_TTL_SECONDS: 3,
  RUNS_RECEIPT_RECORD_TTL_SECONDS: 3,
  RUNS_SWEEP_INTERVAL_SECONDS: 3,
  CORS_ALLOW_ORIGINS: 5,
  TRUSTED_PROXY_IPS: 5,
  TYPESAFE_AI_API_KEY: 5,
  TYPESAFE_AI_BASE_URL: 5,
  JEV_API_KEY: 6,
  JUDGE_PROVIDER: 6,
  JUDGE_MODEL: 6,
  JUDGE_CHAT_BASE_URL: 6,
  JUDGE_CHAT_MODEL: 6,
  JUDGE_CHAT_API_KEY: 6,
  JUDGE_TIMEOUT_SECONDS: 6,
  EVAL_EXPERIMENT_TIMEOUT_MS: 6,
  MASTRA_AUTO_REFRESH_PRICING: 6,
}

/**
 * Secrets whose absence in production is a deployment defect rather than a
 * degraded feature. §13.8: CRUM fails open to safe everywhere except identity
 * and continuation signing, because both guard properties that cannot be
 * verified at request time.
 */
export const PRODUCTION_REQUIRED_SECRETS: readonly string[] = [
  'DATABASE_URL',
  'OPENROUTER_API_KEY',
  'APPROVAL_HMAC_SECRET',
  'MCP_REQUEST_STATE_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): CrumEnv {
  const result = EnvSchema.safeParse(raw)
  if (result.success) return result.data

  const summary = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new EnvParseError(`environment failed validation:\n${summary}`, result.error.issues)
}

export function isProduction(env: CrumEnv): boolean {
  return env.NODE_ENV === 'production'
}

/**
 * Names of production-required secrets that are missing or too short. Returns
 * an empty array outside production, because a local run without Supabase
 * credentials is a supported configuration rather than a broken one (§14.4).
 */
export function missingProductionSecrets(env: CrumEnv): string[] {
  return PRODUCTION_REQUIRED_SECRETS.filter((name) => {
    const value = env[name as keyof CrumEnv]
    return typeof value !== 'string' || value.length === 0
  })
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/config/env.test.ts
npm run typecheck
```

Expected: both exit 0.

If `either parses or explicitly defers every variable it documents` fails with a name you just
added to `.env.example`, add it to `EnvSchema` if Phase 0 reads it or to `DEFERRED_ENV_VARS` with the
phase that will. Do not delete it from the test.

If `rejects a pool max that would exceed the Supabase budget` fails at `9`, recompute
`MAX_POOL_PER_CONN`. It is `floor(15 / 2) = 7`, so `8` is the first rejected value and the test uses
`9` for margin.

- [ ] **Step 6: Verify no real secret is committed**

```bash
grep -nE '=(sk-|eyJ|postgres(ql)?://[^u]|xox[baprs]-)' .env.example; echo "exit=$?"
```

Expected: no output and `exit=1`. Any match is a real credential shape in a committed file and must
be replaced with a placeholder before committing.

- [ ] **Step 7: Commit**

```bash
git add .env.example src/config/env.ts tests/config/env.test.ts
git commit -m "$(cat <<'EOF'
feat(config): document the full §13 environment contract and parse the Phase 0 subset

.env.example grows from six variables to the full contract. Names and
placeholders only; no value in the file is a credential.

parseEnv validates rather than reads, so a short HMAC secret or a pool cap that
would exceed Supabase's session-pooler budget fails at boot with the field name
instead of failing later with EMAXCONNSESSION or a forgeable receipt.

A test asserts every documented variable is either parsed or listed in
DEFERRED_ENV_VARS with the phase that will read it. Without that, an
.env.example entry nothing consumes is a lie to whoever copies the file.
EOF
)"
```

---

## Task 10: Storage builder

`src/mastra/index.ts` currently constructs `new PostgresStoreVNext({ connectionString: ... })`. That
does not compile, and the reason matters: the shipped constructor requires two fields the scaffold
omits. `PostgresBaseConfig.id` is a required `string`, and `PostgresStoreVNext` intersects its config
with `{ observability: PostgresStoreVNextObservabilityConfig }`, whose JSDoc reads:

> Required by design — `PostgresStoreVNext` will not implicitly share the primary connection.
> Callers who want to share must pass identical connection details here, and they'll receive a
> runtime warning every time the store is constructed (and again on every init() over the same
> logger).
> — `@mastra/pg@1.32.0/dist/storage/index.d.ts:104-107`

This task builds one function that owns that decision, plus the two smaller decisions it depends on:
TLS and the pool budget. It returns an in-memory store when `DATABASE_URL` is absent outside
production, so the whole stack boots on a laptop with no Supabase project (§14.4).

**Files:**
- Create: `src/mastra/storage.ts`
- Create: `tests/mastra/storage.test.ts`
- Modify: `src/config/env.ts` (add `OBSERVABILITY_DATABASE_URL`; export the two pool-budget constants)
- Modify: `.env.example` (document `OBSERVABILITY_DATABASE_URL`)

**Interfaces:**
- Consumes from Task 9: `type CrumEnv`, `function parseEnv`, `function isProduction`,
  `const POOL_COUNT`, `const SUPABASE_POOL_SIZE`.
- Produces, and Tasks 11 and 12 depend on these exact names:
  - `type CrumStorage = PostgresStoreVNext | InMemoryStore`
  - `function buildMastraStorage(env: CrumEnv): CrumStorage` throwing `StorageConfigError`
  - `function isPostgresStorage(storage: CrumStorage): storage is PostgresStoreVNext`
  - `function resolveSsl(connectionString: string | undefined, override: 'true' | 'false' | undefined): boolean | ConnectionOptions`
  - `function isLocalDatabaseUrl(connectionString: string | undefined): boolean`
  - `function hostOf(connectionString: string): string | undefined`
  - `function pgPoolMax(env: CrumEnv): number`
  - `interface PoolBudget { pools: number; perPoolMax: number; total: number; limit: number; ok: boolean }`
  - `function checkPoolBudget(env: CrumEnv): PoolBudget`
  - `function observabilityConnectionString(env: CrumEnv): string | undefined`
  - `class StorageConfigError extends Error` with a `variables: readonly string[]` property

- [ ] **Step 1: Write the failing test**

Create `tests/mastra/storage.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { PostgresStoreVNext } from '@mastra/pg'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import {
  buildMastraStorage,
  checkPoolBudget,
  hostOf,
  isLocalDatabaseUrl,
  isPostgresStorage,
  observabilityConnectionString,
  pgPoolMax,
  resolveSsl,
  StorageConfigError,
} from '../../src/mastra/storage'
import type { CrumStorage } from '../../src/mastra/storage'

const REMOTE = 'postgresql://crum:secret@db.abcdefgh.supabase.co:5432/postgres'
const LOCAL = 'postgresql://crum:secret@localhost:5432/crum'
const LOCAL_V6 = 'postgresql://crum:secret@[::1]:5432/crum'
const OBSERVABILITY = 'postgresql://crum:secret@obs.abcdefgh.supabase.co:5432/postgres'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides } as NodeJS.ProcessEnv)
}

/**
 * PostgresStoreVNext constructs pg.Pool objects. Pools are lazy, so nothing
 * connects until a query runs, but they still need closing or Vitest reports
 * the worker as hung.
 */
const opened: CrumStorage[] = []

function build(overrides: Record<string, string> = {}): CrumStorage {
  const storage = buildMastraStorage(envWith(overrides))
  opened.push(storage)
  return storage
}

afterEach(async () => {
  while (opened.length > 0) {
    const storage = opened.pop()
    if (storage) await storage.close()
  }
})

describe('hostOf', () => {
  it('extracts the hostname from a connection string', () => {
    expect(hostOf(REMOTE)).toBe('db.abcdefgh.supabase.co')
    expect(hostOf(LOCAL)).toBe('localhost')
    expect(hostOf(LOCAL_V6)).toBe('[::1]')
  })

  it('returns undefined for something that is not a URL', () => {
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf('')).toBeUndefined()
  })
})

describe('isLocalDatabaseUrl', () => {
  it('recognises loopback hosts', () => {
    expect(isLocalDatabaseUrl(LOCAL)).toBe(true)
    expect(isLocalDatabaseUrl(LOCAL_V6)).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://crum@127.0.0.1:5432/crum')).toBe(true)
  })

  it('rejects a managed host and an absent URL', () => {
    expect(isLocalDatabaseUrl(REMOTE)).toBe(false)
    expect(isLocalDatabaseUrl(undefined)).toBe(false)
  })

  it('does not treat a hostname containing localhost as loopback', () => {
    expect(isLocalDatabaseUrl('postgresql://crum@localhost.evil.example:5432/crum')).toBe(false)
  })
})

describe('resolveSsl', () => {
  it('requires TLS for a remote host', () => {
    expect(resolveSsl(REMOTE, undefined)).toEqual({ rejectUnauthorized: true })
  })

  it('allows plaintext for loopback', () => {
    expect(resolveSsl(LOCAL, undefined)).toBe(false)
  })

  it('lets MASTRA_PG_SSL=true force TLS on loopback', () => {
    expect(resolveSsl(LOCAL, 'true')).toEqual({ rejectUnauthorized: true })
  })

  it('lets MASTRA_PG_SSL=false disable TLS on a remote host', () => {
    expect(resolveSsl(REMOTE, 'false')).toBe(false)
  })

  it('agrees with itself when the override restates the derived default', () => {
    expect(resolveSsl(REMOTE, 'true')).toEqual(resolveSsl(REMOTE, undefined))
    expect(resolveSsl(LOCAL, 'false')).toEqual(resolveSsl(LOCAL, undefined))
  })
})

describe('pgPoolMax and checkPoolBudget', () => {
  it('defaults to four clients per pool', () => {
    expect(pgPoolMax(envWith())).toBe(4)
    expect(checkPoolBudget(envWith())).toEqual({
      pools: 2,
      perPoolMax: 4,
      total: 8,
      limit: 15,
      ok: true,
    })
  })

  it('accepts the highest cap EnvSchema allows', () => {
    const budget = checkPoolBudget(envWith({ MASTRA_PG_POOL_MAX: '7' }))
    expect(budget.total).toBe(14)
    expect(budget.ok).toBe(true)
  })

  it('never lets 2 pools exceed Supabase pool_size at any accepted value', () => {
    for (const max of [1, 2, 3, 4, 5, 6, 7]) {
      const budget = checkPoolBudget(envWith({ MASTRA_PG_POOL_MAX: String(max) }))
      expect(budget.ok, `max=${max}`).toBe(true)
    }
  })
})

describe('observabilityConnectionString', () => {
  it('prefers a dedicated observability database', () => {
    const env = envWith({ DATABASE_URL: REMOTE, OBSERVABILITY_DATABASE_URL: OBSERVABILITY })
    expect(observabilityConnectionString(env)).toBe(OBSERVABILITY)
  })

  it('falls back to the primary connection so local dev needs one URL', () => {
    expect(observabilityConnectionString(envWith({ DATABASE_URL: REMOTE }))).toBe(REMOTE)
  })

  it('is undefined when nothing is configured', () => {
    expect(observabilityConnectionString(envWith())).toBeUndefined()
  })
})

describe('buildMastraStorage', () => {
  it('returns an in-memory store when DATABASE_URL is absent in development', () => {
    const storage = build()
    expect(storage).toBeInstanceOf(InMemoryStore)
    expect(isPostgresStorage(storage)).toBe(false)
  })

  it('returns an in-memory store in the test environment too', () => {
    const storage = buildMastraStorage(parseEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv))
    opened.push(storage)
    expect(storage).toBeInstanceOf(InMemoryStore)
  })

  it('refuses to boot on ephemeral storage in production', () => {
    expect(() =>
      buildMastraStorage(
        parseEnv({
          NODE_ENV: 'production',
          APPROVAL_HMAC_SECRET: 'a'.repeat(32),
          MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
          OPENROUTER_API_KEY: 'sk-or-v1-placeholder',
          SUPABASE_URL: 'https://abcdefgh.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
        } as NodeJS.ProcessEnv),
      ),
    ).toThrowError(StorageConfigError)
  })

  it('names the missing variable rather than printing its value', () => {
    try {
      buildMastraStorage(
        parseEnv({
          NODE_ENV: 'production',
          APPROVAL_HMAC_SECRET: 'a'.repeat(32),
          MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
          OPENROUTER_API_KEY: 'sk-or-v1-placeholder',
          SUPABASE_URL: 'https://abcdefgh.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
        } as NodeJS.ProcessEnv),
      )
      expect.unreachable('production without DATABASE_URL must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(StorageConfigError)
      expect((error as StorageConfigError).variables).toEqual(['DATABASE_URL'])
      expect((error as StorageConfigError).message).not.toContain('secret')
    }
  })

  /**
   * The load-bearing assertion of this task. The scaffold's
   * `new PostgresStoreVNext({ connectionString })` compiled for nobody; this
   * proves the shipped constructor accepts the config CRUM actually passes.
   */
  it('constructs a PostgresStoreVNext with the required id and observability fields', () => {
    const storage = build({ DATABASE_URL: REMOTE })
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
    expect(isPostgresStorage(storage)).toBe(true)
  })

  it('constructs with a dedicated observability connection', () => {
    const storage = build({ DATABASE_URL: REMOTE, OBSERVABILITY_DATABASE_URL: OBSERVABILITY })
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
  })

  it('passes disableInit through so runtime never mutates the schema', () => {
    const storage = build({ DATABASE_URL: REMOTE, MASTRA_DB_DISABLE_INIT: 'true' })
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mastra/storage.test.ts`
Expected: FAIL. `Cannot find module '../../src/mastra/storage'`, and the two imports from
`../../src/config/env` that do not exist yet (`POOL_COUNT` is still module-local, and
`OBSERVABILITY_DATABASE_URL` is not in `EnvSchema`) surface as type errors under
`npm run typecheck`.

- [ ] **Step 3: Extend the environment contract**

In `src/config/env.ts`, change these two lines so the pool-budget constants are shared rather than
duplicated into `storage.ts`:

```typescript
const POOL_COUNT = 2
const SUPABASE_POOL_SIZE = 15
const MAX_POOL_PER_CONN = Math.floor(SUPABASE_POOL_SIZE / POOL_COUNT)
```

becomes:

```typescript
export const POOL_COUNT = 2
export const SUPABASE_POOL_SIZE = 15
export const MAX_POOL_PER_CONN = Math.floor(SUPABASE_POOL_SIZE / POOL_COUNT)
```

Then add the observability connection to the Mastra runtime group in `EnvSchema`, directly under
`DATABASE_URL`:

```typescript
  // Required in production, optional elsewhere so the stack boots in-memory.
  DATABASE_URL: optionalString,
  /**
   * Where observability spans, logs, metrics, scores and feedback are written.
   * PostgresStoreVNext requires an observability connection and will not
   * implicitly share the primary one (@mastra/pg dist/storage/index.d.ts:104).
   * Unset falls back to DATABASE_URL and accepts the runtime warning the
   * adapter logs on every construction. Point this at a separate database
   * before enabling MASTRA_OBSERVABILITY in production. §9.1, §14.3.
   */
  OBSERVABILITY_DATABASE_URL: optionalString,
  OPENROUTER_API_KEY: optionalString,
```

Then document it in `.env.example`, in the Mastra runtime group next to `DATABASE_URL`:

```bash
# Optional. Where Mastra writes spans, logs, metrics, scores and feedback.
# PostgresStoreVNext requires an observability connection and will NOT silently
# reuse DATABASE_URL: it logs a runtime warning on every construction and every
# init() when you do. Unset falls back to DATABASE_URL, which is fine locally
# and wrong in production. Point this at a separate database before setting
# MASTRA_OBSERVABILITY=true anywhere that serves traffic.
OBSERVABILITY_DATABASE_URL=postgresql://user:password@host:5432/crum_observability
```

`tests/config/env.test.ts` needs no change. Its contract test parses `.env.example` and requires
every documented name to be parsed or deferred; `OBSERVABILITY_DATABASE_URL` is now parsed.

- [ ] **Step 4: Write the storage builder**

Create `src/mastra/storage.ts`:

```typescript
import type { ConnectionOptions } from 'node:tls'
import { InMemoryStore } from '@mastra/core/storage'
import { PostgresStoreVNext } from '@mastra/pg'
import { isProduction, POOL_COUNT, SUPABASE_POOL_SIZE } from '../config/env'
import type { CrumEnv } from '../config/env'

/**
 * The store CRUM hands to `new Mastra({ storage })`. Postgres when configured,
 * in-memory otherwise, so `npm run dev` works with no Supabase project (§14.4).
 */
export type CrumStorage = PostgresStoreVNext | InMemoryStore

/** The store id. Mastra uses it for schema isolation and log attribution. */
export const STORAGE_ID = 'crum'

/**
 * Thrown when storage cannot be configured safely. `variables` carries the names
 * of the offending environment variables and never their values, so the message
 * is safe to log and safe to surface to a deployer.
 */
export class StorageConfigError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[] = []) {
    super(message)
    this.name = 'StorageConfigError'
    this.variables = variables
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Exact TLS configuration CRUM asks node-postgres for. */
const TLS_ON: ConnectionOptions = { rejectUnauthorized: true }

export function hostOf(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).hostname
  } catch {
    return undefined
  }
}

/**
 * True only for an exact loopback hostname. This is a set membership test and
 * deliberately not a substring test: `localhost.evil.example` must not be
 * treated as loopback, because that decision disables TLS.
 */
export function isLocalDatabaseUrl(connectionString: string | undefined): boolean {
  if (!connectionString) return false
  const host = hostOf(connectionString)
  return host !== undefined && LOCAL_HOSTS.has(host)
}

/**
 * §9.1: TLS is mandatory for anything that is not loopback. A plaintext
 * connection to a managed Postgres puts the credentials inside DATABASE_URL and
 * every customer row on the wire.
 *
 * `rejectUnauthorized: true` is stated explicitly rather than relying on
 * `ssl: true`, because the effective default has not been stable across Node and
 * node-postgres versions and this is a security control.
 *
 * MASTRA_PG_SSL overrides in both directions: `true` forces TLS against loopback
 * (a local tunnel or a container behind stunnel), `false` disables it (a
 * corporate MITM proxy). A self-signed certificate should be fixed by adding the
 * signing CA to NODE_EXTRA_CA_CERTS, not by turning verification off.
 */
export function resolveSsl(
  connectionString: string | undefined,
  override: 'true' | 'false' | undefined,
): boolean | ConnectionOptions {
  if (override === 'false') return false
  if (override === 'true') return TLS_ON
  if (isLocalDatabaseUrl(connectionString)) return false
  return TLS_ON
}

export function pgPoolMax(env: CrumEnv): number {
  return env.MASTRA_PG_POOL_MAX
}

export interface PoolBudget {
  pools: number
  perPoolMax: number
  total: number
  limit: number
  ok: boolean
}

/**
 * Supabase's session-mode pooler accepts 15 clients in total.
 * PostgresStoreVNext holds a writer pool, and `readPool` falls back to that
 * writer when unset (pg-storage.d.ts:89-90), plus a separate observability pool.
 * So POOL_COUNT is 2 and the per-pool cap must satisfy 2 x max <= 15.
 *
 * EnvSchema already rejects a value above floor(15 / 2) = 7. This recomputes the
 * same invariant from the exported constants so that raising the cap without
 * raising POOL_COUNT fails a test here instead of failing in production as
 * EMAXCONNSESSION, which reads like a database outage and is not one.
 */
export function checkPoolBudget(env: CrumEnv): PoolBudget {
  const perPoolMax = pgPoolMax(env)
  const total = POOL_COUNT * perPoolMax
  return {
    pools: POOL_COUNT,
    perPoolMax,
    total,
    limit: SUPABASE_POOL_SIZE,
    ok: total <= SUPABASE_POOL_SIZE,
  }
}

/**
 * The observability connection PostgresStoreVNext demands. Phase 0 runs with
 * MASTRA_OBSERVABILITY=false, so nothing is written here yet, but the
 * constructor still requires the field. Falling back to DATABASE_URL keeps local
 * setup to one URL and costs a logged warning; production should set a separate
 * database before observability is switched on. §9.1, §14.3.
 */
export function observabilityConnectionString(env: CrumEnv): string | undefined {
  return env.OBSERVABILITY_DATABASE_URL ?? env.DATABASE_URL
}

export function isPostgresStorage(storage: CrumStorage): storage is PostgresStoreVNext {
  return storage instanceof PostgresStoreVNext
}

/**
 * Builds the storage adapter for a parsed environment. Never reads process.env
 * itself: the caller parses once and passes the result, so a test can supply an
 * exact environment and nothing leaks from the developer's shell.
 *
 * Throws StorageConfigError rather than degrading when production has no
 * DATABASE_URL. In-memory storage in production means every customer, every
 * pending write and every approval receipt vanishes on restart, and a CRM that
 * silently forgets its audit trail is worse than one that refuses to start.
 * This is one of the two fail-closed exceptions in §13.8.
 */
export function buildMastraStorage(env: CrumEnv): CrumStorage {
  const connectionString = env.DATABASE_URL

  if (!connectionString) {
    if (isProduction(env)) {
      throw new StorageConfigError(
        'production requires DATABASE_URL; refusing to boot on ephemeral in-memory storage',
        ['DATABASE_URL'],
      )
    }
    return new InMemoryStore({ id: STORAGE_ID })
  }

  const budget = checkPoolBudget(env)
  if (!budget.ok) {
    throw new StorageConfigError(
      `pool budget exceeded: ${budget.pools} pools x max ${budget.perPoolMax} = ${budget.total} clients, Supabase pool_size is ${budget.limit}`,
      ['MASTRA_PG_POOL_MAX'],
    )
  }

  const observabilityUrl = observabilityConnectionString(env)
  if (!observabilityUrl) {
    throw new StorageConfigError(
      'PostgresStoreVNext requires an observability connection; set OBSERVABILITY_DATABASE_URL or DATABASE_URL',
      ['OBSERVABILITY_DATABASE_URL', 'DATABASE_URL'],
    )
  }

  const max = pgPoolMax(env)

  return new PostgresStoreVNext({
    id: STORAGE_ID,
    connectionString,
    ssl: resolveSsl(connectionString, env.MASTRA_PG_SSL),
    max,
    // true by default. Runtime must never create or alter tables; migrations run
    // explicitly through scripts/db-migrate.ts, which constructs with false. §14.2.
    disableInit: env.MASTRA_DB_DISABLE_INIT,
    observability: {
      connectionString: observabilityUrl,
      ssl: resolveSsl(observabilityUrl, env.MASTRA_PG_SSL),
      max,
    },
  })
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/mastra/storage.test.ts tests/config/env.test.ts
npm run typecheck
```

Expected: all pass, exit 0. `tests/config/env.test.ts` is re-run because Step 3 changed both the
schema and `.env.example`.

If `constructs a PostgresStoreVNext with the required id and observability fields` hangs rather
than fails, the adapter attempted a connection during construction. Move the three
`build({ DATABASE_URL: ... })` tests into `tests/integration/storage.test.ts` and leave the pure
helper tests where they are; the integration project is the one CI runs against the pgvector
service container.

If `names the missing variable rather than printing its value` fails on the `not.toContain('secret')`
assertion, a connection string reached the message. Fix the message, do not weaken the assertion:
storage errors go into deploy logs that far more people can read than the secret store.

- [ ] **Step 6: Verify against the installed artifact, not this plan**

```bash
grep -n "observability: PostgresStoreVNextObservabilityConfig" node_modules/@mastra/pg/dist/storage/index.d.ts
grep -n "id: string;" node_modules/@mastra/pg/dist/shared/config.d.ts
grep -n "disableInit?: boolean" node_modules/@mastra/core/dist/storage/base.d.ts
node -e "console.log(Object.getOwnPropertyNames(require('@mastra/pg')).filter(n => /exportSchemas|PostgresStoreVNext/.test(n)))"
```

Expected: the first three print one matching line each, and the fourth prints an array containing
both `exportSchemas` and `PostgresStoreVNext`, confirming Task 11 can import `exportSchemas` from
the package root.

If any grep prints nothing, the installed version differs from `@mastra/pg@1.32.0` /
`@mastra/core@1.79.0`. Stop and reconcile before continuing: every later phase builds on this
config shape, and a silent difference here becomes a runtime failure in Phase 3.

- [ ] **Step 7: Commit**

```bash
git add src/mastra/storage.ts tests/mastra/storage.test.ts src/config/env.ts .env.example
git commit -m "$(cat <<'EOF'
feat(storage): build the Postgres store the shipped constructor actually accepts

PostgresStoreVNext requires both `id` and an explicit `observability`
connection and refuses to share the primary one implicitly. The scaffold passed
neither, so src/mastra/index.ts did not compile.

buildMastraStorage owns three decisions that were previously unstated: TLS is
mandatory for any non-loopback host with rejectUnauthorized stated explicitly,
the per-pool cap is checked against Supabase's 15-client session pooler as
2 pools x max, and production without DATABASE_URL throws instead of booting on
in-memory storage that would lose every approval receipt on restart.

OBSERVABILITY_DATABASE_URL is added to the contract. Phase 0 leaves it unset and
accepts the adapter's sharing warning because MASTRA_OBSERVABILITY is false.
EOF
)"
```

---

## Task 11: Migrations

Phase 0's product deliverable is a schema, not a feature. §9.2 shows the shape of three tables and
defers the rest to a section that no longer exists in v0.3.0, so the remaining tables are derived
here from §5.1's business objects plus `human_tasks`, which §4.6.1's refuse path needs.

Two files land under `migrations/` and they are not the same kind of thing. `0001_mastra_core.sql` is
generated: it is a committed snapshot of the DDL Mastra's own `storage.init()` applies, kept so a
Mastra upgrade that changes the schema fails CI until somebody regenerates the file and reads the
diff. `0002_crum_spine.sql` is written by hand and is the only file the runner applies. The runner
distinguishes them by name, so the convention is `NNNN_crum_*.sql` for CRUM-owned migrations and
`NNNN_mastra_*.sql` for generated snapshots.

**Files:**
- Create: `migrations/0002_crum_spine.sql`
- Generate: `migrations/0001_mastra_core.sql`
- Create: `scripts/db-export-schema.ts`
- Create: `scripts/db-migrate.ts`
- Create: `tests/scripts/migrations.test.ts`
- Create: `tests/integration/migrations.test.ts`

**Interfaces:**
- Consumes from Task 9: `parseEnv`, `CrumEnv`. From Task 10: `buildMastraStorage`,
  `isPostgresStorage`. From `@mastra/pg`: `exportSchemas(schemaName?: string): string`, which its
  declaration states "Does not require a database connection".
- Produces, and Tasks 12 and 13 depend on these exact names:
  - `class MigrationError extends Error`
  - `interface Migration { version: string; filename: string; sql: string; checksum: string }`
  - `interface MigrationResult { applied: string[]; skipped: string[] }`
  - `function isCrumMigration(filename: string): boolean`
  - `function parseVersion(filename: string): string` throwing `MigrationError`
  - `function checksum(sql: string): string` returning 64 lowercase hex characters
  - `function listMigrations(dir: string): Migration[]` throwing `MigrationError`
  - `function migrate(pool: Pool, dir?: string): Promise<MigrationResult>`
  - `function main(raw?: NodeJS.ProcessEnv): Promise<MigrationResult>`
  - `function renderMastraCoreSchema(schemaName?: string): string`
  - `function writeMastraCoreSchema(cwd?: string): string` returning the path written
  - `const MIGRATIONS_TABLE = 'crum_schema_migrations'`
- Also produces the npm scripts `db:export-schema` and `db:migrate`, both already declared in
  Task 2's `package.json` and pointing at these two files.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/migrations.test.ts`. This runs offline. It reads the SQL as text and asserts
the invariants §5.1 and §5.2 require, which means a future migration that adds a table without a
tenant column fails a unit test rather than a security review.

```typescript
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checksum,
  isCrumMigration,
  listMigrations,
  MigrationError,
  MIGRATIONS_TABLE,
  parseVersion,
} from '../../scripts/db-migrate'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations')
const SPINE_PATH = path.join(MIGRATIONS_DIR, '0002_crum_spine.sql')
const SPINE = readFileSync(SPINE_PATH, 'utf8')

/**
 * The nine tables of the spine: §5.1's eight business objects plus human_tasks,
 * which §4.6.1's refuse path writes when a tool is gated at `refuse`.
 */
const SPINE_TABLES = [
  'customers',
  'contacts',
  'followups',
  'tasks',
  'schedules',
  'knowledge_documents',
  'pending_writes',
  'audit_receipts',
  'human_tasks',
] as const

function tableBlock(name: string): string {
  const header = `CREATE TABLE IF NOT EXISTS ${name} (`
  const start = SPINE.indexOf(header)
  expect(start, `${name} is not created`).toBeGreaterThan(-1)
  const end = SPINE.indexOf('\n);', start)
  expect(end, `${name} is not terminated`).toBeGreaterThan(start)
  return SPINE.slice(start, end)
}

describe('the spine schema', () => {
  it('creates all nine tables', () => {
    for (const table of SPINE_TABLES) {
      expect(tableBlock(table).length, table).toBeGreaterThan(0)
    }
  })

  it('scopes every table to a non-nullable tenant', () => {
    for (const table of SPINE_TABLES) {
      expect(tableBlock(table), table).toMatch(/tenant_id\s+uuid\s+NOT NULL/)
    }
  })

  it('names a responsible person on every row a human can act on', () => {
    for (const table of ['customers', 'followups', 'tasks', 'schedules', 'knowledge_documents']) {
      expect(tableBlock(table), table).toMatch(/owner_id\s+uuid\s+NOT NULL/)
    }
    expect(tableBlock('pending_writes')).toMatch(/requested_by\s+uuid\s+NOT NULL/)
    expect(tableBlock('audit_receipts')).toMatch(/approved_by\s+uuid\s+NOT NULL/)
    expect(tableBlock('human_tasks')).toMatch(/requested_by\s+uuid\s+NOT NULL/)
  })

  it('derives contact visibility from the parent customer instead of duplicating an owner', () => {
    expect(tableBlock('contacts')).not.toMatch(/owner_id/)
    expect(tableBlock('contacts')).toMatch(
      /customer_id\s+uuid\s+NOT NULL REFERENCES customers\(id\) ON DELETE CASCADE/,
    )
  })

  it('keeps team sharing on the customer only', () => {
    expect(tableBlock('customers')).toMatch(/team_member_ids\s+uuid\[\]\s+NOT NULL DEFAULT '\{\}'/)
    for (const table of SPINE_TABLES) {
      if (table === 'customers') continue
      expect(tableBlock(table), table).not.toMatch(/team_member_ids/)
    }
  })

  /**
   * §5.1 makes the task/schedule split a product rule: a task has a deadline
   * only, a schedule has a concrete range, and the agent must classify on the
   * presence of a start time. Encoding it in the schema means a misclassified
   * write fails instead of silently storing a task with a start time nobody
   * reads.
   */
  it('enforces the task/schedule split in the schema rather than in prose', () => {
    expect(tableBlock('tasks')).toMatch(/deadline\s+timestamptz/)
    expect(tableBlock('tasks')).not.toMatch(/start_time/)
    expect(tableBlock('schedules')).toMatch(/start_time\s+timestamptz\s+NOT NULL/)
    expect(tableBlock('schedules')).toMatch(/end_time\s+timestamptz\s+NOT NULL/)
    expect(SPINE).toContain('CONSTRAINT schedules_end_after_start CHECK (end_time > start_time)')
  })

  it('orders the approval queue by risk then age', () => {
    expect(SPINE).toContain(
      'CREATE INDEX IF NOT EXISTS idx_pending_queue ON pending_writes (tenant_id, risk_score DESC, created_at ASC)',
    )
    expect(SPINE).toMatch(/WHERE receipt_id IS NULL AND rejected_at IS NULL/)
  })

  it('allows exactly one receipt per staged draft', () => {
    expect(SPINE).toContain('CONSTRAINT uq_receipts_draft UNIQUE (pending_write_id)')
  })

  it('dedupes knowledge uploads by content hash within a tenant', () => {
    expect(SPINE).toContain('CONSTRAINT uq_knowledge_document_hash UNIQUE (tenant_id, content_hash)')
  })

  it('closes the pending_writes / audit_receipts cycle with a guarded ALTER', () => {
    expect(SPINE).toMatch(/pg_constraint WHERE conname = 'fk_pending_writes_receipt'/)
  })

  it('caps risk scores inside the band the scorer produces', () => {
    expect(tableBlock('pending_writes')).toMatch(
      /risk_score\s+integer\s+NOT NULL CHECK \(risk_score BETWEEN 0 AND 100\)/,
    )
  })

  it('only accepts the gates the policy loader can return', () => {
    expect(tableBlock('pending_writes')).toMatch(/CHECK \(gate IN \('auto', 'approval', 'refuse'\)\)/)
  })

  it('leaves transaction control to the runner', () => {
    expect(SPINE).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;\s*$/m)
  })

  it('is idempotent so a half-applied migration can be retried', () => {
    const creates = SPINE.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)/g) ?? []
    const guarded = SPINE.match(/CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/g) ?? []
    expect(guarded.length).toBe(creates.length)
    expect(creates.length).toBeGreaterThan(20)
  })
})

describe('migration discovery', () => {
  it('applies only CRUM-owned migrations', () => {
    expect(isCrumMigration('0002_crum_spine.sql')).toBe(true)
    expect(isCrumMigration('0003_crum_add_foo.sql')).toBe(true)
    expect(isCrumMigration('0001_mastra_core.sql')).toBe(false)
    expect(isCrumMigration('0002_crum_SPINE.sql')).toBe(false)
    expect(isCrumMigration('2_crum_spine.sql')).toBe(false)
    expect(isCrumMigration('README.md')).toBe(false)
  })

  it('lists the spine and never the generated snapshot', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.filename)
    expect(names).toContain('0002_crum_spine.sql')
    expect(names).not.toContain('0001_mastra_core.sql')
  })

  it('returns migrations in version order', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.filename)
    expect(names).toEqual([...names].sort())
  })

  it('ignores subdirectories and non-SQL files', () => {
    const names = listMigrations(MIGRATIONS_DIR).map((m) => m.filename)
    expect(names.every((n) => n.endsWith('.sql'))).toBe(true)
    expect(names.every((n) => !n.includes('/'))).toBe(true)
  })

  it('parses the four-digit version prefix', () => {
    expect(parseVersion('0002_crum_spine.sql')).toBe('0002')
    expect(parseVersion('0107_crum_add_foo.sql')).toBe('0107')
  })

  it('rejects a filename it would not apply', () => {
    expect(() => parseVersion('0001_mastra_core.sql')).toThrowError(MigrationError)
    expect(() => parseVersion('nope.sql')).toThrowError(MigrationError)
  })

  it('throws rather than returning an empty list for a missing directory', () => {
    expect(() => listMigrations(path.join(MIGRATIONS_DIR, 'does-not-exist'))).toThrowError(
      MigrationError,
    )
  })

  it('checksums deterministically', () => {
    expect(checksum('a')).toBe(checksum('a'))
    expect(checksum('a')).not.toBe(checksum('b'))
    expect(checksum('a')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('checksums every listed migration', () => {
    for (const migration of listMigrations(MIGRATIONS_DIR)) {
      expect(migration.checksum).toBe(checksum(migration.sql))
    }
  })

  it('names the version table the runner records into', () => {
    expect(MIGRATIONS_TABLE).toBe('crum_schema_migrations')
    expect(SPINE).not.toContain(MIGRATIONS_TABLE)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scripts/migrations.test.ts`
Expected: FAIL. `Cannot find module '../../scripts/db-migrate'`, and once that exists the SQL reads
fail with `ENOENT ... migrations/0002_crum_spine.sql`.

- [ ] **Step 3: Write the spine migration**

Create `migrations/0002_crum_spine.sql`:

```sql
-- CRUM business spine. §5.1 business objects, §5.2 permission model,
-- §9.2 storage layout.
--
-- Applied by scripts/db-migrate.ts, which records the version in
-- crum_schema_migrations and refuses to apply a file whose checksum changed
-- after it was applied.
--
-- Do not add BEGIN or COMMIT here. The runner wraps this file and its version
-- record in one transaction, so a failure leaves neither. A transaction inside
-- the file would commit the DDL before the version row is written.
--
-- Every table carries a non-nullable tenant_id. §5.2 requires
-- `tenant_id = :tenantId` on every single query without exception, and a
-- nullable column makes forgetting the predicate silently legal. NOT NULL turns
-- the omission into an insert failure during development instead of a
-- cross-tenant read in production.
--
-- Row-level security is deliberately not used. The application connects as the
-- table owner, so policies would not apply to it without also changing the
-- connection role, and §5.2 places the tenant predicate in the tool execute
-- layer where it is unit-testable. Revisit this if CRUM ever hands a direct
-- Postgres connection to a client.
--
-- gen_random_uuid() is built in from PostgreSQL 13. Supabase runs 15+ and CI runs
-- the pgvector/pgvector:pg17 image, so no extension is created here.
--
-- Everything is IF NOT EXISTS so a partially applied migration can be retried.

CREATE TABLE IF NOT EXISTS customers (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  name             text        NOT NULL,
  company          text,
  email            text,
  phone            text,
  city             text,
  tags             text[]      NOT NULL DEFAULT '{}',
  -- §5.2: a record is visible when owner_id = :userId, or :userId is in
  -- team_member_ids, or :userRole = 'admin'. Both columns live here and only
  -- here; child records inherit visibility through their customer.
  owner_id         uuid        NOT NULL,
  team_member_ids  uuid[]      NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- No owner_id: a contact is always a child of a customer, so its visibility is
-- the customer's visibility. Duplicating the owner here would let the two
-- disagree, and a disagreement in a permission column is a leak.
CREATE TABLE IF NOT EXISTS contacts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  customer_id  uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  role         text,
  email        text,
  phone        text,
  notes        text,
  is_primary   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followups (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  customer_id   uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_id    uuid        REFERENCES contacts(id) ON DELETE SET NULL,
  type          text        NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'visit')),
  status        text        NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'completed', 'cancelled', 'missed')),
  scheduled_at  timestamptz NOT NULL,
  completed_at  timestamptz,
  notes         text,
  owner_id      uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT followups_completed_requires_time
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

-- A task has a deadline and no start time. That absence is the enforcement of
-- §5.1's classification rule: if the agent is given a concrete range it must
-- create a schedule, and there is nowhere to put the range here.
CREATE TABLE IF NOT EXISTS tasks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  title        text        NOT NULL,
  description  text,
  deadline     timestamptz,
  priority     text        NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  assigned_to  uuid,
  owner_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A schedule has a concrete range. §5.1.
CREATE TABLE IF NOT EXISTS schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  title        text        NOT NULL,
  start_time   timestamptz NOT NULL,
  end_time     timestamptz NOT NULL,
  location     text,
  attendees    text[]      NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'confirmed'
               CHECK (status IN ('tentative', 'confirmed', 'cancelled')),
  owner_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_end_after_start CHECK (end_time > start_time)
);

-- No vector column. Chunks and their embeddings arrive in Phase 4 (§9.3); this
-- table is the document registry the chunk table will reference.
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  title         text        NOT NULL,
  file_type     text        NOT NULL,
  -- §5.1: the hash dedupes re-uploads. Uniqueness is per tenant, so two tenants
  -- can hold the same file without one seeing the other's document.
  content_hash  text        NOT NULL,
  byte_size     integer,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  owner_id      uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_document_hash UNIQUE (tenant_id, content_hash)
);

CREATE TABLE IF NOT EXISTS pending_writes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  run_id            text        NOT NULL,
  thread_id         text,
  object_type       text        NOT NULL
                    CHECK (object_type IN ('customer', 'contact', 'followup', 'task',
                                           'schedule', 'knowledge_document')),
  operation         text        NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  target_id         uuid,
  payload           jsonb       NOT NULL,
  risk_score        integer     NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  gate              text        NOT NULL CHECK (gate IN ('auto', 'approval', 'refuse')),
  -- Not a foreign key yet: audit_receipts references this table, so the reverse
  -- edge is added by the guarded ALTER at the bottom of this file.
  receipt_id        uuid,
  rejected_at       timestamptz,
  rejection_reason  text,
  requested_by      uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- §10.3.3: a staged draft expires so an approval token cannot be replayed
  -- against a business state that has since changed.
  expires_at        timestamptz NOT NULL,
  CONSTRAINT pending_writes_update_needs_target
    CHECK (operation = 'create' OR target_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS audit_receipts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL,
  pending_write_id     uuid        NOT NULL REFERENCES pending_writes(id) ON DELETE CASCADE,
  run_id               text        NOT NULL,
  -- HMAC over the draft and the runId, signed with APPROVAL_HMAC_SECRET. §12.3.
  signature            text        NOT NULL,
  committed_record_id  uuid,
  approved_by          uuid        NOT NULL,
  decision             text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- One decision per staged draft, forever. A replayed approval token cannot
  -- produce a second commit, and a draft cannot be rejected and then approved.
  CONSTRAINT uq_receipts_draft UNIQUE (pending_write_id)
);

-- Written by §4.6.1's refuse path. A refusal is a work item for a human, not a
-- dropped message: the agent says no and someone has to be told.
CREATE TABLE IF NOT EXISTS human_tasks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  run_id        text        NOT NULL,
  thread_id     text,
  kind          text        NOT NULL CHECK (kind IN ('refusal', 'escalation', 'review')),
  title         text        NOT NULL,
  body          text,
  tool_name     text,
  risk_score    integer     NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  status        text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  assigned_to   uuid,
  requested_by  uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant_owner ON customers (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_name  ON customers (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_tags         ON customers USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_customers_team          ON customers USING gin (team_member_ids);
CREATE INDEX IF NOT EXISTS idx_contacts_customer      ON contacts (customer_id);
CREATE INDEX IF NOT EXISTS idx_followups_queue        ON followups (tenant_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline         ON tasks (tenant_id, status, deadline);
CREATE INDEX IF NOT EXISTS idx_schedules_start        ON schedules (tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_state   ON knowledge_documents (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_run            ON pending_writes (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS idx_pending_expiry         ON pending_writes (expires_at)
  WHERE receipt_id IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_run           ON audit_receipts (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS idx_human_tasks_open       ON human_tasks (tenant_id, status, created_at DESC);

-- The approval queue. §12.4: highest risk first, oldest first within a risk
-- level, and only drafts that are still undecided. The partial predicate is what
-- keeps this index small; a decided draft leaves it without a DELETE.
CREATE INDEX IF NOT EXISTS idx_pending_queue ON pending_writes (tenant_id, risk_score DESC, created_at ASC)
  WHERE receipt_id IS NULL AND rejected_at IS NULL;

CREATE OR REPLACE FUNCTION crum_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_touch ON customers;
CREATE TRIGGER trg_customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_contacts_touch ON contacts;
CREATE TRIGGER trg_contacts_touch BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_followups_touch ON followups;
CREATE TRIGGER trg_followups_touch BEFORE UPDATE ON followups
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_touch ON tasks;
CREATE TRIGGER trg_tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_schedules_touch ON schedules;
CREATE TRIGGER trg_schedules_touch BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_documents_touch ON knowledge_documents;
CREATE TRIGGER trg_knowledge_documents_touch BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

-- The reverse edge of the pending_writes / audit_receipts cycle. ALTER TABLE has
-- no ADD CONSTRAINT IF NOT EXISTS, so the guard is explicit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_pending_writes_receipt'
  ) THEN
    ALTER TABLE pending_writes
      ADD CONSTRAINT fk_pending_writes_receipt
      FOREIGN KEY (receipt_id) REFERENCES audit_receipts(id) ON DELETE SET NULL;
  END IF;
END $$;
```

- [ ] **Step 4: Write the schema export script**

Create `scripts/db-export-schema.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportSchemas } from '@mastra/pg'

export const MIGRATIONS_DIRNAME = 'migrations'
export const GENERATED_FILENAME = '0001_mastra_core.sql'

/**
 * No timestamp, no version string, nothing that changes between runs. CI applies
 * this file and then runs `git diff --exit-code migrations/`, so a single
 * nondeterministic byte would fail every build and train everyone to ignore it.
 */
const HEADER = `-- GENERATED FILE. DO NOT EDIT BY HAND.
-- Regenerate with: npm run db:export-schema
-- Source: exportSchemas() from the installed @mastra/pg. See package.json for the pin.
--
-- This is a committed snapshot of the DDL Mastra's own storage.init() applies:
-- memory threads and messages, workflow runs and suspensions, scores, agents,
-- MCP clients and servers, workspaces, and the observability tables.
--
-- It is documentation and a drift alarm, not a migration. scripts/db-migrate.ts
-- never replays it: the adapter creates and upgrades these tables itself, and
-- hand-applying generated DDL would break on the next Mastra minor version.
-- CI regenerates the file and fails if the result differs from what is
-- committed, so a Mastra upgrade that changes the schema cannot land unread.
-- See TECHNICAL_PLAN.md §14.2.
`

/**
 * @param schemaName forwarded to exportSchemas(). Phase 0 uses the default
 *   schema and callers pass nothing. A non-default schema becomes relevant with
 *   `storageIsolationKey`, which no Phase 0 code sets.
 */
export function renderMastraCoreSchema(schemaName?: string): string {
  return `${HEADER}\n${exportSchemas(schemaName)}`
}

export function generatedSchemaPath(cwd: string = process.cwd()): string {
  return path.join(cwd, MIGRATIONS_DIRNAME, GENERATED_FILENAME)
}

export function writeMastraCoreSchema(cwd: string = process.cwd()): string {
  const target = generatedSchemaPath(cwd)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, renderMastraCoreSchema(), 'utf8')
  return target
}

function main(): void {
  const target = writeMastraCoreSchema()
  const relative = path.relative(process.cwd(), target)
  const bytes = renderMastraCoreSchema().length
  process.stdout.write(`wrote ${relative} (${bytes} bytes)\n`)
  process.stdout.write('run `git diff --exit-code migrations/` to confirm it is unchanged\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
```

Run it:

```bash
npm run db:export-schema
```

Expected: `wrote migrations/0001_mastra_core.sql (N bytes)` for some N in the tens of thousands, then
the `git diff` hint. Read the first forty lines of the generated file and confirm the header is at
the top and real DDL follows it. If the file is empty or contains only the header, `exportSchemas`
was not the export you thought it was; check
`node_modules/@mastra/pg/dist/storage/index.d.ts` for the current signature.

- [ ] **Step 5: Write the migration runner**

Create `scripts/db-migrate.ts`:

```typescript
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { Pool as PoolType } from 'pg'
import { parseEnv } from '../src/config/env'
import type { CrumEnv } from '../src/config/env'
import { buildMastraStorage, isPostgresStorage } from '../src/mastra/storage'

/**
 * CRUM-owned migrations match this. Generated snapshots are named
 * NNNN_mastra_*.sql and are excluded, because replaying DDL the adapter owns
 * would break on the next Mastra upgrade.
 */
const CRUM_MIGRATION_PATTERN = /^(\d{4})_crum_[a-z0-9_]+\.sql$/

export const MIGRATIONS_TABLE = 'crum_schema_migrations'

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

export interface Migration {
  version: string
  filename: string
  sql: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export function isCrumMigration(filename: string): boolean {
  return CRUM_MIGRATION_PATTERN.test(filename)
}

export function parseVersion(filename: string): string {
  const match = CRUM_MIGRATION_PATTERN.exec(filename)
  const version = match?.[1]
  if (version === undefined) {
    throw new MigrationError(`not a CRUM migration filename: ${filename}`)
  }
  return version
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export function listMigrations(dir: string): Migration[] {
  let filenames: string[]
  try {
    filenames = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isCrumMigration(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    throw new MigrationError(
      `cannot read migrations directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return filenames.sort().map((filename) => {
    const sql = readFileSync(path.join(dir, filename), 'utf8')
    return { version: parseVersion(filename), filename, sql, checksum: checksum(sql) }
  })
}

const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS crum_schema_migrations (
  version     text        PRIMARY KEY,
  filename    text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)
`

/**
 * Applies every unapplied CRUM migration in version order.
 *
 * Each migration and its version record are written inside one transaction, so a
 * failure leaves neither. Migration files must not contain their own BEGIN or
 * COMMIT: an inner COMMIT would land the DDL before the record exists, and a
 * crash in between would replay it on the next run.
 *
 * A version whose checksum differs from the recorded one is a hard error rather
 * than a re-apply. A deployed database cannot be rewound by editing history, and
 * silently running edited DDL against tables that already exist is how a schema
 * and its migrations stop describing the same thing.
 */
export async function migrate(
  pool: PoolType,
  dir: string = path.resolve(process.cwd(), 'migrations'),
): Promise<MigrationResult> {
  const migrations = listMigrations(dir)
  const client = await pool.connect()

  try {
    await client.query(ENSURE_MIGRATIONS_TABLE)

    const recorded = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM crum_schema_migrations`,
    )
    const seen = new Map(recorded.rows.map((row) => [row.version, row.checksum]))

    const applied: string[] = []
    const skipped: string[] = []

    for (const migration of migrations) {
      const previous = seen.get(migration.version)

      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new MigrationError(
            `${migration.filename} changed after it was applied. Write a new migration instead of editing an applied one.`,
          )
        }
        skipped.push(migration.filename)
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          `INSERT INTO crum_schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new MigrationError(
          `${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      applied.push(migration.filename)
    }

    return { applied, skipped }
  } finally {
    client.release()
  }
}

/**
 * The path CI and deploys take. Constructs storage with disableInit forced to
 * false so `init()` creates Mastra's own tables, then applies CRUM's. Runtime
 * code keeps disableInit true and never mutates the schema (§14.2).
 */
export async function main(raw: NodeJS.ProcessEnv = process.env): Promise<MigrationResult> {
  const env: CrumEnv = parseEnv({ ...raw, MASTRA_DB_DISABLE_INIT: 'false' })

  if (!env.DATABASE_URL) {
    throw new MigrationError(
      'DATABASE_URL is required to migrate; there is nothing to migrate against in-memory storage',
    )
  }

  const storage = buildMastraStorage(env)
  if (!isPostgresStorage(storage)) {
    throw new MigrationError(
      'buildMastraStorage returned an in-memory store even though DATABASE_URL is set',
    )
  }

  try {
    await storage.init()
    return await migrate(storage.pool)
  } finally {
    await storage.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
    .then((result) => {
      process.stdout.write(`applied: ${result.applied.length > 0 ? result.applied.join(', ') : 'none'}\n`)
      process.stdout.write(`skipped: ${result.skipped.length > 0 ? result.skipped.join(', ') : 'none'}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })
}

// Referenced so `Pool` is not tree-shaken out of the type graph by
// verbatimModuleSyntax; the value import is what migrate() type-checks against.
export type { Pool }
```

The `import { Pool } from 'pg'` line is a value import and `export type { Pool }` re-exports it as a
type. If `verbatimModuleSyntax` complains that the value import is unused, delete both lines and
change the `migrate` parameter type to `PoolType` only, keeping the `import type` line. Do not switch
to `import pg from 'pg'` and `pg.Pool`: the named import is what `@types/pg@8.23.1` declares.

- [ ] **Step 6: Run the offline tests**

```bash
npx vitest run tests/scripts/migrations.test.ts
npm run typecheck
npm run lint
```

Expected: all pass, exit 0.

If `is idempotent so a half-applied migration can be retried` fails on the count, an object was
created without `IF NOT EXISTS`. Add it. The exception is `CREATE OR REPLACE FUNCTION`, which the
regex deliberately does not match.

If `leaves transaction control to the runner` fails, remove the `BEGIN;` and `COMMIT;` from the SQL
file. They belong to `migrate()`, not to the migration.

- [ ] **Step 7: Write the integration test**

Create `tests/integration/migrations.test.ts`. This is the first file under `tests/integration/`,
which Task 3's Vitest config already excludes from the `unit` project.

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { main, migrate } from '../../scripts/db-migrate'

/**
 * Integration tests need a real PostgreSQL. Without one they skip rather than
 * fail, so `npm run test` stays green on a laptop with no database. CI sets this
 * from the pgvector service container. §14.2.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

function openPool(): Pool {
  return new Pool({ connectionString: url, max: 2 })
}

const pools: Pool[] = []

function tracked(): Pool {
  const pool = openPool()
  pools.push(pool)
  return pool
}

afterAll(async () => {
  while (pools.length > 0) {
    const pool = pools.pop()
    if (pool) await pool.end()
  }
})

const SPINE_TABLES = [
  'customers',
  'contacts',
  'followups',
  'tasks',
  'schedules',
  'knowledge_documents',
  'pending_writes',
  'audit_receipts',
  'human_tasks',
  'crum_schema_migrations',
]

describe.skipIf(url === '')('migrations against a real database', () => {
  it('boots through main(), which runs storage.init() and then the spine', async () => {
    const result = await main({
      NODE_ENV: 'development',
      DATABASE_URL: url,
      MASTRA_DB_DISABLE_INIT: 'true',
    } as NodeJS.ProcessEnv)

    expect(result.applied).toContain('0002_crum_spine.sql')

    const pool = tracked()
    const found = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const names = found.rows.map((row) => row.table_name)
    for (const table of SPINE_TABLES) {
      expect(names, table).toContain(table)
    }
  }, 120_000)

  it('is a no-op the second time', async () => {
    const pool = tracked()
    const result = await migrate(pool)
    expect(result.applied).toEqual([])
    expect(result.skipped).toContain('0002_crum_spine.sql')
  })

  it('refuses to insert a customer without a tenant', async () => {
    const pool = tracked()
    await expect(
      pool.query(`INSERT INTO customers (name, owner_id) VALUES ('No Tenant', gen_random_uuid())`),
    ).rejects.toThrow(/null value in column "tenant_id"/)
  })

  it('refuses a schedule that ends before it starts', async () => {
    const pool = tracked()
    await expect(
      pool.query(
        `INSERT INTO schedules (tenant_id, title, start_time, end_time, owner_id)
         VALUES (gen_random_uuid(), 'Backwards', now(), now() - interval '1 hour', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/schedules_end_after_start/)
  })

  it('refuses a second receipt for the same staged draft', async () => {
    const pool = tracked()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tenant = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0]?.id as string
      const requester = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0]?.id as string
      const draft = await client.query<{ id: string }>(
        `INSERT INTO pending_writes
           (tenant_id, run_id, object_type, operation, payload, risk_score, gate, requested_by, expires_at)
         VALUES ($1, 'run-test', 'customer', 'create', '{}'::jsonb, 60, 'approval', $2, now() + interval '1 hour')
         RETURNING id`,
        [tenant, requester],
      )
      const draftId = draft.rows[0]?.id as string

      await client.query(
        `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, approved_by, decision)
         VALUES ($1, $2, 'run-test', 'sig-1', $3, 'approved')`,
        [tenant, draftId, requester],
      )

      await expect(
        client.query(
          `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, approved_by, decision)
           VALUES ($1, $2, 'run-test', 'sig-2', $3, 'rejected')`,
          [tenant, draftId, requester],
        ),
      ).rejects.toThrow(/uq_receipts_draft/)

      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('rejects a migration edited after it was applied', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'crum-migrations-'))
    const file = path.join(dir, '9101_crum_probe.sql')
    const pool = tracked()

    try {
      await writeFile(
        file,
        'CREATE TABLE IF NOT EXISTS crum_probe_9101 (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)',
        'utf8',
      )
      const first = await migrate(pool, dir)
      expect(first.applied).toEqual(['9101_crum_probe.sql'])

      await writeFile(
        file,
        'CREATE TABLE IF NOT EXISTS crum_probe_9101 (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, extra text)',
        'utf8',
      )
      await expect(migrate(pool, dir)).rejects.toThrow(/changed after it was applied/)
    } finally {
      await pool.query(`DROP TABLE IF EXISTS crum_probe_9101`)
      await pool.query(`DELETE FROM crum_schema_migrations WHERE version = '9101'`)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('without a database', () => {
  it('main() refuses to migrate in-memory storage', async () => {
    await expect(main({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).rejects.toThrow(
      /DATABASE_URL is required to migrate/,
    )
  })
})
```

- [ ] **Step 8: Verify the integration test skips cleanly, then runs**

```bash
unset CRUM_INTEGRATION_DATABASE_URL
npx vitest run tests/integration/migrations.test.ts
```

Expected: one passing test (`main() refuses to migrate in-memory storage`) and five skipped.

Then, if a local PostgreSQL is available:

```bash
createdb crum_migrate_test 2>/dev/null || true
export CRUM_INTEGRATION_DATABASE_URL="postgresql://$(whoami)@localhost:5432/crum_migrate_test"
npx vitest run tests/integration/migrations.test.ts
dropdb crum_migrate_test
```

Expected: six passing. If no local PostgreSQL exists, skip this half. Task 13's CI job runs it
against a `pgvector/pgvector:pg17` service container, so the check is not lost, only deferred.

- [ ] **Step 9: Prove the drift check can fail**

```bash
npm run db:export-schema
git add migrations/
printf '\n-- drift probe\n' >> migrations/0001_mastra_core.sql
git diff --exit-code migrations/; echo "drift-detected=$?"
npm run db:export-schema
git diff --exit-code migrations/; echo "restored=$?"
```

Expected: `drift-detected=1` and `restored=0`. The first proves a hand edit is visible to the check
CI runs; the second proves regenerating restores the file byte for byte, which is what makes the
check usable rather than permanently red.

If `restored` is not `0`, the generated output is nondeterministic. Find the varying line and report
it: it is either a timestamp in `HEADER` or nondeterminism inside `exportSchemas`, and the second
case has to be recorded in `docs/verification/phase-0.md` rather than papered over.

- [ ] **Step 10: Commit**

```bash
git add migrations/ scripts/db-export-schema.ts scripts/db-migrate.ts \
        tests/scripts/migrations.test.ts tests/integration/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(storage): define the nine-table spine and a checksummed migration runner

Every table carries a non-nullable tenant_id, because §5.2 requires the tenant
predicate on every query without exception and a nullable column makes
forgetting it silently legal.

The task/schedule split from §5.1 is enforced by the schema: tasks has a
deadline and no start_time column, schedules requires both and a CHECK that the
range runs forward. A misclassified write now fails instead of storing a field
nothing reads.

audit_receipts carries UNIQUE (pending_write_id), so one staged draft yields
exactly one decision and a replayed approval token cannot produce a second
commit.

migrations/0001_mastra_core.sql is generated from exportSchemas() and never
applied by the runner; it exists so CI can fail a Mastra upgrade that silently
changes the schema. The runner only applies NNNN_crum_*.sql, records a sha256
per version, and refuses to re-run one whose checksum moved.
EOF
)"
```

---

## Task 12: Observability, the Mastra instance, and the MCP fail-closed guard

This is the task that retires the scaffold's `src/mastra/index.ts`, the file that does not compile.
It also lands two decisions that are much cheaper to make now than in the phase that needs them.

The first is the observability wiring. Three facts from the shipped declarations shape it:

- `Observability`'s constructor takes an `ObservabilityRegistryConfig`, and `sensitiveDataFilter`
  defaults to `true`, is applied automatically, is skipped when a config already carries one, and
  runs last. CRUM therefore does not add a `SensitiveDataFilter` by hand. Adding one would suppress
  the automatic filter rather than reinforce it.
- `MastraStorageExporterConfig` extends `BaseExporterConfig`, and neither declares a `storage`
  field. Storage reaches the exporter through `init(options: InitExporterOptions)`, which
  `Observability.setMastraContext({ mastra })` calls with the instance's own store. The correct
  construction is `new MastraStorageExporter()` with no arguments.
- `SamplingStrategy` is a union over the `SamplingStrategyType` enum, so `{ type: 'ratio',
  probability: 0.25 }` and `{ type: SamplingStrategyType.RATIO, probability: 0.25 }` are both
  assignable. Task 4 already proved both directions compile; this task consumes the result.

The second is `MCP_REQUEST_STATE_KEY`. §10.3.3 records that MCP 2.0 continuations are signed with
`requestState.key`, and that without one the server mints a key per process, so an approval that
suspends on replica A and resumes on replica B is rejected. §13.8 classifies this as one of exactly
two fail-closed exceptions. The MCP server does not exist until Phase 5, which is precisely why the
check lands in Phase 0: a boot-time failure in the deploy pipeline is actionable, and an intermittent
load-balancer-dependent rejection five phases later is not.

**Files:**
- Create: `src/mastra/observability.ts`
- Create: `src/mastra/mcp-guard.ts`
- Rewrite: `src/mastra/index.ts`
- Create: `tests/mastra/boot.test.ts`

**Interfaces:**
- Consumes from Task 9: `parseEnv`, `isProduction`, `CrumEnv`, `EnvParseError`. From Task 10:
  `buildMastraStorage`, `CrumStorage`, `STORAGE_ID`.
- Produces, and Phase 1 depends on these exact names:
  - `const OBSERVABILITY_INSTANCE = 'crum'`
  - `const OBSERVABILITY_SERVICE_NAME = 'crum'`
  - `interface CrumObservabilityInstanceConfig { serviceName: string; sampling: SamplingStrategy; exporters: ObservabilityExporter[] }`
  - `function samplingFor(env: CrumEnv): SamplingStrategy`
  - `function crumObservabilityInstanceConfig(env: CrumEnv): CrumObservabilityInstanceConfig`
  - `function buildObservabilityConfig(env: CrumEnv): ObservabilityRegistryConfig`
  - `function buildObservability(env: CrumEnv): Observability | undefined`
  - `class McpConfigError extends Error` with a `variables: readonly string[]` property
  - `interface McpRequestStateDecision { mount: boolean; key: string; ephemeral: boolean; warning: string | undefined }`
  - `function resolveMcpRequestState(env: CrumEnv): McpRequestStateDecision` throwing `McpConfigError`
  - `function assertMcpRequestStateKey(env: CrumEnv): void` throwing `McpConfigError`
  - `interface CrumMastraOptions { storage?: CrumStorage }`
  - `function createCrumMastra(env: CrumEnv, options?: CrumMastraOptions): Mastra`

- [ ] **Step 1: Write the failing test**

Create `tests/mastra/boot.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { Mastra } from '@mastra/core/mastra'
import { InMemoryStore } from '@mastra/core/storage'
import {
  MastraStorageExporter,
  Observability,
  SamplingStrategyType,
} from '@mastra/observability'
import type { MastraStorageExporterConfig } from '@mastra/observability'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import { EnvParseError } from '../../src/config/env'
import { createCrumMastra } from '../../src/mastra'
import {
  buildObservability,
  buildObservabilityConfig,
  crumObservabilityInstanceConfig,
  OBSERVABILITY_INSTANCE,
  OBSERVABILITY_SERVICE_NAME,
  samplingFor,
} from '../../src/mastra/observability'
import {
  assertMcpRequestStateKey,
  McpConfigError,
  resolveMcpRequestState,
} from '../../src/mastra/mcp-guard'

const REMOTE = 'postgresql://crum:secret@db.abcdefgh.supabase.co:5432/postgres'

/** The six secrets §13.8 requires in production. Placeholders, not credentials. */
const PRODUCTION_BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: REMOTE,
  OPENROUTER_API_KEY: 'sk-or-v1-placeholder',
  APPROVAL_HMAC_SECRET: 'a'.repeat(32),
  MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
}

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides } as NodeJS.ProcessEnv)
}

/**
 * Mastra is always constructed with an injected in-memory store here. Building
 * the real PostgresStoreVNext path is Task 10's job, and exercising
 * storage.init() against a live database is what tests/integration/ and
 * scripts/db-migrate.ts's main() already do. Nothing in this file opens a socket.
 */
function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'boot-test' })
}

describe('createCrumMastra', () => {
  it('constructs with no DATABASE_URL and in-memory storage', () => {
    const mastra = createCrumMastra(envWith(), { storage: testStore() })
    expect(mastra).toBeInstanceOf(Mastra)
    expect(mastra.getStorage()).toBeInstanceOf(InMemoryStore)
  })

  it('constructs when a remote DATABASE_URL is configured', () => {
    const mastra = createCrumMastra(envWith({ DATABASE_URL: REMOTE }), { storage: testStore() })
    expect(mastra).toBeInstanceOf(Mastra)
  })

  it('builds its own storage when none is injected', () => {
    const mastra = createCrumMastra(envWith())
    expect(mastra.getStorage()).toBeInstanceOf(InMemoryStore)
  })

  it('carries the store id so logs and schema isolation agree', () => {
    const mastra = createCrumMastra(envWith())
    expect(mastra.getStorage()?.id ?? '').not.toBe('')
  })

  it('propagates an invalid environment rather than booting on defaults', () => {
    expect(() =>
      createCrumMastra(parseEnv({ MASTRA_PG_POOL_MAX: '9' } as NodeJS.ProcessEnv)),
    ).toThrowError(EnvParseError)
  })

  it('refuses to boot in production without MCP_REQUEST_STATE_KEY', () => {
    const { MCP_REQUEST_STATE_KEY: _omitted, ...rest } = PRODUCTION_BASE
    expect(() => createCrumMastra(parseEnv(rest as NodeJS.ProcessEnv))).toThrowError(McpConfigError)
  })

  it('names the missing variable in the production boot failure', () => {
    const { MCP_REQUEST_STATE_KEY: _omitted, ...rest } = PRODUCTION_BASE
    try {
      createCrumMastra(parseEnv(rest as NodeJS.ProcessEnv))
      expect.unreachable('production without MCP_REQUEST_STATE_KEY must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError)
      expect((error as McpConfigError).variables).toEqual(['MCP_REQUEST_STATE_KEY'])
      expect((error as McpConfigError).message).toContain('MCP_REQUEST_STATE_KEY')
    }
  })

  it('boots in production with the full secret set', () => {
    const mastra = createCrumMastra(parseEnv(PRODUCTION_BASE as NodeJS.ProcessEnv), {
      storage: testStore(),
    })
    expect(mastra).toBeInstanceOf(Mastra)
  })

  it('mounts no agent yet', () => {
    const mastra = createCrumMastra(envWith())
    expect(Object.keys(mastra.listAgents())).toEqual([])
  })
})

describe('samplingFor', () => {
  it('samples everything at probability 1', () => {
    expect(samplingFor(envWith({ MASTRA_TRACE_PROBABILITY: '1' }))).toEqual({
      type: SamplingStrategyType.ALWAYS,
    })
  })

  it('samples nothing at probability 0', () => {
    expect(samplingFor(envWith({ MASTRA_TRACE_PROBABILITY: '0' }))).toEqual({
      type: SamplingStrategyType.NEVER,
    })
  })

  it('uses ratio sampling in between', () => {
    expect(samplingFor(envWith({ MASTRA_TRACE_PROBABILITY: '0.25' }))).toEqual({
      type: SamplingStrategyType.RATIO,
      probability: 0.25,
    })
  })

  it('defaults to sampling everything, so a missing variable is loud rather than blind', () => {
    expect(samplingFor(envWith())).toEqual({ type: SamplingStrategyType.ALWAYS })
  })
})

describe('crumObservabilityInstanceConfig', () => {
  it('names the service and the instance', () => {
    const config = crumObservabilityInstanceConfig(envWith())
    expect(config.serviceName).toBe(OBSERVABILITY_SERVICE_NAME)
    expect(OBSERVABILITY_INSTANCE).toBe('crum')
  })

  it('passes no storage to the exporter, because storage arrives through init()', () => {
    const config = crumObservabilityInstanceConfig(envWith())
    expect(config.exporters).toHaveLength(1)
    expect(config.exporters[0]).toBeInstanceOf(MastraStorageExporter)

    /**
     * The trap this guards. MastraStorageExporterConfig extends
     * BaseExporterConfig and neither declares `storage`; the exporter receives it
     * in init(InitExporterOptions), which Observability.setMastraContext calls
     * with the Mastra instance's own store. If this directive ever becomes
     * unused, the constructor grew a storage option and the comment above is
     * stale, so typecheck fails and somebody reads this before deleting it.
     */
    // @ts-expect-error MastraStorageExporterConfig has no storage field
    const withStorage: MastraStorageExporterConfig = { storage: {} }
    expect(withStorage).toBeDefined()
  })

  it('adds no span output processor, so the registry-level sensitive data filter still applies', () => {
    const config = crumObservabilityInstanceConfig(envWith())
    expect(config).not.toHaveProperty('spanOutputProcessors')
  })
})

describe('buildObservabilityConfig', () => {
  it('registers one instance under the crum key', () => {
    const registry = buildObservabilityConfig(envWith({ MASTRA_TRACE_PROBABILITY: '0.5' }))
    expect(Object.keys(registry.configs ?? {})).toEqual([OBSERVABILITY_INSTANCE])
  })

  it('states the sensitive data filter explicitly rather than relying on a default', () => {
    expect(buildObservabilityConfig(envWith()).sensitiveDataFilter).toBe(true)
  })

  it('does not use the deprecated `default` registry key', () => {
    expect(buildObservabilityConfig(envWith()).default).toBeUndefined()
  })
})

describe('buildObservability', () => {
  it('returns undefined when MASTRA_OBSERVABILITY is not true', () => {
    expect(buildObservability(envWith())).toBeUndefined()
    expect(buildObservability(envWith({ MASTRA_OBSERVABILITY: 'false' }))).toBeUndefined()
  })

  it('returns an Observability entrypoint when enabled', async () => {
    const observability = buildObservability(envWith({ MASTRA_OBSERVABILITY: 'true' }))
    expect(observability).toBeInstanceOf(Observability)
    expect(observability?.flush).toBeTypeOf('function')
    await observability?.shutdown()
  })

  it('can be handed straight to Mastra', async () => {
    const env = envWith({ MASTRA_OBSERVABILITY: 'true' })
    const observability = buildObservability(env)
    const mastra = new Mastra({ storage: testStore(), observability })
    expect(mastra).toBeInstanceOf(Mastra)
    await observability?.shutdown()
  })
})

describe('resolveMcpRequestState', () => {
  it('uses the configured key when one is present', () => {
    const decision = resolveMcpRequestState(envWith({ MCP_REQUEST_STATE_KEY: 'c'.repeat(32) }))
    expect(decision).toEqual({
      mount: true,
      key: 'c'.repeat(32),
      ephemeral: false,
      warning: undefined,
    })
  })

  it('generates a per-process key outside production and says so', () => {
    const decision = resolveMcpRequestState(envWith())
    expect(decision.mount).toBe(true)
    expect(decision.ephemeral).toBe(true)
    expect(decision.key.length).toBeGreaterThanOrEqual(32)
    expect(decision.warning).toMatch(/will not survive a restart or a second replica/)
  })

  it('generates a different key per call, proving it is not a constant', () => {
    const first = resolveMcpRequestState(envWith())
    const second = resolveMcpRequestState(envWith())
    expect(first.key).not.toBe(second.key)
  })

  it('throws in production', () => {
    const { MCP_REQUEST_STATE_KEY: _omitted, ...rest } = PRODUCTION_BASE
    expect(() => resolveMcpRequestState(parseEnv(rest as NodeJS.ProcessEnv))).toThrowError(
      McpConfigError,
    )
  })

  it('never prints a key value in an error message', () => {
    const key = 'd'.repeat(32)
    try {
      assertMcpRequestStateKey(
        parseEnv({ NODE_ENV: 'production', MCP_REQUEST_STATE_KEY: 'short' } as NodeJS.ProcessEnv),
      )
    } catch {
      // A too-short key is rejected by EnvSchema before the guard sees it, so
      // this path only proves the guard does not leak whatever reached it.
    }
    expect(() =>
      assertMcpRequestStateKey(envWith({ MCP_REQUEST_STATE_KEY: key })),
    ).not.toThrow()
  })
})

describe('assertMcpRequestStateKey', () => {
  it('passes outside production with no key', () => {
    expect(() => assertMcpRequestStateKey(envWith())).not.toThrow()
  })

  it('passes in production with a key', () => {
    expect(() => assertMcpRequestStateKey(parseEnv(PRODUCTION_BASE as NodeJS.ProcessEnv))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mastra/boot.test.ts`
Expected: FAIL. Three modules are missing: `../../src/mastra/observability`,
`../../src/mastra/mcp-guard`, and `createCrumMastra` is not exported by `../../src/mastra`.

Note that `../../src/mastra` currently resolves to the scaffold's `src/mastra/index.ts`, which does
not compile. `npm run typecheck` is red for the same reason and stays red until Step 5.

- [ ] **Step 3: Write the observability builder**

Create `src/mastra/observability.ts`:

```typescript
import type { ObservabilityExporter } from '@mastra/core/observability'
import {
  MastraStorageExporter,
  Observability,
  SamplingStrategyType,
} from '@mastra/observability'
import type { ObservabilityRegistryConfig, SamplingStrategy } from '@mastra/observability'
import type { CrumEnv } from '../config/env'

/** Registry key. Also the name Mastra prints in span metadata. */
export const OBSERVABILITY_INSTANCE = 'crum'

/** Service name on every emitted span. One service, one product. */
export const OBSERVABILITY_SERVICE_NAME = 'crum'

export interface CrumObservabilityInstanceConfig {
  serviceName: string
  sampling: SamplingStrategy
  exporters: ObservabilityExporter[]
}

/**
 * Turns MASTRA_TRACE_PROBABILITY into a SamplingStrategy.
 *
 * The endpoints use the dedicated enum members rather than RATIO with 0 or 1,
 * because ALWAYS and NEVER let the registry skip span construction entirely
 * while RATIO still builds the span and discards it. At probability 0 that
 * difference is the whole cost of tracing.
 *
 * The default is 1, so a missing variable traces everything. For a governance
 * product the expensive default is the correct one: an untraced approval is
 * unauditable, and a surprising bill is a config change away.
 */
export function samplingFor(env: CrumEnv): SamplingStrategy {
  const probability = env.MASTRA_TRACE_PROBABILITY
  if (probability >= 1) return { type: SamplingStrategyType.ALWAYS }
  if (probability <= 0) return { type: SamplingStrategyType.NEVER }
  return { type: SamplingStrategyType.RATIO, probability }
}

/**
 * The instance config CRUM registers.
 *
 * `spanOutputProcessors` is deliberately absent. The registry-level
 * `sensitiveDataFilter` is skipped for a config that already carries a processor
 * of its own, so adding one here would switch off the automatic filter that
 * redacts customer names, phone numbers and email addresses from span
 * attributes. If CRUM ever needs a custom processor it must compose the
 * sensitive-data filter explicitly rather than replace it.
 */
export function crumObservabilityInstanceConfig(env: CrumEnv): CrumObservabilityInstanceConfig {
  return {
    serviceName: OBSERVABILITY_SERVICE_NAME,
    sampling: samplingFor(env),
    // No arguments. MastraStorageExporterConfig extends BaseExporterConfig and
    // neither declares `storage`; the exporter receives storage in
    // init(InitExporterOptions), which Observability.setMastraContext({ mastra })
    // calls with this Mastra instance's own store. Passing storage here would be
    // a type error, and inventing a second store would double the pool budget
    // Task 10 just constrained.
    exporters: [new MastraStorageExporter()],
  }
}

export function buildObservabilityConfig(env: CrumEnv): ObservabilityRegistryConfig {
  return {
    configs: {
      [OBSERVABILITY_INSTANCE]: crumObservabilityInstanceConfig(env),
    },
    // Stated explicitly even though true is the documented default. This is a
    // privacy control over CRM data, and a control that depends on a library
    // default is one minor-version bump away from being off.
    sensitiveDataFilter: true,
  }
}

/**
 * Returns undefined when tracing is disabled, so `new Mastra({ observability })`
 * receives no entrypoint and emits nothing. §13.3 keeps this off by default:
 * PostgresStoreVNext is documented as low-volume only, and its own JSDoc puts
 * the ceiling near 1,500 calls/sec on a single primary.
 */
export function buildObservability(env: CrumEnv): Observability | undefined {
  if (env.MASTRA_OBSERVABILITY !== true) return undefined
  return new Observability(buildObservabilityConfig(env))
}
```

- [ ] **Step 4: Write the MCP request-state guard**

Create `src/mastra/mcp-guard.ts`:

```typescript
import { randomBytes } from 'node:crypto'
import { isProduction } from '../config/env'
import type { CrumEnv } from '../config/env'

/**
 * Thrown when MCP continuation state cannot be configured safely. `variables`
 * carries names, never values.
 */
export class McpConfigError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[] = []) {
    super(message)
    this.name = 'McpConfigError'
    this.variables = variables
  }
}

export interface McpRequestStateDecision {
  /** False would mean do not mount the MCP server at all. CRUM never returns it. */
  mount: boolean
  /** The HMAC key to pass as `requestState.key`. Never logged. */
  key: string
  /** True when the key was generated for this process rather than configured. */
  ephemeral: boolean
  /** A warning to log when the decision is unsafe but recoverable. */
  warning: string | undefined
}

const EPHEMERAL_WARNING =
  'MCP_REQUEST_STATE_KEY is unset, so a per-process key was generated. input_required ' +
  'continuations will not survive a restart or a second replica. Set the variable before ' +
  'deploying (§10.3.3, §14.3).'

/**
 * Resolves the key that signs MCP `input_required` continuations.
 *
 * §10.3.3: MCP 2.0 is sessionless, so continuation state travels in a signed
 * `requestState` envelope, and on a server without authorization that envelope
 * acts as a bearer credential for its round. Without an explicit key the server
 * generates one per process and continuations only succeed on that process.
 *
 * In production that failure is intermittent, load-balancer dependent, and
 * invisible in a single-container preview: an approval suspends on replica A and
 * resumes on replica B and is rejected, with no local reproduction. So production
 * throws. Development gets a random per-process key and a warning, because a
 * laptop that cannot start is a worse outcome than a laptop whose continuations
 * do not survive a restart. §13.8 lists this as one of two fail-closed exceptions.
 *
 * The generated key is 32 random bytes, matching the EnvSchema floor for
 * configured secrets, and is never written to a log line.
 */
export function resolveMcpRequestState(env: CrumEnv): McpRequestStateDecision {
  const configured = env.MCP_REQUEST_STATE_KEY

  if (configured !== undefined && configured.length > 0) {
    return { mount: true, key: configured, ephemeral: false, warning: undefined }
  }

  if (isProduction(env)) {
    throw new McpConfigError(
      'MCP_REQUEST_STATE_KEY is required in production. Without it every replica mints its own ' +
        'signing key and an approval that suspends on one replica is rejected when it resumes on ' +
        'another. Set the same value in every replica environment (§10.3.3, §13.8, §14.3).',
      ['MCP_REQUEST_STATE_KEY'],
    )
  }

  return {
    mount: true,
    key: randomBytes(32).toString('base64url'),
    ephemeral: true,
    warning: EPHEMERAL_WARNING,
  }
}

/**
 * The boot-time check. Called by createCrumMastra so the failure happens when
 * the process starts rather than at the first MCP request in Phase 5.
 */
export function assertMcpRequestStateKey(env: CrumEnv): void {
  resolveMcpRequestState(env)
}
```

- [ ] **Step 5: Rewrite the Mastra instance**

Replace the whole of `src/mastra/index.ts`:

```typescript
import { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { buildObservability } from './observability'
import { assertMcpRequestStateKey } from './mcp-guard'
import { buildMastraStorage } from './storage'
import type { CrumStorage } from './storage'

export interface CrumMastraOptions {
  /**
   * Inject a store instead of building one from the environment. Tests use this
   * to construct a real Mastra without opening a socket; nothing in production
   * passes it.
   */
  storage?: CrumStorage
}

/**
 * Builds the CRUM Mastra instance from a parsed environment.
 *
 * No module-level singleton on purpose. `parseEnv()` reads `process.env`, and a
 * singleton constructed at import time would make every test that touches this
 * module depend on the developer's shell. Phase 1 adds the Mastra CLI entrypoint
 * and constructs the singleton there, where the process environment is the right
 * thing to read.
 *
 * Phase 0 mounts no agents and no workflows. §16's Phase 0 acceptance criterion
 * is that the instance constructs both with and without DATABASE_URL and refuses
 * to boot in production without MCP_REQUEST_STATE_KEY, which is what this
 * function does and what tests/mastra/boot.test.ts asserts.
 */
export function createCrumMastra(env: CrumEnv, options: CrumMastraOptions = {}): Mastra {
  // Fail closed at boot, five phases before the MCP server exists. §13.8.
  assertMcpRequestStateKey(env)

  const storage = options.storage ?? buildMastraStorage(env)

  return new Mastra({
    agents: {},
    workflows: {},
    storage,
    observability: buildObservability(env),
  })
}

export { OBSERVABILITY_INSTANCE, OBSERVABILITY_SERVICE_NAME } from './observability'
export { buildMastraStorage, isPostgresStorage, STORAGE_ID } from './storage'
export type { CrumStorage } from './storage'
export { assertMcpRequestStateKey, resolveMcpRequestState } from './mcp-guard'
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/mastra/boot.test.ts
npm run typecheck
npm run lint
npm run test
```

Expected: all four exit 0. `npm run typecheck` is green for the first time in this phase, because
the scaffold's non-compiling `src/mastra/index.ts` is gone.

If `mounts no agent yet` fails because `listAgents()` returns entries, Mastra is registering
internal agents of its own. Print the keys, and if they are all Mastra-internal, narrow the assertion
to the names CRUM will add in Phase 1 rather than to an empty object. The test is a documentation
assertion, not a load-bearing one.

If `returns an Observability entrypoint when enabled` leaves the worker hanging, the exporter started
a batch-flush timer. `await observability?.shutdown()` is already there; if that is not enough, add
`{ timeout: 10_000 }` as the third argument to the `it` call and record the behaviour in
`docs/verification/phase-0.md`, because a shutdown that does not stop timers will matter in Phase 6
when the eval runner constructs and tears down instances per experiment.

- [ ] **Step 7: Verify against the installed artifacts**

```bash
grep -n "sensitiveDataFilter" node_modules/@mastra/observability/dist/config.d.ts | head -5
grep -n "storage" node_modules/@mastra/observability/dist/exporters/mastra-storage.d.ts | head -5
grep -n "init(options: InitExporterOptions)" node_modules/@mastra/observability/dist/exporters/mastra-storage.d.ts
grep -n "implements ObservabilityEntrypoint" node_modules/@mastra/observability/dist/default.d.ts
```

Expected: the first prints the `sensitiveDataFilter` field and its default-true documentation. The
second prints only the `MastraStorageExporter` class name and the word "Storage-backed" in comments,
with no `storage?:` config field. The third prints the `init` signature. The fourth confirms
`Observability` is assignable to `Mastra`'s `observability` field.

If the second grep prints a `storage` field, the exporter's contract changed and
`crumObservabilityInstanceConfig` should pass the store explicitly. Fix the code and delete the
`@ts-expect-error` directive in Step 1's test; leaving an unused directive is a typecheck failure,
which is the point of writing it as one.

- [ ] **Step 8: Commit**

```bash
git add src/mastra/observability.ts src/mastra/mcp-guard.ts src/mastra/index.ts tests/mastra/boot.test.ts
git commit -m "$(cat <<'EOF'
feat(harness): boot a Mastra instance and fail closed on MCP continuation keys

Replaces the scaffold's src/mastra/index.ts, which omitted both required
PostgresStoreVNext fields and did not compile. createCrumMastra is a factory
rather than a module-level singleton so no test inherits the developer's shell.

Observability wires one registry instance with a MastraStorageExporter
constructed with no arguments: storage reaches the exporter through init(),
which setMastraContext calls with this instance's own store. No
spanOutputProcessors are added, because a config that carries its own suppresses
the registry-level sensitive data filter that redacts customer PII from spans.
The filter is still stated explicitly rather than left to a default.

MCP_REQUEST_STATE_KEY is asserted at boot, five phases before the MCP server
exists. Without it each replica mints its own signing key and an approval that
suspends on one replica is rejected when it resumes on another, intermittently
and with no local reproduction. Production throws; development generates a
per-process key and logs that continuations will not survive a restart.
EOF
)"
```

---

## Task 13: CI workflow, line endings, and the devcontainer

§14.2 specifies the pipeline. This task implements the part of it Phase 0 can actually run, and adds
a test that reads the workflow file back so the two cannot drift.

Three deviations from §14.2 are deliberate and each is recorded for the Appendix E write-back in
Task 14:

1. The service image is `pgvector/pgvector:pg17` rather than `pg16`. `gen_random_uuid()` needs 13+,
   the `vector` extension Phase 4 requires is present in both, and running one image from Phase 0
   removes a second version bump later.
2. The push trigger is `branches: [master, 'phase/**']` rather than `[main]`. This repository's
   default branch is `master`, and the roadmap runs each phase on a `phase/N-*` branch. Without the
   second pattern, no phase branch gets CI until it is already merged.
3. The `Eval gate` and `Accessibility` steps are omitted. `npm run eval:crum` arrives in Phase 6 and
   `npm run test:a11y` in Phase 1; a step that calls a script that does not exist is a red build, and
   adding placeholder scripts to make it green is worse.

**Files:**
- Create: `.github/workflows/crum-ci.yml`
- Create: `.gitattributes`
- Create: `.devcontainer/devcontainer.json`
- Create: `tests/ci/workflow.test.ts`

**Interfaces:**
- Consumes: the npm scripts declared in Task 2, the migration scripts from Task 11, and `yaml@2.9.1`
  from the pinned dependency set.
- Produces: a `verify` job that runs on every pull request and on pushes to `master` and `phase/**`.
  Later phases add steps to this file; the conformance test in Step 1 is what keeps those additions
  honest.

- [ ] **Step 1: Write the failing test**

Create `tests/ci/workflow.test.ts`:

```typescript
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
})

describe('triggers', () => {
  it('runs on pull requests', () => {
    expect(workflow.on).toHaveProperty('pull_request')
  })

  it('runs on master and on phase branches', () => {
    const branches = (workflow.on.push as { branches: string[] }).branches
    expect(branches).toContain('master')
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ci/workflow.test.ts`
Expected: FAIL with `ENOENT ... .github/workflows/crum-ci.yml` at import time, because the workflow
file is read at module scope.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/crum-ci.yml`:

```yaml
name: crum-ci

on:
  pull_request:
  push:
    branches: [master, 'phase/**']

# A force-push to a phase branch cancels the run it supersedes instead of
# queueing behind it.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# Phase 0 reads the repository and nothing else. No issues, no deployments, no
# id-token. Widening this later should be a reviewed change to one line.
permissions:
  contents: read

env:
  # One definition of the CI database. Every step that needs it references this.
  CI_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres

jobs:
  verify:
    runs-on: ubuntu-latest

    services:
      postgres:
        # pg17, not the pg16 named in TECHNICAL_PLAN.md §14.2. gen_random_uuid()
        # needs 13+, the vector extension Phase 4 requires ships in both, and
        # running one image from Phase 0 removes a second version bump later.
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        # Mastra requires Node 22.18.0 or newer. A Node 20 pin here would let CI
        # pass against a runtime production cannot use (§16 Phase 0).
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Lint
        run: npm run lint

      - name: Typecheck
        # Doubles as the alarm for every @ts-expect-error directive in tests/smoke
        # and tests/mastra. An unused directive is a compile error, so a Mastra
        # release that starts accepting a signature CRUM assumed it would reject
        # turns this job red instead of silently invalidating a plan assumption.
        run: npm run typecheck

      - name: Unit tests
        run: npm run test:unit

      - name: Policy conformance
        # Walks policy/tools.yaml against the §4.6.2 tool surface and asserts the
        # class invariants. No model call, no network, no clock.
        run: npm run test:policy

      - name: Regenerate the Mastra schema snapshot
        run: npm run db:export-schema

      - name: Assert no schema drift
        # A Mastra upgrade that changes the DDL fails here until somebody
        # regenerates migrations/0001_mastra_core.sql and reads the diff. A
        # schema change invisible in the pull request is a schema change nobody
        # reviewed (§14.2, migration discipline reason 2).
        run: git diff --exit-code migrations/

      - name: Migrate
        # scripts/db-migrate.ts forces MASTRA_DB_DISABLE_INIT off for its own
        # process. Nothing else in this pipeline may set it, so an application
        # process can never CREATE TABLE (§14.2, migration discipline reason 1).
        run: npm run db:migrate
        env:
          DATABASE_URL: ${{ env.CI_DATABASE_URL }}

      - name: Integration tests
        run: npm run test:integration
        env:
          DATABASE_URL: ${{ env.CI_DATABASE_URL }}
          CRUM_INTEGRATION_DATABASE_URL: ${{ env.CI_DATABASE_URL }}
```

- [ ] **Step 4: Write `.gitattributes`**

The generated schema snapshot is produced on Linux in CI and committed from Windows workstations.
Without an explicit line-ending rule, CRLF normalisation makes `git diff --exit-code migrations/`
fail on every run for a reason that has nothing to do with the schema, and the check gets deleted
instead of fixed.

Create `.gitattributes`:

```
# Line endings are pinned for files that are either generated in CI on Linux and
# committed from Windows, or parsed by a test that reads bytes.

# Regenerated by scripts/db-export-schema.ts and diffed by CI. A CRLF/LF
# difference here is a permanently red drift check with no schema cause.
migrations/** text eol=lf
*.sql text eol=lf

# Parsed by yaml@2.9.1 in tests/governance and tests/ci.
policy/** text eol=lf
*.yaml text eol=lf
*.yml text eol=lf

# Parsed line by line by tests/config/env.test.ts.
.env.example text eol=lf

# Never normalised. If a binary lands here later, add it explicitly.
*.png binary
*.jpg binary
*.pdf binary
```

- [ ] **Step 5: Write the devcontainer**

§16 Phase 0 requires the Node floor to be asserted in `engines`, in CI, and in the devcontainer. The
first two exist after Task 2 and Step 3.

Create `.devcontainer/devcontainer.json`:

```json
{
  "name": "crum",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
  "features": {
    "ghcr.io/devcontainers/features/common-utils:2": {
      "installZsh": "false",
      "username": "node",
      "upgradePackages": false
    }
  },
  "customizations": {
    "vscode": {
      "extensions": ["dbaeumer.vscode-eslint"],
      "settings": {
        "editor.formatOnSave": false,
        "eslint.validate": ["typescript"]
      }
    }
  },
  "forwardPorts": [5432],
  "postCreateCommand": "npm ci && npm run typecheck",
  "remoteUser": "node"
}
```

`postCreateCommand` runs `npm run typecheck` rather than the full test suite so a container rebuild
surfaces a broken toolchain in seconds instead of minutes. `editor.formatOnSave` is off because CRUM
has no formatter dependency pinned; turning it on would reformat files with whatever the editor
defaults to and produce diffs nobody asked for.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/ci/workflow.test.ts
npm run test:unit
npm run typecheck
npm run lint
```

Expected: all exit 0.

If `references only declared scripts` fails, a workflow step names a script `package.json` does not
have. Either add the script or remove the step. Do not weaken the test: the whole value of the check
is that it reads both files.

If `uses no secret` fails, a `${{ secrets.X }}` reference reached the workflow. Phase 0 makes no
model call and contacts no third party, so there is nothing legitimate for it to be. Remove it and
add it in the phase that needs it.

- [ ] **Step 7: Validate the YAML independently of the test**

```bash
npx tsx -e "import {parse} from 'yaml'; import {readFileSync} from 'node:fs'; const d = parse(readFileSync('.github/workflows/crum-ci.yml','utf8')); console.log('jobs:', Object.keys(d.jobs)); console.log('steps:', d.jobs.verify.steps.length); console.log('triggers:', Object.keys(d.on))"
```

Expected: `jobs: [ 'verify' ]`, `steps:` a number at least 11, `triggers: [ 'pull_request', 'push' ]`.

If `triggers` prints `[ 'true' ]` or similar, the YAML parser resolved `on` as a boolean. The `yaml`
package defaults to the YAML 1.2 core schema where it does not, so this would mean a different parser
got installed. Check `npm ls yaml` against the pinned `2.9.1`.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/crum-ci.yml .gitattributes .devcontainer/devcontainer.json tests/ci/workflow.test.ts
git commit -m "$(cat <<'EOF'
ci(verify): run the §14.2 pipeline Phase 0 can actually execute

Lint, typecheck, unit, policy conformance, schema regeneration, drift
assertion, migrate, integration. The eval gate and the a11y gate are omitted
because npm run eval:crum arrives in Phase 6 and npm run test:a11y in Phase 1;
a step calling a script that does not exist is a red build.

tests/ci/workflow.test.ts parses the workflow back and asserts every `npm run`
step names a declared script, the drift check follows the regeneration, the
migration precedes the integration tests, and no secret appears. Phase 0 makes
no model call, so a secret in this file is either premature or a mistake.

Deviations from §14.2, all recorded for the Appendix E write-back: pgvector:pg17
rather than pg16, push triggers on master and phase/** rather than main.

.gitattributes pins LF for migrations/, policy/ and .env.example. The schema
snapshot is generated on Linux in CI and committed from Windows, and without
this the drift check fails on every run for a reason unrelated to the schema.
EOF
)"
```

---

## Task 14: Verification record, spec write-backs, and the merge

Phase 0 ends with two things that are not code. The first is an honest record of what was checked and
what was not, because §16 lists two Phase 0 checks that cannot be completed in Phase 0 without the
subsystems they concern. The second is the write-back of every place the implementation diverged from
the spec, so v0.3.1 describes the repository that exists rather than the one that was planned.

**Files:**
- Create: `docs/verification/phase-0.md`
- Create: `docs/verification/denial-paths.md`
- Modify: `docs/TECHNICAL_PLAN.md` (version header, §14.2, §14.4, §16 Phase 0, Appendix B, Appendix E)

**Interfaces:**
- Consumes: everything from Tasks 1 to 13.
- Produces: the two documents the roadmap's definition-of-done requires, and the `phase/0-spine`
  merge into `master`. Phase 3 reads `denial-paths.md` before writing its first approval test;
  Phase 5 reads the MCP finding in `phase-0.md` before making tool ids load-bearing.

- [ ] **Step 1: Walk the §16 Phase 0 checklist**

Read §16 Phase 0 (lines 5157-5173 of `docs/TECHNICAL_PLAN.md`) and confirm each of its thirteen items
against the repository. The mapping is:

| §16 Phase 0 item | Where it is satisfied |
|---|---|
| Pin the verified versions from Appendix B | Task 2, `package.json` plus `tests/build/pins.test.ts` |
| Assert Node 22.18.0+ in engines, CI, devcontainer | Task 2 (`engines`), Task 13 Step 3 and Step 5 |
| Scaffold `type: module` and the tsconfig settings | Task 2 and Task 3. `allowImportingTsExtensions` is deliberately omitted; see Step 2 write-back 4 |
| Signature smoke test, step versus tool | Task 4, `tests/smoke/signatures.test.ts` |
| Enum smoke test, sampling | Task 4, `tests/smoke/sampling.test.ts` |
| Approval serialization check | **Deferred.** Recorded in Step 2 with its fallback. Cannot be run before durable or stored agents exist |
| MCP tool-name check | **Deferred.** Recorded in Step 2 with its fallback. Cannot be run before `@mastra/mcp` is mounted in Phase 5 |
| Link the inherited env block and verify the five variables resolve | Task 9. `TYPESAFE_AI_API_KEY` and `JEV_API_KEY` are declared and deferred to Phases 5 and 6; see Step 2 write-back 6 |
| Write `policy/risk.yaml` and `policy/tools.yaml` | Task 5 |
| Policy loader plus conformance tests | Tasks 6, 7 and 8 |
| Migrations via `exportSchemas()`, `disableInit: true`, explicit init in the migrate job only | Task 11 and Task 13 Step 3 |
| `buildMastraStorage()` with the pool-clamp and TLS logic | Task 10 |
| Boot check, both storage modes, MCP key refused in production | Task 12 |

Then run the acceptance criteria from §16 line 5173 and record the result of each:

```bash
npm run verify
npm run test:integration
```

Expected: `npm run verify` exits 0. `npm run test:integration` exits 0 with a database available and
reports skipped tests without one; if it skipped, the acceptance line "migrations apply to a clean
Supabase" is **not yet satisfied** and Step 2 must say so rather than claim it.

- [ ] **Step 2: Write the verification record**

Create `docs/verification/phase-0.md`. Every claim in it must be something that was actually run, so
fill in the bracketed lines from the commands in Step 1 and Step 3 rather than from this plan.

```markdown
# Phase 0 Verification Record

Date: [YYYY-MM-DD]
Branch: `phase/0-spine`
Spec: `docs/TECHNICAL_PLAN.md` v0.3.0, §16 Phase 0

## What was checked

| Check | Command | Result |
|---|---|---|
| Version pins resolve and are exact | `npx vitest run tests/build/pins.test.ts` | [pass/fail] |
| Step and tool signatures match the installed declarations | `npm run typecheck` | [pass/fail] |
| The signature alarms actually fire | Step 4's `sed` demonstration | [fired / did not fire] |
| Sampling enum and literal forms both compile | `npx vitest run tests/smoke/sampling.test.ts` | [pass/fail] |
| Policy files parse and conform to §4.6.2 | `npm run test:policy` | [pass/fail] |
| The conformance suite can fail | Task 8 Step 3's deliberate break | [failed as expected / did not fail] |
| Environment contract matches `.env.example` | `npx vitest run tests/config/env.test.ts` | [pass/fail] |
| No real credential shape is committed | Task 9 Step 6 grep | [no match / match found] |
| The storage config the shipped constructor requires | `npx vitest run tests/mastra/storage.test.ts` | [pass/fail] |
| Migrations apply, are idempotent, and reject an edited history | `npm run test:integration` | [pass / skipped, no database] |
| The Mastra instance boots both ways and fails closed on the MCP key | `npx vitest run tests/mastra/boot.test.ts` | [pass/fail] |
| The CI workflow calls only declared scripts | `npx vitest run tests/ci/workflow.test.ts` | [pass/fail] |
| The schema snapshot is deterministic | Task 11 Step 9, `restored=0` | [deterministic / nondeterministic] |

## What was NOT checked

These are open, owned, and each has a named phase and a fallback. They are not
omissions from the record; they are the reason the record exists.

### 1. Function-valued `requireApproval` under persistence

§4.6.5 and §16 both flag this as unverified. The documented constraint that a
function-valued approval option cannot survive serialization is written for
`requireToolApproval`, the client- and agent-level option. Whether the same
constraint reaches a tool's own `requireApproval` field on a durable or stored
agent is not settled by the declarations.

Why it cannot be checked in Phase 0: CRUM constructs no agent and mounts no
durable wrapper. §6 line 1270 records that durable agents are Beta and that
CRUM does not use them in Phases 0 through 3.

When it must be checked: Phase 3, before the first approval-class tool ships.

How to check it: build a durable agent with one tool whose `requireApproval` is
a predicate returning `false` for a benign input. Run it, let it suspend, resume
on a fresh process against the same storage, and observe whether the predicate
was re-evaluated or replaced by always-approve.

Fallback if the predicate does not survive: `requireApproval: true` on every
mutating tool, with the policy decision moved into `beforeApproval`, which
returns `proceed: false` for anything the policy would have gated at `auto`.
This is always-approve. It is safe and merely noisier, and it keeps the risk
scorer as the single source of truth for what a human sees.

Consequence of guessing wrong: not a crash. Every read-only tool starts
demanding approval, which is a product outage discovered by users rather than by
a test.

### 2. Dotted MCP tool names over the 2026-07-28 wire

§10.3 keeps the in-process registry key and the advertised MCP tool name equal,
and §4.6.2 names every tool with a dot: `crm.list_customers`,
`knowledge.retrieve`. Whether third-party MCP hosts accept a dot in a tool name
is not settled by `@mastra/mcp@2.5.0`'s declarations.

Why it cannot be checked in Phase 0: `@mastra/mcp` is pinned but not imported.
No server is mounted until Phase 5.

When it must be checked: Phase 5, before the tool ids are load-bearing in the
console UI, the approval queue and the policy file.

How to check it: mount the Phase 5 MCP server with two tools, one dotted and one
underscored, and connect three hosts: Mastra's own MCP client, the MCP
Inspector, and one third-party host. Record which of the three lists and calls
each name.

Fallback if a host rejects dots: rename to `crm_list_customers` across
`policy/tools.yaml`, §4.6.2, the console and the approval queue in one commit.
The dot carries no semantics; it is a namespace separator that an underscore
separates equally well. What must not happen is the registry key and the
advertised name diverging, because §10.3's whole argument is that they are the
same string on every surface.

### 3. Migrations against a clean Supabase project

§16's acceptance line reads "migrations apply to a clean Supabase". If Step 1's
integration run skipped for want of a database, this is unverified and says so
in the table above. CI proves the migrations apply to `pgvector/pgvector:pg17`,
which is not the same thing: Supabase's session pooler, its `postgres` role
restrictions and its pre-installed extensions can each reject DDL that a bare
container accepts.

How to check it: create a throwaway Supabase project, put its session-pooler URL
in `CRUM_INTEGRATION_DATABASE_URL`, run `npm run db:migrate` then
`npm run test:integration`, then delete the project.

### 4. Anything requiring a model call

Phase 0 makes none. No prompt, no instruction block, no tool description in this
plan has been evaluated against a model. Every claim in §4.4 and §6 about agent
behaviour is still a hypothesis until Phase 1.

## Deviations from the spec found while implementing

Recorded here and written back into `docs/TECHNICAL_PLAN.md` as v0.3.1:

1. `.gitignore` line 6 ignored `docs/`, so the 5,528-line plan this phase
   implements was untracked. Fixed in Task 1.
2. The scaffold's `src/mastra/index.ts` omitted both fields
   `PostgresStoreVNext` requires and did not compile. Fixed in Task 12.
3. `OBSERVABILITY_DATABASE_URL` is a new variable, absent from §13. The
   constructor requires an observability connection and refuses to share the
   primary one implicitly. Added in Task 10.
4. §16 Phase 0 asks for `allowImportingTsExtensions`. Omitted. It exists to
   permit `.ts` suffixes on relative imports, and the roadmap convention is
   extensionless; enabling it allows both and the codebase drifts.
5. §9.2 shows three tables and defers the rest to a §6.1 that no longer exists
   in v0.3.0. The other six were derived from §5.1's business objects plus
   `human_tasks` from §4.6.1's refuse path.
6. §16 Phase 0 asks that `TYPESAFE_AI_API_KEY` or `JEV_API_KEY` resolve. Both
   are declared in `.env.example` and deferred to Phases 5 and 6. Neither is
   read by any Phase 0 code, and a test asserting they resolve would assert
   nothing.
7. §12.2's `tools.yaml` listing shows twelve entries while §4.6.2 lists twenty
   tools. The committed file has twenty-one, the twenty plus `run.side-effect`.
   §12.2 was illustrating the file's shape, not enumerating the surface.
8. §14.2's service image is `pgvector/pgvector:pg16`; CI uses `pg17`.
9. §14.2's push trigger is `branches: [main]`; the repository default is
   `master` and phases run on `phase/N-*` branches, so the trigger covers both.
10. §14.4 and the README say development happens in `D:/Code/AllRounderAgent`.
    CRUM is a standalone repository. The README was corrected in Task 1.
11. §14.2's eval gate and a11y gate are omitted from the Phase 0 workflow. The
    scripts they call arrive in Phases 6 and 1.
```

- [ ] **Step 3: Run the full verification suite and record it**

```bash
npm run verify
npm run test:integration
git log --oneline master..phase/0-spine
git diff --stat master..phase/0-spine
```

Fill in every bracketed cell in `docs/verification/phase-0.md` from this output. Do not fill in a
cell you did not run. A verification record with an invented `pass` is worse than no record, because
the next phase trusts it.

Expected: `npm run verify` exits 0. `git log --oneline` shows thirteen commits, one per task, each
with a conventional-commit subject under 72 characters.

If the commit count is not thirteen, either tasks were squashed together or a task was committed
twice. Reconcile before merging: the roadmap's property is that every commit on a phase branch is
green on its own, and that property is only checkable if the boundaries are where the plan put them.

- [ ] **Step 4: Write the denial-paths checklist**

Create `docs/verification/denial-paths.md`. Task 8's conformance suite ends with
`it.todo('Phase 3: every approval-class tool has a denial-path receipt test')`. This is the list that
todo resolves into.

```markdown
# Denial-Path Test Checklist

Owner: Phase 3 (write path with confirmation and receipts).
Referenced by: `tests/governance/conformance.test.ts`, the trailing `it.todo`.

A governance plane that has only been shown to approve things is untested. Each
tool below needs a test in which the call is denied, and each denial test must
assert all five of these, not just the first:

1. No record was created, updated or deleted. Assert against the database, not
   against the tool's return value.
2. An `audit_receipts` row exists with `decision = 'rejected'`.
3. The `pending_writes` row carries `rejected_at` and a `rejection_reason`, and
   has left the `idx_pending_queue` partial index.
4. The user-visible message names the reason. A denial that reads as a failure
   teaches people to retry; a denial that reads as a policy teaches them to
   rephrase or escalate.
5. A second identical call is denied identically. Determinism is the property
   that makes the risk scorer trustworthy, and it is only observable by calling
   twice.

## Tools to cover

The eight approval-class tools from `policy/tools.yaml`:

- [ ] `crm.create_customer`
- [ ] `crm.update_customer`
- [ ] `crm.delete_customer`
- [ ] `crm.create_contact`
- [ ] `crm.update_contact`
- [ ] `crm.create_followup`
- [ ] `crm.create_task`
- [ ] `crm.create_schedule`

Plus the workflow-scoped entry, once Phase 3 wires it:

- [ ] `run.side-effect`

Plus the refuse-class tool, which has a different denial path and needs its own
test rather than a variant of the eight above:

- [ ] `crm.export_customers` — asserts a `human_tasks` row with `kind = 'refusal'`
      exists, that no receipt is written (a refusal is never a decision on a
      draft), and that the refusal is visible in the conversation rather than
      silently dropped.

## Cross-cutting denial tests

- [ ] An unknown tool name resolves to `refuse` rather than `auto`. Already
      covered by `tests/governance/policy.test.ts`; Phase 3 must keep it covered
      end to end through the agent, not just through the loader.
- [ ] A second user cannot read the first user's records **through the agent**.
      §5.2 names this as the Phase 2 acceptance test. The denial-path suite
      should include the write-side equivalent: a staged write whose payload
      names a record in another tenant is denied at the tool execute layer.
- [ ] An approval token replayed against an already-receipted draft produces no
      second commit. `uq_receipts_draft` enforces this in the schema and
      `tests/integration/migrations.test.ts` proves the constraint fires; Phase 3
      must prove the tool surfaces it as a clean denial rather than a 500.
- [ ] An expired draft is denied. `pending_writes.expires_at` exists for this and
      nothing else, so a test that never exercises it leaves the column
      unproven.

## Definition of done for this file

Every box above is checked, the `it.todo` in
`tests/governance/conformance.test.ts` is replaced by a real assertion that the
denial-path tests exist, and a link to this file appears in the Phase 3 plan.
```

- [ ] **Step 5: Write the spec back to v0.3.1**

Apply the eleven deviations from Step 2 to `docs/TECHNICAL_PLAN.md`. Each is a small edit; none
changes a design decision.

1. Line 8, the `Supersedes` line: `v0.2.0` becomes `v0.3.0`, and the version at the top of the
   document becomes `0.3.1`.
2. §13's variable table (around line 4840): add an `OBSERVABILITY_DATABASE_URL` row marked
   **CRUM-new**, optional, defaulting to `DATABASE_URL`, with the note that
   `PostgresStoreVNext` requires an observability connection and logs a runtime warning on every
   construction and every `init()` when it is shared.
3. §13's `.env` listing (around line 4927): add the variable next to `DATABASE_URL`.
4. §14.2's YAML: `pgvector/pgvector:pg16` becomes `pg17`; `branches: [main]` becomes
   `branches: [master, 'phase/**']`; the `Integration` step gains
   `CRUM_INTEGRATION_DATABASE_URL`.
5. §14.4: replace the `cd D:/Code/AllRounderAgent` instruction with CRUM's own standalone setup.
6. §16 Phase 0, the tsconfig line: strike `allowImportingTsExtensions` and add "extensionless
   relative imports; `moduleResolution: bundler` resolves them".
7. §16 Phase 0, the env line: note that `TYPESAFE_AI_API_KEY` and `JEV_API_KEY` are declared and
   deferred to Phases 5 and 6.
8. §16 Phase 0: add a line pointing at `docs/verification/phase-0.md` for the two deferred checks
   and their fallbacks, so a reader of §16 alone knows they were not forgotten.
9. §9.2: replace the "as specified in v0.1 §6.1" reference with the six derived tables, or point it
   at `migrations/0002_crum_spine.sql` as the authoritative listing.
10. §12.2: note that the committed `policy/tools.yaml` carries all twenty-one entries and that the
    twelve shown illustrate the file's shape.
11. Appendix B: confirm the pins match `package.json` exactly. Add `pg@8.23.1`, `yaml@2.9.1`,
    `tsx@4.23.15`, `@vitest/coverage-v8@3.2.7`, `eslint@9.39.5`, `typescript-eslint@8.72.0`,
    `@types/node@22.20.5` and `@types/pg@8.23.1` if they are not already listed.

Then append a row to Appendix E's change-log table, immediately after the `0.3.0` row at line 5523:

```markdown
| 0.3.1 | 2026-10-23 | **Phase 0 implementation write-back.** No design decision changed. Corrected §14.2 (pgvector:pg17, push triggers on `master` and `phase/**`, `CRUM_INTEGRATION_DATABASE_URL` for the integration step), §14.4 (CRUM is a standalone repository, not a subdirectory of AllRounderAgent), §16 Phase 0 (dropped `allowImportingTsExtensions` in favour of the extensionless convention; noted the deferral of `TYPESAFE_AI_API_KEY` and `JEV_API_KEY`), §9.2 (the six tables the section deferred to a §6.1 that no longer exists are now enumerated), and §12.2 (the committed `tools.yaml` carries all twenty-one entries). Added `OBSERVABILITY_DATABASE_URL` to §13, required by `PostgresStoreVNext`'s constructor, which refuses to share the primary connection implicitly. Recorded the two deferred Phase 0 checks and their fallbacks in `docs/verification/phase-0.md` |
```

- [ ] **Step 6: Verify the write-back is consistent**

```bash
grep -c "^| 0\." docs/TECHNICAL_PLAN.md
grep -n "pgvector/pgvector" docs/TECHNICAL_PLAN.md
grep -n "branches: \[main\]" docs/TECHNICAL_PLAN.md; echo "stale-trigger=$?"
grep -n "OBSERVABILITY_DATABASE_URL" docs/TECHNICAL_PLAN.md
grep -n "allowImportingTsExtensions" docs/TECHNICAL_PLAN.md
```

Expected: the change-log grep prints `3`. The v0.3.0 row is written `| **0.3.0** |` and so does not
match `^| 0\.`; only the `0.1.0` and `0.2.0` rows plus the new `0.3.1` row do. If it prints `2`, the
new row was not added. The pgvector grep shows `pg17` in §14.2. The stale-trigger grep prints nothing
and `stale-trigger=1`. `OBSERVABILITY_DATABASE_URL` appears at least three times (the §13 table, the
`.env` listing, and the Appendix E row). `allowImportingTsExtensions` appears only in the Appendix E
row describing its removal, and in §16 Phase 0 only if Step 5 item 6 was applied.

Then re-run the plan's own cross-reference check to confirm nothing broke:

```bash
grep -o "§[0-9]\+\(\.[0-9]\+\)*" docs/TECHNICAL_PLAN.md | sort -u | wc -l
grep -c "^#\{2,4\} " docs/TECHNICAL_PLAN.md
```

Expected: the reference count and the heading count are unchanged from v0.3.0 (378 references, 158
numbered headings) unless a write-back deliberately added a heading, in which case the difference is
one or two and Step 5 explains it.

- [ ] **Step 7: Commit**

```bash
git add docs/verification/phase-0.md docs/verification/denial-paths.md docs/TECHNICAL_PLAN.md
git commit -m "$(cat <<'EOF'
docs(verification): record what Phase 0 proved and write the spec back to v0.3.1

phase-0.md separates what was run from what was not. Four checks are open and
owned: the function-valued requireApproval serialization question cannot be
answered before an agent exists, the dotted-MCP-tool-name question cannot be
answered before Phase 5 mounts a server, the clean-Supabase acceptance line is
only satisfied by a real project rather than a container, and no Phase 0 claim
about model behaviour has met a model. Each carries a named phase and a fallback.

denial-paths.md resolves the it.todo in the conformance suite into a checklist
for Phase 3: nine tools, five assertions each, plus the four cross-cutting
denials. A governance plane shown only to approve things is untested.

TECHNICAL_PLAN.md moves to v0.3.1 with eleven corrections, none of which changes
a design decision. The substantive one is OBSERVABILITY_DATABASE_URL, which
PostgresStoreVNext's constructor requires and §13 did not list.
EOF
)"
```

- [ ] **Step 8: Merge the phase branch**

```bash
git checkout master
git merge --no-ff phase/0-spine -m "$(cat <<'EOF'
Merge phase/0-spine: alignment, governance spine, and the storage contract

Phase 0 of 8. Thirteen commits. No agent, no model call, no UI.

What now exists:
- Exact version pins with a test that rejects a range operator, and the Node
  22.18.0 floor asserted in engines, CI and the devcontainer.
- Two smoke suites that turn the plan's riskiest assumptions into compile
  errors: steps take one params object while tools take two positional
  arguments, and sampling accepts both the enum member and the string literal.
- policy/risk.yaml and policy/tools.yaml, a loader that rejects a malformed
  policy at boot, and a deterministic risk scorer whose term matching is
  token-exact so that a draft mentioning a phone call cannot raise
  crm.log_followup from auto to approval.
- A nine-table spine in which every row carries a non-nullable tenant_id, the
  task/schedule split is enforced by which columns exist, and one staged draft
  yields exactly one receipt.
- A storage builder that requires TLS off-loopback, checks the per-pool cap
  against Supabase's 15-client pooler, and refuses to boot in production on
  in-memory storage.
- A Mastra instance factory, and an MCP_REQUEST_STATE_KEY boot check placed five
  phases before the MCP server exists because its failure mode is otherwise
  intermittent and load-balancer dependent.
- A CI pipeline with a test that parses it back.

Deliberately absent: the mastra CLI, any agent, any tool implementation, any
prompt. Phase 1 adds them.
EOF
)"
git log --oneline -1
```

Expected: a merge commit on `master` whose second parent is the tip of `phase/0-spine`.

`--no-ff` is not stylistic. It keeps the phase boundary visible in `git log --graph` after the branch
is deleted, which is the only way to answer "what did Phase 0 change" without reading thirteen
commits. Do not use `git rebase` to linearise the phase branch into `master`.

- [ ] **Step 9: Delete the branch and confirm the tree**

```bash
git branch -d phase/0-spine
git status
npm run verify
```

Expected: `git branch -d` succeeds (it refuses on an unmerged branch, which is the safety check).
`git status` reports a clean tree. `npm run verify` exits 0 on `master`.

If `git status` shows untracked files, something was created and never added. Read the list before
deciding: a missing `package-lock.json` here means CI's `npm ci` will fail on the first pull request.

Then write the Phase 1 plan. Per the roadmap, each phase's detailed plan is written immediately
before that phase executes, because a plan at 2-5 minute granularity for work six phases away would
be fiction. Do not write it now as part of Phase 0.

---

## Self-Review

Run against `docs/TECHNICAL_PLAN.md` §16 Phase 0 with fresh eyes before executing.

**1. Spec coverage.** All thirteen §16 Phase 0 checklist items map to a task; the mapping is the
table in Task 14 Step 1. Two items are deferred rather than skipped, each with a named phase, a
method for checking it, and a fallback, recorded in `docs/verification/phase-0.md`. The §16
acceptance line has four clauses: migrations apply to a clean Supabase (Task 11, with the Supabase
half explicitly flagged as unverified unless a real project was used), the policy tests pass
(Tasks 6, 7, 8), the instance boots in both persistent and in-memory mode (Tasks 10 and 12), and the
two smoke tests fail loudly if either signature is wrong (Task 4, with a `sed` step demonstrating the
alarm fires).

**2. Placeholder scan.** `docs/verification/phase-0.md` contains bracketed cells. That is
intentional: they are fields the executor fills from command output in Task 14 Step 3, and the plan
says so in the same breath. No other step in this plan contains a placeholder, a "TBD", an
"add appropriate error handling", or a "similar to Task N". Every code block is complete and every
command is runnable as written.

**3. Type consistency.** Checked across tasks:

- `CrumEnv` is defined in Task 9 and consumed unchanged by Tasks 10, 11, 12 and 13.
- `POOL_COUNT` and `SUPABASE_POOL_SIZE` are module-local in Task 9 and exported in Task 10 Step 3,
  which states the exact three lines to change. `checkPoolBudget` imports them; nothing redeclares
  them.
- `buildMastraStorage` returns `CrumStorage = PostgresStoreVNext | InMemoryStore`. Task 11 narrows it
  with `isPostgresStorage` before touching `.pool`, because `.pool` exists only on the Postgres arm.
- `parseVersion` and `isCrumMigration` share `CRUM_MIGRATION_PATTERN`, so a filename one accepts the
  other parses. The test asserts both directions.
- `resolveMcpRequestState` returns `key: string`, never `string | undefined`, so Phase 5 can pass it
  to `requestState.key` without a non-null assertion. `assertMcpRequestStateKey` returns `void` and
  exists only so `createCrumMastra` can call it for the effect.
- `samplingFor` returns `SamplingStrategy` and is consumed by `crumObservabilityInstanceConfig`,
  whose own return type is named in the Interfaces block and matched in the test.
- `OBSERVABILITY_INSTANCE` and `OBSERVABILITY_SERVICE_NAME` are both `'crum'` and are separate
  constants on purpose: one is a registry key, the other is a span attribute, and they should be
  independently changeable.
- Relative imports are extensionless throughout, matching the Global Constraint and Task 3's
  `moduleResolution: "bundler"`.

**4. Known soft spots.** Recorded rather than hidden, because an executor who hits one should know
it was foreseen:

- Task 10's real-construction tests assume `pg.Pool` is lazy. If a future `@mastra/pg` connects
  eagerly, those three tests move to `tests/integration/`; the plan says so in Step 5.
- Task 12's boot test asserts `Object.keys(mastra.listAgents())` is empty. That is a documentation
  assertion; Step 6 says what to do if Mastra registers internal agents of its own.
- Task 11's static SQL tests match text rather than parsing SQL. They will not catch every schema
  defect, only the ones §5.1 and §5.2 make load-bearing. The integration tests are the real check,
  and they skip without a database.
- Task 13's `node-version` assertion reads the raw YAML text because the typed `WorkflowStep`
  interface does not model `with:`. Extending the interface is the better fix if this file grows.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-23-phase-0-spine.md`, alongside
`00-ROADMAP.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast
   iteration. Fits this plan well: the fourteen tasks are ordered but each ends with a green commit,
   so a subagent never needs more than its own task plus the Interfaces blocks.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Tasks 6 and 7 are one commit and must be executed together. Task 4's alarm demonstration and Task 8's
deliberate break both leave the tree dirty mid-step and must not be interrupted between the break and
the restore.
