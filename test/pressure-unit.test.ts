import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pressureOf, type StepAgent, type StepDeps } from '../src/host/step.ts'

type RequestHeader = ReturnType<StepAgent['session']['requestHeader']>

function gauge(header: RequestHeader, contextWindow = 50_000) {
  const session: StepAgent['session'] = {
    requestHeader: () => header,
    surface: { nodes: [], replaceGeneration: 0 },
    seq: 0,
    eventAt: () => undefined,
    deriveEventMessage: () => null,
    append: () => assert.fail('gauge must not write to the log'),
  }
  const measurements: unknown[][] = []
  const requests: unknown[][] = []
  const deps: StepDeps = {
    get client() { return assert.fail('gauge must not start the engine') },
    settings: { activation: 0.65 },
    stats: new WeakMap(),
    meter: () => ({
      estimateMessage: () => assert.fail('gauge must price the routed request, not guess'),
      measure: (...args) => { measurements.push(args); return { totalTokens: 12_345, nodes: [] } },
    }),
    resolveModelInfo: async (...args) => { requests.push(args); return { context: { contextWindow }, defaultMaxTokens: 12_000 } },
    backendFor: () => ({ config: {
      thresholdRatio: 0.8, headroomTokens: 20_000,
      modelPolicies: [{ provider: 'provider', model: 'model', thresholdRatio: 0.8, headroomTokens: 2500 }],
    } }),
  }
  return { agent: { session }, deps, measurements, requests }
}

test('pressure prices the routed request and uses its output cap before the model default', async t => {
  for (const [cap, trigger, starts] of [[5000, 40_000, 26_000], [undefined, 35_500, 23_075]] as const) {
    await t.test(cap === undefined ? 'model default' : 'request cap', async () => {
      const header = { config: { provider: 'provider', model: 'model', ...(cap === undefined ? {} : { maxTokens: cap }) } }
      const signal = new AbortController().signal
      const { agent, deps, measurements, requests } = gauge(header)
      assert.deepEqual(await pressureOf(deps, agent, signal), { ok: true, pressure: {
        header, tokens: 12_345, contextWindow: 50_000, stockTrigger: trigger, startsAt: starts,
      } })
      assert.deepEqual(requests, [['provider', 'model', signal]])
      assert.deepEqual(measurements, [[agent.session, header]])
    })
  }
})

test('an unusable routed context is not priced or reported as an available gauge', async () => {
  const { agent, deps, requests, measurements } = gauge({ config: { provider: 'provider', model: 'model' } }, 10_000)
  assert.deepEqual(await pressureOf(deps, agent), { ok: false, reason: 'unusable_context_window' })
  assert.deepEqual(requests, [['provider', 'model', undefined]])
  assert.deepEqual(measurements, [])
})
