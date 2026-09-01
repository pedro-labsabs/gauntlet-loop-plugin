import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitialState, runGauntletAction } from '../lib/core.js'

const bar = {
  name: 'Stripe Checkout demo',
  fetchHow: 'Open https://stripe.com/payments/checkout and capture the relevant reference.',
  compareHow: 'Compare artifact and reference side by side without labels, then pick one winner.',
  description: 'Named visual and interaction reference.',
}

function act(state, action, extra = {}, now = 1_000) {
  return runGauntletAction(state, { action, ...extra }, { now, runId: 'run-test' })
}

function enterLoop(state, pieces = [{ id: 'p1', title: 'Checkout shell', description: 'Implement the independently judgeable checkout shell.' }]) {
  assert.equal(act(state, 'submit', { command: 'Implement checkout shell with measurable latency and layout constraints.' }).ok, true)
  assert.equal(act(state, 'refine', { refinedCommand: 'Implement checkout shell with p95 interaction latency under 100 ms.', bar }).ok, true)
  assert.equal(act(state, 'split', { pieces }).ok, true)
  assert.equal(state.phase, 'loop')
}

test('refine rejects unresolved subjective terms and vague bars', () => {
  const state = createInitialState()
  act(state, 'submit', { command: 'Make it modern and beautiful.' })
  const out = act(state, 'refine', {
    refinedCommand: 'Make it modern and beautiful.',
    bar: { name: 'something', fetchHow: 'search online', compareHow: 'compare' },
  })
  assert.equal(out.ok, false)
  assert.match(out.rejections.join(' '), /modern/)
  assert.match(out.rejections.join(' '), /beautiful/)
  assert.match(out.rejections.join(' '), /fetchHow/)
  assert.equal(state.phase, 'refine')
})

test('cannot critique before a valid build', () => {
  const state = createInitialState()
  enterLoop(state)
  const out = act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-1',
    verdict: { winner: 'ours', notes: 'wins', evidence: 'observed', blind: true },
  })
  assert.equal(out.ok, false)
  assert.match(out.error, /Não existe build pendente/)
})

test('build requires a new builder and a real artifact location', () => {
  const state = createInitialState()
  enterLoop(state)
  assert.equal(act(state, 'build', { pieceIndex: 0, artifact: { location: '', summary: '' } }).ok, false)
  assert.equal(act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-1',
    artifact: { location: 'src/checkout.ts', summary: 'Implemented shell.' },
  }).ok, true)
  assert.equal(act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-2',
    artifact: { location: 'src/checkout.ts', summary: 'Second build before critique.' },
  }).ok, false)
})

test('critic must be fresh, separate, blind, and evidence-backed', () => {
  const state = createInitialState()
  enterLoop(state)
  act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-1',
    artifact: { location: 'src/checkout.ts', summary: 'Implemented shell.' },
  })
  assert.equal(act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'builder-1',
    verdict: { winner: 'ours', notes: 'same agent', evidence: 'x', blind: true },
  }).ok, false)
  assert.equal(act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-1',
    verdict: { winner: 'ours', notes: 'not blind', evidence: 'x', blind: false },
  }).ok, false)
  assert.equal(act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-1',
    verdict: { winner: 'ours', notes: 'blind but no evidence', evidence: '', blind: true },
  }).ok, false)
})

test('bar win forces rebuild; ours win advances to report and complete', () => {
  const state = createInitialState()
  enterLoop(state)
  assert.equal(act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-1',
    artifact: { location: 'src/checkout.ts', summary: 'Round one.' },
  }).ok, true)
  const failRound = act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-1',
    verdict: { winner: 'bar', notes: 'Reference has clearer hierarchy.', evidence: 'A/B capture shows reference hierarchy wins.', blind: true },
  })
  assert.equal(failRound.ok, true)
  assert.equal(state.piecesState[0].status, 'rebuild')
  assert.equal(failRound.next, 'build')

  assert.equal(act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-2',
    artifact: { location: 'src/checkout.ts', summary: 'Round two with hierarchy fix.' },
  }).ok, true)
  const winRound = act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-2',
    verdict: { winner: 'ours', notes: 'Artifact now wins the blind comparison.', evidence: 'Blind A/B chose artifact for hierarchy and latency target passes.', blind: true },
  })
  assert.equal(winRound.ok, true)
  assert.equal(state.phase, 'report')
  assert.equal(winRound.next, 'complete')

  const done = act(state, 'complete', { summary: { outcome: 'Checkout shell beat the bar.', lessons: 'Hierarchy was the key defect.' } }, 2_000)
  assert.equal(done.ok, true)
  assert.equal(state.phase, 'done')
  assert.equal(state.finishedAt, 2_000)
})

test('reusing a critic context in a later round is rejected', () => {
  const state = createInitialState()
  enterLoop(state)
  act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-1',
    artifact: { location: 'a', summary: 'r1' },
  })
  act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-1',
    verdict: { winner: 'bar', notes: 'bar wins', evidence: 'comparison evidence', blind: true },
  })
  act(state, 'build', {
    pieceIndex: 0,
    builderSubagentId: 'builder-2',
    artifact: { location: 'a', summary: 'r2' },
  })
  const out = act(state, 'critique', {
    pieceIndex: 0,
    criticSubagentId: 'critic-1',
    verdict: { winner: 'ours', notes: 'ours wins', evidence: 'comparison evidence', blind: true },
  })
  assert.equal(out.ok, false)
  assert.match(out.error, /já foi usado/)
})
