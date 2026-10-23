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
    const wrong: ToolExecuteFunction<{ n: number }, { doubled: number }, unknown, unknown> =
      // @ts-expect-error `context` and `runtimeContext` are not keys of the tool input.
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
    // `<unknown>` is explicit on purpose. Omit it and TypeScript reverse-infers
    // `Values` from the entries, which narrows `get` to `keyof Values` and turns
    // the 'missing' lookup below into a compile error. A tenant resolver reads
    // keys it never declared, so this test needs the open form — the
    // declaration's own doc comment sends runtime-only keys to `getRaw` for
    // exactly that reason, and `Values = unknown` keeps `get` accepting any
    // string. `as const` is not needed inline, where contextual typing already
    // supplies the tuple shape, but it keeps these entries tuples if they are
    // ever lifted into a variable — inference would widen them to `string[][]`
    // there and the constructor would reject them.
    const rc = new RequestContext<unknown>([['tenantSlug', 'acme'], ['userId', 'u1']] as const)
    expect(rc.get('tenantSlug')).toBe('acme')
    expect(rc.get('missing')).toBeUndefined()
  })
})
