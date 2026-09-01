/**
 * Host-side projection unit tests: fold over synthetic SessionEvent objects,
 * verify the DTO output, and cover the tail-only / prepend / live==reload /
 * session isolation / stateVersion / sticky BLOCKED scenarios.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitialProjectionState, applyProjectionEvent, projectionToDTO } from '../lib/projection.js'
import { GAUNTLET_PRESENTATION_VERSION } from '../lib/core.js'

// ---- helpers ----

const BAR = { name: 'Stripe Checkout demo', fetchHow: 'Open https://stripe.com/payments/checkout', compareHow: 'blind A/B compare' }
const PIECES = [
  { id: 'p1', title: 'Checkout shell', description: 'Independent shell.' },
  { id: 'p2', title: 'Payment form', description: 'Independent form.' },
]

function callEvent(seq, callId, action, extra = {}) {
  return {
    type: 'tool/call',
    seq,
    time: seq * 1000,
    data: { turn: 1, step: 1, callId, name: 'gauntlet_loop', arguments: JSON.stringify({ action, ...extra }) },
  }
}

function resultEvent(seq, callId, ok, phase, next, extra = {}) {
  const pres = { version: GAUNTLET_PRESENTATION_VERSION, phase, next: next ?? null }
  if (extra.presError) pres.error = extra.presError
  if (extra.presRejections) pres.rejections = extra.presRejections
  if (extra.presNextPieceIdx !== undefined) pres.nextPieceIndex = extra.presNextPieceIdx
  return {
    type: 'tool/result',
    seq,
    time: seq * 1000,
    data: {
      turn: 1, step: 1,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [], isError: false }], source: { kind: 'tool', callId } },
      meta: { protocol: 1, schema: 2, ok, fingerprint: 'fp', presentation: pres },
    },
  }
}

function foldAll(events) {
  let state = createInitialProjectionState()
  for (const event of events) {
    state = applyProjectionEvent(state, event)
  }
  return projectionToDTO(state)
}

// ---- Tests ----

test('initial state is idle with submit next', () => {
  const dto = projectionToDTO(createInitialProjectionState())
  assert.equal(dto.available, true)
  assert.equal(dto.phase, 'idle')
  assert.equal(dto.next, 'submit')
  assert.equal(dto.total, 0)
  assert.equal(dto.status, 'running')
})

test('1. idle -> submit -> refine -> split -> build -> critique OURS -> won', () => {
  const events = [
    callEvent(1, 'c1', 'submit', { command: 'Build checkout.' }),
    resultEvent(2, 'c1', true, 'refine', 'refine'),
    callEvent(3, 'c2', 'refine', { refinedCommand: 'Objective.', bar: BAR }),
    resultEvent(4, 'c2', true, 'split', 'split'),
    callEvent(5, 'c3', 'split', { pieces: PIECES }),
    resultEvent(6, 'c3', true, 'loop', 'build', { presNextPieceIdx: 0 }),
    callEvent(7, 'c4', 'build', { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/a.ts', summary: 's' } }),
    resultEvent(8, 'c4', true, 'loop', 'critique', { presNextPieceIdx: 0 }),
    callEvent(9, 'c5', 'critique', { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: 'wins', evidence: 'blind A/B', blind: true } }),
    resultEvent(10, 'c5', true, 'report', 'complete'),
  ]
  const dto = foldAll(events)
  assert.equal(dto.available, true)
  assert.equal(dto.phase, 'report')
  assert.equal(dto.barName, 'Stripe Checkout demo')
  assert.equal(dto.total, 2)
  assert.equal(dto.won, 1)
  assert.equal(dto.next, 'complete')
  assert.equal(dto.status, 'running')
  assert.equal(dto.units.length, 2)
  assert.equal(dto.units[0].status, 'won')
  assert.equal(dto.units[0].rounds.length, 1)
  assert.equal(dto.units[0].rounds[0].builder, 'b1')
  assert.equal(dto.units[0].rounds[0].critic, 'c1')
  assert.equal(dto.units[0].rounds[0].winner, 'ours')
})

test('2. sticky BLOCKED: rejected then accepted clears blocked, status running', () => {
  const events = [
    callEvent(1, 'c1', 'submit', { command: 'Go' }),
    resultEvent(2, 'c1', true, 'refine', 'refine'),
    callEvent(3, 'c2', 'refine', { refinedCommand: 'Modern.', bar: BAR }),
    resultEvent(4, 'c2', false, 'refine', 'refine', { presError: 'gate failed', presRejections: ['subjective terms'] }),
    callEvent(5, 'c3', 'refine', { refinedCommand: 'Specific.', bar: BAR }),
    resultEvent(6, 'c3', true, 'split', 'split'),
  ]
  const dto = foldAll(events)
  assert.equal(dto.available, true)
  assert.equal(dto.blocked, null)
  assert.equal(dto.status, 'running')
  assert.equal(dto.phase, 'split')
  assert.equal(dto.barName, 'Stripe Checkout demo')
})

test('3. sticky BLOCKED: rejected then accepted build/critique clears blocked', () => {
  const events = [
    callEvent(1, 'c1', 'submit', { command: 'Go' }),
    resultEvent(2, 'c1', true, 'refine', 'refine'),
    callEvent(3, 'c2', 'refine', { refinedCommand: 'Objective.', bar: BAR }),
    resultEvent(4, 'c2', true, 'split', 'split'),
    callEvent(5, 'c3', 'split', { pieces: [{ id: 'p1', title: 'Test', description: 'D.' }] }),
    resultEvent(6, 'c3', true, 'loop', 'build', { presNextPieceIdx: 0 }),
    callEvent(7, 'c4', 'build', { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 's' } }),
    resultEvent(8, 'c4', true, 'loop', 'critique', { presNextPieceIdx: 0 }),
    callEvent(9, 'c5', 'critique', { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: 'n', evidence: 'e', blind: true } }),
    resultEvent(10, 'c5', false, 'loop', 'critique', { presError: 'invalid', presRejections: ['not blind'] }),
    callEvent(11, 'c6', 'critique', { pieceIndex: 0, criticSubagentId: 'c2', verdict: { winner: 'ours', notes: 'n', evidence: 'e', blind: true } }),
    resultEvent(12, 'c6', true, 'loop', 'build', { presNextPieceIdx: 1 }),
  ]
  const dto = foldAll(events)
  assert.equal(dto.available, true)
  assert.equal(dto.blocked, null)
  assert.equal(dto.status, 'running')
  assert.equal(dto.phase, 'loop')
  assert.equal(dto.units[0].status, 'won')
})

test('4. rejected first call surfaces blocked panel', () => {
  const events = [
    callEvent(1, 'c1', 'submit', { command: 'Go' }),
    resultEvent(2, 'c1', false, 'idle', 'submit', { presError: 'empty command', presRejections: ['command empty'] }),
  ]
  const dto = foldAll(events)
  assert.equal(dto.available, true)
  assert.equal(dto.status, 'blocked')
  assert.equal(dto.phase, 'idle')
  assert.equal(dto.next, 'submit')
  assert.ok(dto.blocked !== null)
  assert.equal(dto.blocked?.error, 'empty command')
  assert.deepEqual(dto.blocked?.rejections, ['command empty'])
})

test('5. missing meta -> unavailable', () => {
  let state = createInitialProjectionState()
  state = applyProjectionEvent(state, { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'gauntlet_loop', arguments: '{"action":"submit"}' } })
  state = applyProjectionEvent(state, { type: 'tool/result', seq: 2, time: 2000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], source: { kind: 'tool', callId: 'c1' } } } })
  const dto = projectionToDTO(state)
  assert.equal(dto.available, false)
})

test('6. incompatible presentation version -> unavailable', () => {
  let state = createInitialProjectionState()
  state = applyProjectionEvent(state, { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'gauntlet_loop', arguments: '{"action":"submit"}' } })
  state = applyProjectionEvent(state, { type: 'tool/result', seq: 2, time: 2000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], source: { kind: 'tool', callId: 'c1' } }, meta: { protocol: 1, schema: 2, ok: true, fingerprint: 'fp', presentation: { version: 99, phase: 'refine', next: 'refine' } } } })
  const dto = projectionToDTO(state)
  assert.equal(dto.available, false)
})

test('7. live == reload: incremental fold == full fold from scratch', () => {
  const events = [
    callEvent(1, 'c1', 'submit', { command: 'Go' }),
    resultEvent(2, 'c1', true, 'refine', 'refine'),
    callEvent(3, 'c2', 'refine', { refinedCommand: 'Objective.', bar: BAR }),
    resultEvent(4, 'c2', true, 'split', 'split'),
    callEvent(5, 'c3', 'split', { pieces: PIECES }),
    resultEvent(6, 'c3', true, 'loop', 'build', { presNextPieceIdx: 0 }),
  ]
  let state = createInitialProjectionState()
  for (const event of events) state = applyProjectionEvent(state, event)
  const incrementalDTO = projectionToDTO(state)
  const fullDTO = foldAll(events)
  assert.deepEqual(incrementalDTO, fullDTO)
})

test('8. session isolation: two independent fold states', () => {
  const eventsA = [
    callEvent(1, 'c1', 'submit', { command: 'A' }),
    resultEvent(2, 'c1', true, 'refine', 'refine'),
  ]
  const eventsB = [
    callEvent(1, 'c1', 'submit', { command: 'B' }),
    resultEvent(2, 'c1', true, 'refine', 'refine'),
    callEvent(3, 'c2', 'halt', { reason: 'done' }),
    resultEvent(4, 'c2', true, 'halted', null),
  ]
  const dtoA = foldAll(eventsA)
  const dtoB = foldAll(eventsB)
  assert.equal(dtoA.phase, 'refine')
  assert.equal(dtoB.phase, 'halted')
  assert.equal(dtoA.status, 'running')
  assert.equal(dtoB.status, 'halted')
})

test('9. malformed args still yield an available projection', () => {
  let state = createInitialProjectionState()
  state = applyProjectionEvent(state, { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'gauntlet_loop', arguments: 'not json' } })
  state = applyProjectionEvent(state, { type: 'tool/result', seq: 2, time: 2000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], source: { kind: 'tool', callId: 'c1' } }, meta: { protocol: 1, schema: 2, ok: true, fingerprint: 'fp', presentation: { version: 1, phase: 'loop', next: 'build' } } } })
  const dto = projectionToDTO(state)
  assert.equal(dto.available, true)
  assert.equal(dto.phase, 'loop')
})

test('10. non-gauntlet events return the same state reference (Object.is gate)', () => {
  const state = createInitialProjectionState()
  const unrelated = { type: 'user/message', seq: 99, time: 99000, data: { content: [], source: 'test' } }
  const next = applyProjectionEvent(state, unrelated)
  assert.ok(Object.is(state, next))
})

test('11. non-gauntlet tool/result without matching pending returns the same state', () => {
  const state = createInitialProjectionState()
  const otherResult = { type: 'tool/result', seq: 1, time: 1000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'other', content: [], isError: false }], source: { kind: 'tool', callId: 'other' } } } }
  const next = applyProjectionEvent(state, otherResult)
  assert.ok(Object.is(state, next))
})
