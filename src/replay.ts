/**
 * Pure reconstruction of a canonical GauntletState from the durable session
 * event log.  Every successful `gauntlet_loop` tool call is recorded in the
 * session log as a `tool/call` event (with raw arguments) followed by a
 * `tool/result` event.  This module folds the SETTLED calls through
 * `runGauntletAction` to reproduce the canonical state — the one and only
 * state machine (src/core.ts) stays the authority.
 *
 * The session log IS the durable source of truth; no second store, no custom
 * event types, no ad-hoc JSON files.  Reconstruction is deterministic: given
 * the same event log, the same state is produced every time (the `now`
 * argument is derived from `event.time`, which is stable).
 *
 * A `tool/call` without a matching settled `tool/result` is treated as
 * in-flight (the agent loop appends the result only after the tool returns),
 * so reconstruction never double-applies the action being executed right now.
 *
 * @module gauntlet-loop-plugin/replay
 */

import {
  createInitialState,
  runGauntletAction,
  type GauntletActionInput,
  type GauntletState,
} from './core.js'

// ---- constants ----

/** The model-facing tool name that the agent loop records in `tool/call` events. */
const TOOL_NAME = 'gauntlet_loop'

/** Error code set by the agent loop when a tool call was aborted before dispatch. */
const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

// ---- public helpers ----

/** Parse the raw `arguments` JSON string from a `tool/call` event into an action input. */
export function parseCallArguments(raw: unknown): GauntletActionInput {
  if (typeof raw !== 'string') return { action: '' }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as GauntletActionInput : { action: '' }
  } catch {
    return { action: '' }
  }
}

// ---- reconstruction ----

/**
 * Reconstruct the canonical GauntletState by replaying SETTLED `gauntlet_loop`
 * tool calls from the session event log.  Settled = a `tool/call` followed by
 * a matching non-aborted `tool/result`.  An in-flight call (call without
 * result) is skipped.
 *
 * @param events - the session's append-only event list (in seq order).
 * @returns the reconstructed state, plus a fail-closed error when the
 *   reconstructed state fails validation.
 */
export function reconstructFromSessionEvents(
  events: readonly { type: string; time: number; data?: unknown }[],
): { state: GauntletState; error?: { kind: string; detail: string } } {
  const state = createInitialState()

  // Pending gauntlet calls seen as tool/call but not yet settled: callId → { args, time }.
  const pending = new Map<string, { args: GauntletActionInput; time: number }>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'tool/call' && data.name === TOOL_NAME) {
      const callId = String(data.callId ?? '')
      if (!callId) continue
      pending.set(callId, { args: parseCallArguments(data.arguments), time: event.time })
      continue
    }

    if (event.type === 'tool/result') {
      const msg = data.message as Record<string, unknown> | undefined
      const source = msg?.source as Record<string, unknown> | undefined
      const callId = typeof source?.callId === 'string' ? source.callId : undefined
      if (!callId) continue
      const pendingEntry = pending.get(callId)
      if (!pendingEntry) continue
      pending.delete(callId)

      // Skip calls that never ran: aborted before dispatch, or the tool
      // execution errored (a thrown tool never mutated session state, so a
      // replay must not apply it).
      const errorInfo = data.error as Record<string, unknown> | undefined
      if (errorInfo?.code === ABORTED_BEFORE_DISPATCH) continue
      const firstBlock = (msg?.content as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined
      if (firstBlock?.type === 'tool-result' && firstBlock.isError === true) continue

      // Replay the settled action through the core state machine.
      runGauntletAction(state, pendingEntry.args, { now: pendingEntry.time, runId: callId })
    }
  }

  // Validate the reconstructed state; fail closed when invalid.
  const errors = validateReconstructedState(state)
  if (errors.length > 0) {
    return {
      state,
      error: { kind: 'corrupted', detail: `Reconstructed state fails validation: ${errors.join('; ')}` },
    }
  }

  return { state }
}

/**
 * Find the `tool/call` event time for a callId, if the call has already been
 * logged.  Used so a live action and its later replay share the same `now`.
 */
export function findCallTime(
  events: readonly { type: string; time: number; data?: unknown }[],
  callId: string,
): number | undefined {
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (data.name === TOOL_NAME && String(data.callId ?? '') === callId) return event.time
  }
  return undefined
}

// ---- validation ----

/**
 * Validate a reconstructed GauntletState against cross-field invariants.
 * Returns an array of error messages (empty = valid).
 * This is a pure, deterministic check that does NOT re-run the state machine.
 */
export function validateReconstructedState(state: GauntletState): string[] {
  const errors: string[] = []

  // Phase must be valid.
  const validPhases = ['idle', 'refine', 'split', 'loop', 'report', 'done', 'halted']
  if (!validPhases.includes(state.phase)) {
    errors.push(`Invalid phase "${state.phase}"`)
    return errors  // phase is fundamental; stop early
  }

  // Phase coherence: fields present when required.
  if (state.phase !== 'idle') {
    if (!state.rawCommand) errors.push('Non-idle phase without rawCommand')
    if (!state.startedAt) errors.push('Non-idle phase without startedAt')
  }
  if (state.phase === 'refine' || state.phase === 'split' || state.phase === 'loop'
    || state.phase === 'report' || state.phase === 'done') {
    if (!state.refinedCommand) errors.push('Phase requires refinedCommand but is missing')
    if (!state.bar) errors.push('Phase requires bar but is missing')
    if (!state.subjectivity) errors.push('Phase requires subjectivity but is missing')
  }
  if (state.phase === 'loop' || state.phase === 'report' || state.phase === 'done') {
    if (state.pieces.length === 0) errors.push('Phase requires pieces but is empty')
    if (state.piecesState.length === 0) errors.push('Phase requires piecesState but is empty')
  }
  if (state.phase === 'report' || state.phase === 'done') {
    if (state.piecesState.length > 0 && !state.piecesState.every(p => p.status === 'won')) {
      errors.push('Phase report/done requires all pieces won')
    }
  }
  if (state.phase === 'done') {
    if (!state.summary) errors.push('Phase done requires summary')
    if (!state.finishedAt) errors.push('Phase done requires finishedAt')
  }
  if (state.phase === 'halted') {
    if (!state.haltedReason) errors.push('Phase halted requires haltedReason')
    if (!state.finishedAt) errors.push('Phase halted requires finishedAt')
  }

  // PiecesState consistency.
  const seenIds = new Set<string>()
  for (const piece of state.piecesState) {
    if (!piece.id) { errors.push('Piece missing id'); continue }
    if (seenIds.has(piece.id)) { errors.push(`Duplicate piece id "${piece.id}"`); continue }
    seenIds.add(piece.id)

    const validStatuses = ['pending', 'awaiting_critique', 'rebuild', 'won']
    if (!validStatuses.includes(piece.status)) {
      errors.push(`Piece "${piece.id}" has invalid status "${piece.status}"`)
    }

    // Round-level invariants.
    if (piece.status === 'pending' && piece.rounds.length > 0) {
      errors.push(`Piece "${piece.id}" is pending but has ${piece.rounds.length} rounds`)
    }
    if (piece.status === 'awaiting_critique') {
      if (piece.rounds.length === 0) {
        errors.push(`Piece "${piece.id}" awaiting_critique but has no rounds`)
      } else {
        const last = piece.rounds[piece.rounds.length - 1]
        if (last.verdict !== null) {
          errors.push(`Piece "${piece.id}" awaiting_critique but last round has a verdict`)
        }
      }
    }
    if (piece.status === 'rebuild') {
      if (piece.rounds.length === 0) {
        errors.push(`Piece "${piece.id}" rebuild but has no rounds`)
      } else {
        const last = piece.rounds[piece.rounds.length - 1]
        if (!last.verdict || last.verdict.winner !== 'bar') {
          errors.push(`Piece "${piece.id}" rebuild but last verdict is not "bar"`)
        }
      }
    }
    if (piece.status === 'won') {
      if (piece.rounds.length === 0) {
        errors.push(`Piece "${piece.id}" won but has no rounds`)
      } else {
        const last = piece.rounds[piece.rounds.length - 1]
        if (!last.verdict || last.verdict.winner !== 'ours') {
          errors.push(`Piece "${piece.id}" won but last verdict is not "ours"`)
        }
      }
    }

    // Every round validation.
    for (const round of piece.rounds) {
      if (!round.artifact.location || !round.artifact.summary) {
        errors.push(`Piece "${piece.id}" round ${round.round} artifact missing location or summary`)
      }
      if (!round.builderSubagentId) {
        errors.push(`Piece "${piece.id}" round ${round.round} missing builderSubagentId`)
      }
      if (round.verdict) {
        if (!round.verdict.notes) errors.push(`Piece "${piece.id}" round ${round.round} verdict missing notes`)
        if (!round.verdict.evidence) errors.push(`Piece "${piece.id}" round ${round.round} verdict missing evidence`)
        if (round.verdict.blind !== true) errors.push(`Piece "${piece.id}" round ${round.round} verdict not blind`)
        if (!round.verdict.criticSubagentId) errors.push(`Piece "${piece.id}" round ${round.round} verdict missing criticSubagentId`)
      }
    }
  }

  // Agent id uniqueness across ALL rounds.
  const allAgentIds = new Set<string>()
  for (const piece of state.piecesState) {
    for (const round of piece.rounds) {
      if (round.builderSubagentId) {
        if (allAgentIds.has(round.builderSubagentId)) {
          errors.push(`builderSubagentId "${round.builderSubagentId}" reused across rounds`)
        }
        allAgentIds.add(round.builderSubagentId)
      }
      if (round.verdict?.criticSubagentId) {
        if (allAgentIds.has(round.verdict.criticSubagentId)) {
          errors.push(`criticSubagentId "${round.verdict.criticSubagentId}" reused across rounds`)
        }
        allAgentIds.add(round.verdict.criticSubagentId)
      }
    }
  }

  // Builder != critic in the same round.
  for (const piece of state.piecesState) {
    for (const round of piece.rounds) {
      if (round.builderSubagentId && round.verdict?.criticSubagentId === round.builderSubagentId) {
        errors.push(`Piece "${piece.id}" round ${round.round} builder and critic are the same agent`)
      }
    }
  }

  return errors
}