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
 * FAIL-CLOSED VERIFICATION: every settled call carries a `tool/result` whose
 * `meta` (persisted by the harness via the tool's `presentationMeta`) records
 * the protocol version and a semantic fingerprint of the post-action state.
 * Replay recomputes that fingerprint from the reproduced state and fails
 * closed if it diverges — a tampered call, an incompatible protocol version,
 * or a stale log without verification metadata can never silently normalize
 * into a valid Gauntlet.
 *
 * INCREMENTAL FOLD: the fold is resumable.  A {@link ReplayCheckpoint} lets a
 * caller carry the fold forward across growing logs (per-session watermark),
 * so live calls and invariants re-fold only the delta instead of the whole
 * history.  The checkpoint is a pure cache — every settled call it resumes
 * from is still verified against its persisted meta.
 *
 * A `tool/call` without a matching settled `tool/result` is treated as
 * in-flight (the agent loop appends the result only after the tool returns),
 * so reconstruction never double-applies the action being executed right now.
 *
 * @module gauntlet-loop-plugin/replay
 */

import {
  createInitialState,
  GAUNTLET_PROTOCOL_VERSION,
  GAUNTLET_SCHEMA_VERSION,
  runGauntletAction,
  stateFingerprint,
  type GauntletActionInput,
  type GauntletState,
} from './core.js'

// ---- constants ----

/** The model-facing tool name that the agent loop records in `tool/call` events. */
const TOOL_NAME = 'gauntlet_loop'

/** Error code set by the agent loop when a tool call was aborted before dispatch. */
const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

// ---- types ----

/**
 * The verification meta the gauntlet tool persists on every settled
 * `tool/result` (via its `output.presentationMeta`).  The harness stores it in
 * `tool/result.data.meta` and replay compares against it.
 */
export interface GauntletResultMeta {
  /** The fold-semantics version that produced this result. */
  protocol: number
  /** The state-shape version that produced this result. */
  schema: number
  /** Whether the original call was accepted by the core. */
  ok: boolean
  /** Semantic fingerprint of the post-action state (`stateFingerprint`). */
  fingerprint: string | null
}

/** One pending in-flight gauntlet call (tool/call seen, tool/result not yet). */
export interface PendingCall {
  args: GauntletActionInput
  time: number
}

/**
 * A resumable fold position: the seq up to which `state` is current, plus the
 * in-flight calls that were seen as `tool/call` but not yet settled.  A pure
 * cache — never a source of truth, always re-verifiable from the log.
 */
export interface ReplayCheckpoint {
  lastSeq: number
  state: GauntletState
  pending: Record<string, PendingCall>
}

/** Result of one reconstruction pass. */
export interface ReplayOutcome {
  /** The reconstructed state (fails closed via `error`). */
  state: GauntletState
  /** Set when reconstruction cannot be proven safe. */
  error?: { kind: string; detail: string }
  /** The new fold position to cache for an incremental next pass. */
  checkpoint?: ReplayCheckpoint
}

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

/** Read the verification meta persisted on a `tool/result` event. */
function readResultMeta(data: Record<string, unknown>): GauntletResultMeta | null {
  const meta = data.meta as Record<string, unknown> | undefined
  if (meta === undefined) return null
  return {
    protocol: typeof meta.protocol === 'number' ? meta.protocol : -1,
    schema: typeof meta.schema === 'number' ? meta.schema : -1,
    ok: meta.ok === true,
    fingerprint: typeof meta.fingerprint === 'string' ? meta.fingerprint : null,
  }
}

// ---- reconstruction ----

/**
 * Reconstruct the canonical GauntletState by replaying SETTLED `gauntlet_loop`
 * tool calls from the session event log.  Settled = a `tool/call` followed by
 * a matching non-aborted `tool/result`.  An in-flight call (call without
 * result) is skipped.
 *
 * When `checkpoint` is provided and its `lastSeq` is within the log, the fold
 * resumes from that position (seeding state + in-flight calls) and only folds
 * the delta.  Every settled call folded — resumed or fresh — is verified
 * against its persisted result meta; any divergence fails closed.
 *
 * @param events - the session's append-only event list (in seq order).
 * @param checkpoint - optional prior fold position to resume from.
 * @returns the reconstructed state (plus `error` when unverifiable) and the
 *   next checkpoint.
 */
export function reconstructFromSessionEvents(
  events: readonly { type: string; time: number; data?: unknown }[],
  checkpoint?: ReplayCheckpoint,
): ReplayOutcome {
  const start = checkpoint !== undefined && checkpoint.lastSeq <= events.length
    ? checkpoint.lastSeq
    : 0
  const state = start > 0 ? structuredClone(checkpoint!.state) : createInitialState()

  // Pending in-flight calls: seeded from the checkpoint, then advanced by the
  // delta fold.
  const pending = new Map<string, PendingCall>()
  if (start > 0) {
    for (const [callId, call] of Object.entries(checkpoint!.pending)) {
      pending.set(callId, call)
    }
  }

  for (let index = start; index < events.length; index += 1) {
    const event = events[index]!
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
      const pendingCall = pending.get(callId)
      if (!pendingCall) continue
      pending.delete(callId)

      // Skip calls that never ran: aborted before dispatch, or the tool
      // execution errored (a thrown tool never mutated session state, so a
      // replay must not apply it).
      const errorInfo = data.error as Record<string, unknown> | undefined
      if (errorInfo?.code === ABORTED_BEFORE_DISPATCH) continue
      const firstBlock = (msg?.content as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined
      if (firstBlock?.type === 'tool-result' && firstBlock.isError === true) continue

      // ---- fail-closed verification against the persisted result meta ----
      const meta = readResultMeta(data)
      if (meta === null) {
        return {
          state,
          error: {
            kind: 'stale',
            detail: `settled gauntlet call "${callId}" has no verification meta; the log predates protocol verification or was written by an incompatible tool — refusing to reconstruct`,
          },
        }
      }
      if (meta.protocol !== GAUNTLET_PROTOCOL_VERSION || meta.schema !== GAUNTLET_SCHEMA_VERSION) {
        return {
          state,
          error: {
            kind: 'incompatible',
            detail: `settled gauntlet call "${callId}" carries protocol ${String(meta.protocol)}/schema ${String(meta.schema)}, current is ${String(GAUNTLET_PROTOCOL_VERSION)}/${String(GAUNTLET_SCHEMA_VERSION)} — refusing to replay old rules over new state`,
          },
        }
      }
      if (typeof meta.fingerprint !== 'string' || meta.fingerprint.length === 0) {
        return {
          state,
          error: {
            kind: 'corrupted',
            detail: `settled gauntlet call "${callId}" has no fingerprint in its verification meta`,
          },
        }
      }

      // Replay the settled action through the core state machine.
      const replayed = runGauntletAction(state, pendingCall.args, { now: pendingCall.time, runId: callId })
      if (replayed.ok !== meta.ok) {
        return {
          state,
          error: {
            kind: 'corrupted',
            detail: `settled gauntlet call "${callId}" was ${meta.ok ? 'accepted' : 'rejected'} in the persisted log but replays as ${replayed.ok ? 'accepted' : 'rejected'}; the call's semantics were changed`,
          },
        }
      }
      const reproduced = stateFingerprint(state)
      if (reproduced !== meta.fingerprint) {
        return {
          state,
          error: {
            kind: 'corrupted',
            detail: `settled gauntlet call "${callId}" does not reproduce the persisted result (fingerprint mismatch); the history was tampered or the protocol rules changed`,
          },
        }
      }
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

  const pendingRecord: Record<string, PendingCall> = {}
  for (const [callId, call] of pending) pendingRecord[callId] = call

  return {
    state,
    checkpoint: { lastSeq: events.length, state: structuredClone(state), pending: pendingRecord },
  }
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

  // Version envelope: a reconstructed state must carry current versions.
  if (state.schemaVersion !== GAUNTLET_SCHEMA_VERSION) {
    errors.push(`State schemaVersion ${String(state.schemaVersion)} does not match current ${String(GAUNTLET_SCHEMA_VERSION)}`)
  }
  if (state.protocolVersion !== GAUNTLET_PROTOCOL_VERSION) {
    errors.push(`State protocolVersion ${String(state.protocolVersion)} does not match current ${String(GAUNTLET_PROTOCOL_VERSION)}`)
  }

  // Phase must be valid.
  const validPhases = ['idle', 'refine', 'split', 'loop', 'report', 'done', 'halted']
  if (!validPhases.includes(state.phase)) {
    errors.push(`Invalid phase "${state.phase}"`)
    return errors  // phase is fundamental; stop early
  }

  // Phase coherence: fields present when required.
  // NOTE: phase 'refine' means "submit done, refine pending" — refinedCommand,
  // bar and subjectivity are legitimately absent until refine SETTLES.  They
  // are required only from 'split' onward.
  if (state.phase !== 'idle') {
    if (!state.rawCommand) errors.push('Non-idle phase without rawCommand')
    if (!state.startedAt) errors.push('Non-idle phase without startedAt')
  }
  if (state.phase === 'split' || state.phase === 'loop'
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