/**
 * Integration test against the REAL DeepSeek Harness `@deepseek-ai/dsh-session`
 * package (resolved from the harness checkout, not the plugin's own
 * node_modules).  It drives a real `Session` with genuine `tool/call` +
 * `tool/result` events (the exact vocabulary the agent loop writes), then
 * reconstructs the Gauntlet state from `session.events` and simulates a
 * restart by re-seeding a fresh session from the same durable log.
 *
 * This proves the plugin's replay logic consumes the actual DSH event shapes
 * (`data.arguments` raw string, `message.source.callId`, `sourceEventSeqs`)
 * rather than an idealized fixture.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

// Resolve the REAL session package. Prefer the harness checkout's current
// build (the version the plugin's peerDeps target), then fall back to a
// resolvable package; skip when neither is available (e.g. bare CI).
const require = createRequire(import.meta.url)
let SessionId, Session
const candidates = [
  // Harness checkout (the peerDeps target version), when present beside the
  // plugin repo.
  '/home/pedro/dsh-ecosystem/deepseek-harness/packages/core/session/lib/index.js',
  // The peer dependency as installed by npm (^0.1.1-rc.2 in CI).
  '@deepseek-ai/dsh-session',
]
for (const candidate of candidates) {
  try {
    ;({ SessionId, Session } = require(candidate))
    break
  } catch {
    /* try next */
  }
}
if (typeof Session === 'undefined') {
  console.log('SKIP: real @deepseek-ai/dsh-session not resolvable from this environment')
}

import { createInitialState, runGauntletAction } from '../lib/core.js'
import { reconstructFromSessionEvents, findCallTime } from '../lib/replay.js'

const BAR = {
  name: 'Stripe Checkout demo',
  fetchHow: 'Open https://stripe.com/payments/checkout and capture the reference.',
  compareHow: 'Compare artifact and reference side by side without labels, then pick one winner.',
  description: 'Named visual and interaction reference.',
}

const PIECES = [
  { id: 'p1', title: 'Checkout shell', description: 'Checkout shell.' },
  { id: 'p2', title: 'Payment form', description: 'Payment form.' },
]

function callBlock(callId, args) {
  return { id: callId, name: 'gauntlet_loop', arguments: JSON.stringify(args) }
}

function toolResultBlock(callId, text = 'ok') {
  return [{
    type: 'tool-result',
    toolCallId: callId,
    content: [{ type: 'text', text }],
    isError: false,
  }]
}

/**
 * Drive a real DSH Session through the gauntlet protocol.  Each action is
 * bracketed with the real turn/step/tool events the agent loop would write.
 */
function driveRealSession() {
  const id = SessionId(`it-${Date.now()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: Date.now() })

  let turn = 1
  let step = 1
  let t = 1000

  const gauntlet = createInitialState()

  const record = (args, callId) => {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step })
    const callSeq = session.append('tool/call', { turn, step, callId, name: 'gauntlet_loop', arguments: JSON.stringify(args) }).seq
    // Execute (the plugin would run runGauntletAction here).
    runGauntletAction(gauntlet, args, { now: t, runId: callId })
    t += 1
    session.append('tool/result', {
      turn,
      step,
      message: {
        id: `m-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: toolResultBlock(callId),
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turn += 1
    step += 1
  }

  record({ action: 'submit', command: 'Build checkout.' }, 'call-1')
  record({ action: 'refine', refinedCommand: 'Build checkout p95 under 100 ms.', bar: BAR }, 'call-2')
  record({ action: 'split', pieces: PIECES }, 'call-3')
  record({ action: 'build', pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/p1.ts', summary: 'r1' } }, 'call-4')
  // Stop here mid-run; simulate restart.

  return { session, gauntlet }
}

test('REAL session: reconstruct gauntlet from actual session.events', { skip: typeof Session === 'undefined' }, () => {
  const { session, gauntlet } = driveRealSession()

  // The live state at this point:
  assert.equal(gauntlet.phase, 'loop')
  assert.equal(gauntlet.piecesState[0].status, 'awaiting_critique')

  // The plugin's reconstruction from the real event log:
  const { state, error } = reconstructFromSessionEvents(session.events)
  assert.equal(error, undefined)
  assert.equal(state.phase, 'loop')
  assert.equal(state.runId, 'call-1')
  assert.equal(state.rawCommand, 'Build checkout.')
  assert.deepEqual(state.bar, BAR)
  assert.equal(state.pieces.length, 2)
  assert.equal(state.piecesState[0].status, 'awaiting_critique')
  assert.equal(state.piecesState[0].rounds[0].builderSubagentId, 'b1')
  assert.equal(state.piecesState[0].rounds[0].verdict, null)

  // findCallTime works against the real events (the session stamps real
  // Date.now() times; verify it returns the actual event time for a call).
  const call1 = session.events.find(e => e.type === 'tool/call' && e.data.callId === 'call-1')
  const call4 = session.events.find(e => e.type === 'tool/call' && e.data.callId === 'call-4')
  assert.ok(call1)
  assert.ok(call4)
  assert.equal(findCallTime(session.events, 'call-1'), call1.time)
  assert.equal(findCallTime(session.events, 'call-4'), call4.time)
  assert.equal(findCallTime(session.events, 'missing'), undefined)
})

test('REAL session: restart continues from the reconstructed point', { skip: typeof Session === 'undefined' }, () => {
  const { session } = driveRealSession()

  // Simulate restart: a FRESH process reconstructs from the durable log only.
  const { state: rebuilt } = reconstructFromSessionEvents(session.events)
  assert.equal(rebuilt.piecesState[0].status, 'awaiting_critique')

  // Continue exactly where we left off.
  const result = runGauntletAction(rebuilt, {
    action: 'critique', pieceIndex: 0, criticSubagentId: 'c1',
    verdict: { winner: 'ours', notes: 'p1 wins', evidence: 'Blind A/B chose artifact', blind: true },
  }, { now: 5000, runId: 'call-5' })
  assert.equal(result.ok, true)
  assert.equal(rebuilt.piecesState[0].status, 'won')
  assert.equal(rebuilt.phase, 'loop')
})

test('REAL session: reconstruction is deterministic', { skip: typeof Session === 'undefined' }, () => {
  const { session } = driveRealSession()
  const first = reconstructFromSessionEvents(session.events)
  const second = reconstructFromSessionEvents(session.events)
  assert.equal(first.error, undefined)
  assert.deepEqual(first.state, second.state)
})