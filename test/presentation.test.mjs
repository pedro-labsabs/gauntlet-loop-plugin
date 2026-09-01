import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitialState, runGauntletAction } from '../lib/core.js'
import { renderDashboard } from '../lib/presentation.js'

test('dashboard shows phase, bar, units, progress, and next action', () => {
  const state = createInitialState()
  runGauntletAction(state, { action: 'submit', command: 'Build checkout.' }, { now: 1, runId: 'run-42' })
  runGauntletAction(state, {
    action: 'refine',
    refinedCommand: 'Build checkout with p95 under 100 ms.',
    bar: {
      name: 'Stripe Checkout',
      fetchHow: 'Open https://stripe.com and capture checkout.',
      compareHow: 'Compare both artifacts side by side without labels.',
      description: '',
    },
  }, { now: 2 })
  const result = runGauntletAction(state, {
    action: 'split',
    pieces: [{ id: 'p1', title: 'Shell', description: 'Judge shell separately.' }],
  }, { now: 3 })
  const view = renderDashboard(result)
  assert.match(view, /GAUNTLET LOOP/)
  assert.match(view, /Stripe Checkout/)
  assert.match(view, /0\/1 units won/)
  assert.match(view, /p1  Shell/)
  assert.match(view, /NEXT  build piece\[0\]/)
})
