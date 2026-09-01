/**
 * Pure client-side Gauntlet projection model.
 *
 * Deterministically builds an accumulated workbench view from the durable
 * wire material: settled `gauntlet_loop` tool result events.  The model is a
 * pure function of the call slices — it never reads session state, I/O, or
 * the clock.  It is NOT the protocol authority; it only applies facts the
 * host already accepted via `meta.ok` and `meta.presentation`.
 *
 * === Authority ===
 *
 *   session event log
 *       ↓
 *   Gauntlet core (src/core.ts) — sole protocol authority
 *       ↓
 *   wire call/result/meta (persisted)
 *       ↓
 *   client presentation projection (THIS FILE)
 *       ↓
 *   React UI
 *
 * The client projection NEVER runs `runGauntletAction` or replicates
 * protocol validation rules.  It reads the small bounded `presentation`
 * envelope from `meta` (phase, next, error, rejections) and combines those
 * with the original `argsRaw` to reconstruct the view.
 *
 * === Fail-closed ===
 *
 * The projection returns `available: false` when any call in the fold
 * window carries a missing, incompatible, or malformed wire envelope — the
 * UI must then fall back to the generic/textual card.
 */

// Presentation version constant.  Must match src/core.ts GAUNTLET_PRESENTATION_VERSION.
// Kept in this Node-free module because the client bundle cannot import
// core.ts (which imports node:crypto).
export const GAUNTLET_PRESENTATION_VERSION = 1

// ---- Wire contract types ----

/** The small bounded presentation envelope the host embeds in `tool/result.meta`. */
export interface PresentationEnvelope {
  version: number
  phase: string
  next: string | null
  nextPieceIndex?: number
  error?: string
  rejections?: string[]
}

/** A settled gauntlet_loop wire call, extracted from the conversation snapshot. */
export interface GauntletCallSlice {
  seq: number
  argsRaw: string | null
  meta: unknown
  isError: boolean
  error?: { name: string; code: string } | null
}

// ---- View model types ----

export interface ProjectedRound {
  round: number
  builder: string
  artifactLocation: string
  artifactSummary: string
  builderEvidence: string
  critic: string | null
  winner: 'ours' | 'bar' | null
  criticNotes: string | null
  criticEvidence: string | null
}

export type UnitStatus = 'pending' | 'awaiting_critique' | 'rebuild' | 'won'

export interface ProjectedUnit {
  id: string
  title: string
  status: UnitStatus
  rounds: ProjectedRound[]
}

export interface BlockedView {
  error: string | null
  rejections: readonly string[]
  phase: string
  next: string | null
}

export type GauntletPhase = 'idle' | 'refine' | 'split' | 'loop' | 'report' | 'done' | 'halted'
export type GauntletStatus = 'running' | 'blocked' | 'complete' | 'halted'

export interface GauntletProjection {
  /** Whether the projection could be safely derived. */
  available: boolean
  /** Human-readable reason when unavailable (for debugging). */
  unavailableReason?: string
  /** Current protocol phase (from the last settled call's envelope). */
  phase: GauntletPhase | null
  /** Display status derived from phase + blocked + running. */
  status: GauntletStatus
  /** Quality bar name (from the accepted refine call's args). */
  barName: string | null
  /** Next action expected (from the last settled call's envelope). */
  next: string | null
  /** Piece index for the next action, when applicable. */
  nextPieceIndex: number | null
  /** List of units (from the accepted split call's args + builds + critiques). */
  units: readonly ProjectedUnit[]
  /** Number of units with status "won". */
  won: number
  /** Total number of units. */
  total: number
  /** Total accumulated rounds across all units. */
  totalRounds: number
  /** Blocked state when the last settled call was rejected. */
  blocked: BlockedView | null
  /** Terminal summary when the gauntlet completed. */
  summary: { outcome: string; lessons: string } | null
  /** Reason when the gauntlet was halted. */
  haltedReason: string | null
  /** Whether the current block (being rendered) is still in-flight. */
  running: boolean
}

// ---- Internal fold state ----

interface FoldState {
  phase: string
  next: string | null
  nextPieceIndex: number | null
  barName: string | null
  units: Map<string, { id: string; title: string; rounds: ProjectedRound[] }>
  summary: { outcome: string; lessons: string } | null
  haltedReason: string | null
  // The last settled call was rejected — tracked for the "blocked" indicator.
  lastRejected: boolean
  lastRejectionError: string | null
  lastRejections: string[]
  lastRejectedPhase: string
  lastRejectedNext: string | null
}

// ---- Parsing helpers ----

/** Parse the presentation envelope from `block.meta`.  Returns null when unavailable or incompatible. */
export function parsePresentationMeta(meta: unknown): PresentationEnvelope | null {
  if (meta === null || meta === undefined || typeof meta !== 'object') return null
  const obj = meta as Record<string, unknown>
  const pres = obj.presentation as Record<string, unknown> | undefined
  if (pres === undefined || typeof pres !== 'object') return null
  const version = typeof pres.version === 'number' ? pres.version : -1
  if (version !== GAUNTLET_PRESENTATION_VERSION) return null
  const phase = typeof pres.phase === 'string' ? pres.phase : ''
  if (!phase) return null
  return {
    version,
    phase,
    next: typeof pres.next === 'string' ? pres.next : null,
    nextPieceIndex: typeof pres.nextPieceIndex === 'number' ? pres.nextPieceIndex : undefined,
    error: typeof pres.error === 'string' ? pres.error : undefined,
    rejections: Array.isArray(pres.rejections)
      ? (pres.rejections as unknown[]).filter((r): r is string => typeof r === 'string')
      : undefined,
  }
}

/** Parse gauntlet_loop args from the wire JSON string.  Returns null on failure. */
export function parseGauntletArgs(argsRaw: string | null): Record<string, unknown> | null {
  if (argsRaw === null || argsRaw === '') return null
  try {
    const parsed = JSON.parse(argsRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Safely extract a string field from parsed args. */
function argsString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Safely extract a number field from parsed args. */
function argsNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Safely extract an object field from parsed args. */
function argsObject(args: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = args[key]
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Safely extract an array field from parsed args. */
function argsArray(args: Record<string, unknown>, key: string): unknown[] | null {
  const value = args[key]
  return Array.isArray(value) ? value : null
}

// ---- Projection ----

/**
 * Build the accumulated Gauntlet projection from an ordered list of settled
 * wire call slices.  The slices should be sorted by `seq` ascending.
 *
 * @param calls - settled gauntlet_loop call slices in seq order.
 * @param currentRunning - whether the card being rendered is still in-flight.
 * @returns the deterministic workbench projection.
 */
export function projectGauntlet(
  calls: readonly GauntletCallSlice[],
  currentRunning = false,
): GauntletProjection {
  if (calls.length === 0) {
    return {
      available: true,
      phase: 'idle',
      status: 'running',
      barName: null,
      next: 'submit',
      nextPieceIndex: null,
      units: [],
      won: 0,
      total: 0,
      totalRounds: 0,
      blocked: null,
      summary: null,
      haltedReason: null,
      running: false,
    }
  }

  const state: FoldState = {
    phase: 'idle',
    next: 'submit',
    nextPieceIndex: null,
    barName: null,
    units: new Map(),
    summary: null,
    haltedReason: null,
    lastRejected: false,
    lastRejectionError: null,
    lastRejections: [],
    lastRejectedPhase: 'idle',
    lastRejectedNext: null,
  }

  for (const call of calls) {
    // ---- Read presentation envelope ----
    const pres = parsePresentationMeta(call.meta)
    if (pres === null) {
      return {
        available: false,
        unavailableReason: 'gauntlet call has incompatible or missing presentation meta',
        phase: null,
        status: 'running',
        barName: null,
        next: null,
        nextPieceIndex: null,
        units: [],
        won: 0,
        total: 0,
        totalRounds: 0,
        blocked: null,
        summary: null,
        haltedReason: null,
        running: false,
      }
    }

    // Detect infrastructure error (interrupted, crashed) — cannot trust this call.
    if (call.isError) {
      return {
        available: false,
        unavailableReason: 'gauntlet call has infrastructure error',
        phase: null,
        status: 'running',
        barName: null,
        next: null,
        nextPieceIndex: null,
        units: [],
        won: 0,
        total: 0,
        totalRounds: 0,
        blocked: null,
        summary: null,
        haltedReason: null,
        running: false,
      }
    }

    // Update phase/next from the envelope (host authority — applies to both
    // accepted and rejected calls).
    state.phase = pres.phase
    state.next = pres.next
    state.nextPieceIndex = pres.nextPieceIndex ?? null

    // ---- Parse args for accepted calls ----
    const args = parseGauntletArgs(call.argsRaw)
    const ok = (call.meta as Record<string, unknown> | null)?.ok === true

    if (ok) {
      // Accepted — apply state-changing facts.
      if (args === null) {
        // Can't parse args for an accepted call that changes state → fail closed.
        return {
          available: false,
          unavailableReason: 'accepted call has unparseable args',
          phase: null,
          status: 'running',
          barName: null,
          next: null,
          nextPieceIndex: null,
          units: [],
          won: 0,
          total: 0,
          totalRounds: 0,
          blocked: null,
          summary: null,
          haltedReason: null,
          running: false,
        }
      }
      const action = argsString(args, 'action') ?? ''
      applyAction(state, action, args)
    } else {
      // Rejected — record blocked state, keep presented state unchanged.
      state.lastRejected = true
      state.lastRejectionError = pres.error ?? null
      state.lastRejections = pres.rejections ?? []
      state.lastRejectedPhase = pres.phase
      state.lastRejectedNext = pres.next
    }
  }

  // ---- Derive displayed view ----
  const units = deriveUnits(state)
  const won = units.filter(u => u.status === 'won').length
  const total = units.length
  const totalRounds = units.reduce((sum, u) => sum + u.rounds.length, 0)

  // Determine the blocked display: only the LAST call's rejection matters
  // for the current card (the fold is up to this call).
  const blocked = state.lastRejected
    ? {
      error: state.lastRejectionError,
      rejections: state.lastRejections,
      phase: state.lastRejectedPhase,
      next: state.lastRejectedNext,
    }
    : null

  const phase = state.phase as GauntletPhase
  const isDone = phase === 'done'
  const isHalted = phase === 'halted'
  const status: GauntletStatus = isDone ? 'complete' : isHalted ? 'halted' : blocked !== null ? 'blocked' : 'running'

  return {
    available: true,
    phase,
    status,
    barName: state.barName,
    next: state.next,
    nextPieceIndex: state.nextPieceIndex,
    units,
    won,
    total,
    totalRounds,
    blocked,
    summary: state.summary,
    haltedReason: state.haltedReason,
    running: currentRunning,
  }
}

// ---- Action application ----

function applyAction(state: FoldState, action: string, args: Record<string, unknown>): void {
  switch (action) {
    case 'submit': {
      // Reset (submit implicitly resets the gauntlet).
      state.units.clear()
      state.barName = null
      state.summary = null
      state.haltedReason = null
      state.lastRejected = false
      break
    }
    case 'refine': {
      const bar = argsObject(args, 'bar')
      if (bar !== null) {
        const name = argsString(bar, 'name')
        if (name !== undefined) state.barName = name
      }
      break
    }
    case 'split': {
      state.units.clear()
      const pieces = argsArray(args, 'pieces')
      if (pieces !== null) {
        for (const piece of pieces) {
          if (typeof piece !== 'object' || piece === null) continue
          const p = piece as Record<string, unknown>
          const id = argsString(p, 'id') ?? "p" + (state.units.size + 1)
          const title = argsString(p, 'title') ?? id
          state.units.set(id, { id, title, rounds: [] })
        }
      }
      break
    }
    case 'build': {
      const index = argsNumber(args, 'pieceIndex')
      if (index === undefined) break
      const unit = [...state.units.values()][index]
      if (unit === undefined) break
      const builder = argsString(args, 'builderSubagentId') ?? ''
      const artifact = argsObject(args, 'artifact')
      const artifactLocation = artifact !== null ? argsString(artifact, 'location') ?? '' : ''
      const artifactSummary = artifact !== null ? argsString(artifact, 'summary') ?? '' : ''
      const builderEvidence = argsString(args, 'builderEvidence') ?? ''
      unit.rounds.push({
        round: unit.rounds.length + 1,
        builder,
        artifactLocation,
        artifactSummary,
        builderEvidence,
        critic: null,
        winner: null,
        criticNotes: null,
        criticEvidence: null,
      })
      break
    }
    case 'critique': {
      const index = argsNumber(args, 'pieceIndex')
      if (index === undefined) break
      const unit = [...state.units.values()][index]
      if (unit === undefined || unit.rounds.length === 0) break
      const lastRound = unit.rounds[unit.rounds.length - 1]
      const critic = argsString(args, 'criticSubagentId') ?? ''
      const verdict = argsObject(args, 'verdict')
      if (verdict !== null) {
        const winner = verdict.winner
        lastRound.critic = critic
        lastRound.winner = winner === 'ours' || winner === 'bar' ? winner : null
        lastRound.criticNotes = argsString(verdict, 'notes') ?? null
        lastRound.criticEvidence = argsString(verdict, 'evidence') ?? null
      }
      break
    }
    case 'complete': {
      const summary = argsObject(args, 'summary')
      if (summary !== null) {
        state.summary = {
          outcome: argsString(summary, 'outcome') ?? '',
          lessons: argsString(summary, 'lessons') ?? '',
        }
      }
      break
    }
    case 'halt': {
      state.haltedReason = argsString(args, 'reason') ?? ''
      break
    }
    case 'reset': {
      state.units.clear()
      state.barName = null
      state.summary = null
      state.haltedReason = null
      state.lastRejected = false
      break
    }
    // status: no-op
  }
}

// ---- Unit status derivation ----

/**
 * Derive unit display status from the accumulated rounds.  This is a pure
 * presentation mapping of accepted facts — it does NOT replicate protocol
 * validation.
 */
function deriveUnitStatus(rounds: ProjectedRound[]): UnitStatus {
  if (rounds.length === 0) return 'pending'
  const lastRound = rounds[rounds.length - 1]
  if (lastRound.winner === null) return 'awaiting_critique'
  return lastRound.winner === 'bar' ? 'rebuild' : 'won'
}

function deriveUnits(state: FoldState): ProjectedUnit[] {
  return [...state.units.values()].map(u => ({
    id: u.id,
    title: u.title,
    status: deriveUnitStatus(u.rounds),
    rounds: u.rounds,
  }))
}
