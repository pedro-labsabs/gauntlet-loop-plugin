/**
 * Deterministic tests for durable Gauntlet reconstruction from the session
 * event log.
 *
 * The session log is the single durable source of truth.  A `gauntlet_loop`
 * call is recorded as a `tool/call` event (raw arguments JSON) followed by a
 * `tool/result` event (carrying the callId in its message source).  These are
 * native DSH events that persist across restarts.  Reconstruction replays the
 * SETTLED calls through `runGauntletAction` to reproduce the canonical state.
 *
 * "Restart" is simulated by building the event log, discarding the in-memory
 * state, and reconstructing from the events alone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitialState, runGauntletAction } from '../lib/core.js'
import {
  findCallTime,
  reconstructFromSessionEvents,
  validateReconstructedState,
} from '../lib/replay.js'

const BAR = {
  name: 'Stripe Checkout demo',
  fetchHow: 'Open https://stripe.com/payments/checkout and capture the reference.',
  compareHow: 'Compare artifact and reference side by side without labels, then pick one winner.',
  description: 'Named visual and interaction reference.',
}

const PIECES = [
  { id: 'p1', title: 'Checkout shell', description: 'Implement the independently judgeable checkout shell.' },
  { id: 'p2', title: 'Payment form', description: 'Implement the independently judgeable payment form.' },
]

// ---- helpers ----

/**
 * Simulate the agent loop recording a gauntlet_loop call: append a
 * `tool/call` event (with raw arguments) and then a `tool/result` event whose
 * message source carries the same callId.  Returns the grown log.
 */
function recordCall(log, callId, args, time) {
  log.push({
    type: 'tool/call',
    seq: log.length,
    time,
    data: { turn: 1, step: 1, callId, name: 'gauntlet_loop', arguments: JSON.stringify(args) },
  })
  log.push({
    type: 'tool/result',
    seq: log.length,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `m-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError: false }],
      },
    },
    sourceEventSeqs: [log.length - 2],
    surfaceOp: 'append',
  })
  return log
}

/** Apply a live action to a state, recording the call in the log as DSH would. */
function actAndRecord(log, state, callId, args, time) {
  recordCall(log, callId, args, time)
  runGauntletAction(state, args, { now: time, runId: callId })
}

/** Drive a full run to completion, recording every call in the log. */
function runFullGauntlet(log) {
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout with measurable constraints.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout with p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  // p1 round 1 loses to bar.
  actAndRecord(log, state, 'call-4', { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r1' } }, t++)
  actAndRecord(log, state, 'call-5', { action: 'critique', pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'bar', notes: 'bar wins r1', evidence: 'A/B shows bar wins', blind: true } }, t++)
  // p1 round 2 wins.
  actAndRecord(log, state, 'call-6', { action: 'build', pieceIndex: 0, builderSubagentId: 'b2', artifact: { location: 'src/p1.ts', summary: 'r2' } }, t++)
  actAndRecord(log, state, 'call-7', { action: 'critique', pieceIndex: 0, criticSubagentId: 'c2', verdict: { winner: 'ours', notes: 'p1 wins r2', evidence: 'Blind A/B chose artifact', blind: true } }, t++)
  // p2 wins.
  actAndRecord(log, state, 'call-8', { action: 'build', pieceIndex: 1, builderSubagentId: 'b3', artifact: { location: 'src/p2.ts', summary: 'r1' } }, t++)
  actAndRecord(log, state, 'call-9', { action: 'critique', pieceIndex: 1, criticSubagentId: 'c3', verdict: { winner: 'ours', notes: 'p2 wins', evidence: 'Blind A/B chose artifact', blind: true } }, t++)
  actAndRecord(log, state, 'call-10', { action: 'complete', summary: { outcome: 'All units won the bar.', lessons: 'hierarchy mattered' } }, t++)
  return state
}

// ---- 1. Restart: reconstruct and continue from the exact point ----

test('restart: partial run is reconstructed and continues at the exact point', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  // Stop mid-loop: p1 awaiting_critique.
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  actAndRecord(log, state, 'call-4', { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r1' } }, t++)

  // "Restart": discard the live state, reconstruct from the log only.
  const { state: rebuilt, error } = reconstructFromSessionEvents(log)
  assert.equal(error, undefined)
  assert.equal(rebuilt.phase, 'loop')
  assert.equal(rebuilt.runId, 'call-1')
  assert.equal(rebuilt.rawCommand, 'Build checkout.')
  assert.equal(rebuilt.refinedCommand, 'Build checkout p95 under 100 ms.')
  assert.deepEqual(rebuilt.bar, BAR)
  assert.equal(rebuilt.pieces.length, 2)
  assert.equal(rebuilt.piecesState[0].status, 'awaiting_critique')
  assert.equal(rebuilt.piecesState[0].rounds.length, 1)
  assert.equal(rebuilt.piecesState[0].rounds[0].builderSubagentId, 'b1')
  assert.equal(rebuilt.piecesState[0].rounds[0].verdict, null)

  // Continue exactly where we left: next action is critique of piece 0.
  const result = runGauntletAction(rebuilt, { action: 'critique', pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: 'p1 wins', evidence: 'Blind A/B chose artifact', blind: true } }, { now: t++, runId: 'call-5' })
  assert.equal(result.ok, true)
  assert.equal(rebuilt.piecesState[0].status, 'won')
  assert.equal(rebuilt.phase, 'loop')
})

// ---- 2. Round in progress: awaiting_critique stays awaiting critique ----

test('round in progress: piece awaiting_critique is not auto-won and next step is critique', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  actAndRecord(log, state, 'call-4', { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r1' } }, t++)

  const { state: rebuilt } = reconstructFromSessionEvents(log)
  assert.equal(rebuilt.piecesState[0].status, 'awaiting_critique')

  // Replaying must NOT auto-win the piece: reconstruction applies only the
  // settled actions in the log; no verdict exists yet.
  assert.equal(rebuilt.piecesState[0].rounds[0].verdict, null)

  // The next protocol step for the lead is still critique.
  const statusResult = runGauntletAction(rebuilt, { action: 'status' }, { now: t, runId: 'x' })
  assert.equal(statusResult.next, 'critique')
  assert.equal(statusResult.nextPieceIndex, 0)
})

// ---- 3. Rebuild: bar win persists across restart ----

test('rebuild: bar verdict survives restart and piece still requires rebuild', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  actAndRecord(log, state, 'call-4', { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r1' } }, t++)
  actAndRecord(log, state, 'call-5', { action: 'critique', pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'bar', notes: 'bar wins', evidence: 'A/B shows bar wins', blind: true } }, t++)

  const { state: rebuilt } = reconstructFromSessionEvents(log)
  assert.equal(rebuilt.piecesState[0].status, 'rebuild')
  assert.equal(rebuilt.piecesState[0].rounds[0].verdict.winner, 'bar')

  // Rebuild is still required: build with a NEW builder is accepted,
  // and reusing the old builder is rejected by the core.
  const reuse = runGauntletAction(rebuilt, { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r2' } }, { now: t++, runId: 'x' })
  assert.equal(reuse.ok, false)

  const fresh = runGauntletAction(rebuilt, { action: 'build', pieceIndex: 0, builderSubagentId: 'b2', artifact: { location: 'src/p1.ts', summary: 'r2' } }, { now: t++, runId: 'x' })
  assert.equal(fresh.ok, true)
})

// ---- 4. Terminal state: done and halted stay terminal ----

test('terminal: done state stays done after reconstruction', () => {
  const log = []
  const liveState = runFullGauntlet(log)
  assert.equal(liveState.phase, 'done')

  const { state: rebuilt, error } = reconstructFromSessionEvents(log)
  assert.equal(error, undefined)
  assert.equal(rebuilt.phase, 'done')
  assert.equal(rebuilt.summary?.outcome, 'All units won the bar.')
  assert.ok(rebuilt.finishedAt)

  // No further protocol action advances a done gauntlet.
  const after = runGauntletAction(rebuilt, { action: 'build', pieceIndex: 0, builderSubagentId: 'b9', artifact: { location: 'x', summary: 'y' } }, { now: 9_999, runId: 'x' })
  assert.equal(after.ok, false)
  const status = runGauntletAction(rebuilt, { action: 'status' }, { now: 9_999, runId: 'x' })
  assert.equal(status.next, null)
})

test('terminal: halted state stays halted with reason after reconstruction', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  actAndRecord(log, state, 'call-4', { action: 'halt', reason: 'Maintainer stopped the run.' }, t++)

  const { state: rebuilt, error } = reconstructFromSessionEvents(log)
  assert.equal(error, undefined)
  assert.equal(rebuilt.phase, 'halted')
  assert.equal(rebuilt.haltedReason, 'Maintainer stopped the run.')
  assert.equal(rebuilt.finishedAt, 1003)
})

// ---- 5. Isolation: two sessions keep independent gauntlets ----

test('isolation: two session logs reconstruct independent gauntlets', () => {
  const logA = []
  const stateA = createInitialState()
  const logB = []
  const stateB = createInitialState()
  let tA = 1000
  let tB = 5000

  actAndRecord(logA, stateA, 'a-1', { action: 'submit', command: 'Landing page A.' }, tA++)
  actAndRecord(logA, stateA, 'a-2', { action: 'refine', refinedCommand: 'Landing page A with hero under 1s LCP.', bar: BAR }, tA++)
  actAndRecord(logA, stateA, 'a-3', { action: 'split', pieces: [{ id: 'a1', title: 'Hero A', description: 'Hero A.' }] }, tA++)

  actAndRecord(logB, stateB, 'b-1', { action: 'submit', command: 'Dashboard B.' }, tB++)
  actAndRecord(logB, stateB, 'b-2', { action: 'refine', refinedCommand: 'Dashboard B with p95 under 200 ms.', bar: BAR }, tB++)
  actAndRecord(logB, stateB, 'b-3', { action: 'split', pieces: [{ id: 'b1', title: 'KPI B', description: 'KPI B.' }, { id: 'b2', title: 'Chart B', description: 'Chart B.' }] }, tB++)

  const { state: rebuiltA } = reconstructFromSessionEvents(logA)
  const { state: rebuiltB } = reconstructFromSessionEvents(logB)

  assert.equal(rebuiltA.rawCommand, 'Landing page A.')
  assert.equal(rebuiltB.rawCommand, 'Dashboard B.')
  assert.equal(rebuiltA.runId, 'a-1')
  assert.equal(rebuiltB.runId, 'b-1')
  assert.equal(rebuiltA.pieces.length, 1)
  assert.equal(rebuiltB.pieces.length, 2)
  assert.equal(rebuiltA.piecesState[0].id, 'a1')
  assert.equal(rebuiltB.piecesState[0].id, 'b1')

  // Advancing session A must not touch session B.
  runGauntletAction(rebuiltA, { action: 'build', pieceIndex: 0, builderSubagentId: 'bA', artifact: { location: 'a.ts', summary: 'hero' } }, { now: tA++, runId: 'a-4' })
  assert.equal(rebuiltB.piecesState[0].status, 'pending')
  assert.equal(rebuiltB.piecesState[0].rounds.length, 0)
})

// ---- 6. Corruption: invalid persisted history fails closed ----

test('corruption: a piece marked won without a verdict is rejected', () => {
  const wonState = createInitialState()
  runGauntletAction(wonState, { action: 'submit', command: 'x' }, { now: 1, runId: 'r' })
  runGauntletAction(wonState, { action: 'refine', refinedCommand: 'y with p95 under 100 ms.', bar: BAR }, { now: 2 })
  runGauntletAction(wonState, { action: 'split', pieces: PIECES }, { now: 3 })
  runGauntletAction(wonState, { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 'b' } }, { now: 4 })
  // Forge: set won with no verdict.
  wonState.piecesState[0].status = 'won'
  const errors = validateReconstructedState(wonState)
  assert.ok(errors.some(e => /won/.test(e) && /verdict/.test(e)), `expected won-without-verdict error, got: ${errors.join('; ')}`)
})

test('corruption: a forged "ours" verdict without evidence is rejected by the core on replay', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  actAndRecord(log, state, 'call-4', { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r1' } }, t++)

  // Forge a critique with an empty verdict payload: the core rejects it, so
  // replay leaves the piece awaiting_critique (no auto-win).
  const forged = structuredClone(log)
  forged.push({
    type: 'tool/call',
    seq: forged.length,
    time: 2000,
    data: {
      turn: 1, step: 1, callId: 'call-5',
      name: 'gauntlet_loop',
      arguments: JSON.stringify({ action: 'critique', pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: '', evidence: '', blind: true } }),
    },
  })
  forged.push({
    type: 'tool/result',
    seq: forged.length,
    time: 2000,
    data: {
      turn: 1, step: 1,
      message: {
        id: 'm-call-5', role: 'user',
        source: { kind: 'tool', callId: 'call-5' },
        content: [{ type: 'tool-result', toolCallId: 'call-5', content: [{ type: 'text', text: 'ok' }], isError: false }],
      },
    },
    sourceEventSeqs: [forged.length - 2],
    surfaceOp: 'append',
  })

  const { state: rebuilt } = reconstructFromSessionEvents(forged)
  // The rejected critique does not advance the piece.
  assert.equal(rebuilt.piecesState[0].status, 'awaiting_critique')
  assert.equal(rebuilt.piecesState[0].rounds[0].verdict, null)
})

test('corruption: a tampered submit with no command fails closed to idle', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)

  const tampered = structuredClone(log)
  const callEvent = tampered.find((e) => e.type === 'tool/call' && e.data?.callId === 'call-1')
  assert.ok(callEvent)
  callEvent.data.arguments = JSON.stringify({ action: 'submit' })

  const { state: rebuilt, error } = reconstructFromSessionEvents(tampered)
  // The core rejects the empty command at submit, so the run never starts and
  // stays idle — the corrupted submit cannot produce a valid mid-run Gauntlet.
  assert.equal(rebuilt.phase, 'idle')
  assert.equal(error, undefined)
})

// ---- 7. Schema/version: incompatible data is not silently accepted ----

test('schema/version: unknown ignorable event types are skipped without corrupting the run', () => {
  const log = []
  const state = createInitialState()
  let t = 1000
  actAndRecord(log, state, 'call-1', { action: 'submit', command: 'Build checkout.' }, t++)
  actAndRecord(log, state, 'call-2', { action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, t++)
  actAndRecord(log, state, 'call-3', { action: 'split', pieces: PIECES }, t++)
  actAndRecord(log, state, 'call-4', { action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 'b' } }, t++)

  // A future/foreign ignorable event type between the calls must be skipped.
  const withForeign = [
    ...log.slice(0, 5),
    { type: 'vendor/future-event', seq: 5, time: 99_999, data: { whatever: true }, ignorable: true },
    ...log.slice(5),
  ]
  const { state: rebuilt } = reconstructFromSessionEvents(withForeign)
  assert.equal(rebuilt.phase, 'loop')
  assert.equal(rebuilt.piecesState[0].status, 'awaiting_critique')
})

// ---- 8. Determinism ----

test('determinism: reconstruction is stable across repeated runs', () => {
  const log = []
  runFullGauntlet(log)
  const first = reconstructFromSessionEvents(log)
  const second = reconstructFromSessionEvents(log)
  assert.equal(first.error, undefined)
  assert.deepEqual(first.state, second.state)
  assert.equal(first.state.phase, 'done')
})

// ---- 9. findCallTime ----

test('findCallTime returns the logged tool/call time for a callId', () => {
  const log = []
  recordCall(log, 'call-x', { action: 'submit', command: 'x' }, 42)
  assert.equal(findCallTime(log, 'call-x'), 42)
  assert.equal(findCallTime(log, 'missing'), undefined)
})