/**
 * Gauntlet Host Session-Projection unit.
 *
 * Registers the `gauntlet` projection key with `ctx.sessionProjections`: the
 * registry drives `apply` eagerly over every committed session event, so the
 * fold covers the FULL durable log regardless of which events currently ride
 * the client transcript window (tail page / prepend / paging). The registry
 * serves the finished whole value to the client through the api-proxy history
 * tail baseline plus `session/projection` push frames, and the client reads
 * it via `useProjection('gauntlet')` — no client-side domain folding over a
 * partial window, no scanning of `chat.legacy.nodes`.
 *
 * === Authority ===
 *
 *   session event log
 *       ↓
 *   Gauntlet core (src/core.ts) — sole protocol authority
 *       ↓
 *   wire call/result/meta (persisted, includes the bounded presentation envelope)
 *       ↓
 *   SessionProjectionRegistry (THIS FILE) — host fold over the full log
 *       ↓
 *   Gauntlet presentation DTO
 *       ↓
 *   useProjection
 *       ↓
 *   GauntletRow
 *
 * The unit NEVER runs `runGauntletAction` and never re-implements protocol
 * validation. It applies only facts the host already accepted (`meta.ok` +
 * the bounded `meta.presentation` envelope) combined with the persisted
 * `tool/call` arguments.
 *
 * === Fail-closed ===
 *
 * A settled gauntlet call whose `meta` lacks a compatible `presentation`
 * envelope marks the projection `available: false` — the client then renders
 * the safe generic/textual fallback instead of a fabricated workbench.
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { GAUNTLET_PRESENTATION_VERSION } from './core.js'
import type {
  GauntletProjectionDTO, GauntletPhaseDTO, GauntletStatusDTO, ProjectedRoundDTO, UnitStatusDTO,
} from './projection-types.js'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold state of the Gauntlet presentation projection. */
    gauntlet: GauntletProjectionState
  }
}

// ---- Host fold state ----

export interface GauntletProjectionState {
  /** Whether the fold could be proven safe so far. */
  available: boolean
  /** Why the fold stopped being available. */
  unavailableReason?: string
  phase: string
  next: string | null
  nextPieceIndex: number | null
  barName: string | null
  units: { id: string; title: string; rounds: ProjectedRoundDTO[] }[]
  summary: { outcome: string; lessons: string } | null
  haltedReason: string | null
  /** Last rejected call's transient presentation state. */
  lastRejected: boolean
  lastRejectionError: string | null
  lastRejections: string[]
  lastRejectedPhase: string
  lastRejectedNext: string | null
  /** In-flight tool/call records (callId → parsed args) awaiting their tool/result. */
  pending: Record<string, { args: Record<string, unknown>; time: number }>
}

// ---- zod schemas (the unit contract requires ZodType) ----

const roundSchema = z.object({
  round: z.number(),
  builder: z.string(),
  artifactLocation: z.string(),
  artifactSummary: z.string(),
  builderEvidence: z.string(),
  critic: z.string().nullable(),
  winner: z.union([z.literal('ours'), z.literal('bar')]).nullable(),
  criticNotes: z.string().nullable(),
  criticEvidence: z.string().nullable(),
})

const unitSchema = z.object({
  id: z.string(),
  title: z.string(),
  rounds: z.array(roundSchema),
})

const stateSchema = z.object({
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  phase: z.string(),
  next: z.string().nullable(),
  nextPieceIndex: z.number().nullable(),
  barName: z.string().nullable(),
  units: z.array(unitSchema),
  summary: z.object({ outcome: z.string(), lessons: z.string() }).nullable(),
  haltedReason: z.string().nullable(),
  lastRejected: z.boolean(),
  lastRejectionError: z.string().nullable(),
  lastRejections: z.array(z.string()),
  lastRejectedPhase: z.string(),
  lastRejectedNext: z.string().nullable(),
  pending: z.record(z.string(), z.object({
    args: z.record(z.string(), z.unknown()),
    time: z.number(),
  })),
})

const dtoSchema = z.object({
  version: z.number(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  phase: z.union([
    z.literal('idle'), z.literal('refine'), z.literal('split'), z.literal('loop'),
    z.literal('report'), z.literal('done'), z.literal('halted'),
  ]).nullable(),
  status: z.union([
    z.literal('running'), z.literal('blocked'), z.literal('complete'), z.literal('halted'),
  ]),
  barName: z.string().nullable(),
  next: z.string().nullable(),
  nextPieceIndex: z.number().nullable(),
  units: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.union([
      z.literal('pending'), z.literal('awaiting_critique'), z.literal('rebuild'), z.literal('won'),
    ]),
    rounds: z.array(roundSchema),
  })),
  won: z.number(),
  total: z.number(),
  totalRounds: z.number(),
  blocked: z.object({
    error: z.string().nullable(),
    rejections: z.array(z.string()),
    phase: z.string(),
    next: z.string().nullable(),
  }).nullable(),
  summary: z.object({ outcome: z.string(), lessons: z.string() }).nullable(),
  haltedReason: z.string().nullable(),
})

// ---- Parsing helpers ----

function parseCallArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Read the presentation envelope from a settled tool/result meta. */
function readPresentation(meta: unknown): {
  version: number
  phase: string
  next: string | null
  nextPieceIndex?: number
  error?: string
  rejections?: string[]
} | null {
  if (meta === null || typeof meta !== 'object') return null
  const obj = meta as Record<string, unknown>
  const pres = obj.presentation
  if (pres === null || typeof pres !== 'object') return null
  const p = pres as Record<string, unknown>
  const version = typeof p.version === 'number' ? p.version : -1
  if (version !== GAUNTLET_PRESENTATION_VERSION) return null
  const phase = typeof p.phase === 'string' ? p.phase : ''
  if (!phase) return null
  return {
    version,
    phase,
    next: typeof p.next === 'string' ? p.next : null,
    nextPieceIndex: typeof p.nextPieceIndex === 'number' ? p.nextPieceIndex : undefined,
    error: typeof p.error === 'string' ? p.error : undefined,
    rejections: Array.isArray(p.rejections)
      ? (p.rejections as unknown[]).filter((r): r is string => typeof r === 'string')
      : undefined,
  }
}

/** Whether the settled result carries a verification meta with a compatible envelope. */
function readOk(meta: unknown): boolean | null {
  if (meta === null || typeof meta !== 'object') return null
  const ok = (meta as Record<string, unknown>).ok
  return typeof ok === 'boolean' ? ok : null
}

function argsString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function argsNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function argsObject(args: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = args[key]
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function argsArray(args: Record<string, unknown>, key: string): unknown[] | null {
  const value = args[key]
  return Array.isArray(value) ? value : null
}

// ---- Action application (facts only; no protocol validation) ----

function applyAction(
  state: GauntletProjectionState,
  action: string,
  args: Record<string, unknown>,
): void {
  switch (action) {
    case 'submit':
    case 'reset': {
      state.units = []
      state.barName = null
      state.summary = null
      state.haltedReason = null
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
      state.units = []
      const pieces = argsArray(args, 'pieces')
      if (pieces !== null) {
        for (const piece of pieces) {
          if (typeof piece !== 'object' || piece === null) continue
          const p = piece as Record<string, unknown>
          const id = argsString(p, 'id') ?? "p" + (state.units.length + 1)
          const title = argsString(p, 'title') ?? id
          state.units.push({ id, title, rounds: [] })
        }
      }
      break
    }
    case 'build': {
      const index = argsNumber(args, 'pieceIndex')
      if (index === undefined) break
      const unit = state.units[index]
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
      const unit = state.units[index]
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
    // status: no-op
  }
}

function deriveUnitStatus(rounds: readonly ProjectedRoundDTO[]): UnitStatusDTO {
  if (rounds.length === 0) return 'pending'
  const lastRound = rounds[rounds.length - 1]
  if (lastRound.winner === null) return 'awaiting_critique'
  return lastRound.winner === 'bar' ? 'rebuild' : 'won'
}

// ---- Unit: init / apply / view ----

export function createInitialProjectionState(): GauntletProjectionState {
  return {
    available: true,
    phase: 'idle',
    next: 'submit',
    nextPieceIndex: null,
    barName: null,
    units: [],
    summary: null,
    haltedReason: null,
    lastRejected: false,
    lastRejectionError: null,
    lastRejections: [],
    lastRejectedPhase: 'idle',
    lastRejectedNext: null,
    pending: {},
  }
}

/** Pure incremental fold: previous state + one committed session event. */
export function applyProjectionEvent(
  state: GauntletProjectionState,
  event: SessionEvent,
): GauntletProjectionState {
  // In-flight gauntlet tool/call: record the parsed args, return a new state
  // (only for gauntlet_loop calls).
  if (event.type === 'tool/call' && event.data.name === 'gauntlet_loop') {
    const callId = String(event.data.callId)
    const next: GauntletProjectionState = { ...state, pending: { ...state.pending } }
    next.pending[callId] = { args: parseCallArguments(event.data.arguments), time: event.time }
    return next
  }

  if (event.type !== 'tool/result') return state
  const result = event.data
  const source = result.message?.source
  const callId = typeof source?.callId === 'string' ? source.callId : undefined
  if (callId === undefined) return state
  const pendingCall = state.pending[callId]
  if (pendingCall === undefined) return state

  // Remove the pending call and settle the accepted/rejected facts.
  const pending = { ...state.pending }
  delete pending[callId]

  // Fail-closed: an infra-errored or aborted result is not a settled call.
  const firstBlock = result.message?.content?.[0]
  if (firstBlock?.type === 'tool-result' && firstBlock.isError === true) {
    return {
      ...state,
      pending,
      available: false,
      unavailableReason: 'settled gauntlet call carried an infrastructure error',
    }
  }

  const meta = result.meta
  const ok = readOk(meta)
  if (ok === null) {
    return {
      ...state,
      pending,
      available: false,
      unavailableReason: 'settled gauntlet call has no verification meta',
    }
  }
  const pres = readPresentation(meta)
  if (pres === null) {
    return {
      ...state,
      pending,
      available: false,
      unavailableReason: 'settled gauntlet call has an incompatible or missing presentation envelope',
    }
  }

  const next: GauntletProjectionState = {
    ...state,
    pending,
    phase: pres.phase,
    next: pres.next ?? null,
    nextPieceIndex: pres.nextPieceIndex ?? null,
  }

  if (ok) {
    // Accepted: clear the transient rejection state, then apply facts.
    next.lastRejected = false
    next.lastRejectionError = null
    next.lastRejections = []
    applyAction(next, argsString(pendingCall.args, 'action') ?? '', pendingCall.args)
  } else {
    // Rejected: presented state unchanged; record the blocked panel.
    next.lastRejected = true
    next.lastRejectionError = pres.error ?? null
    next.lastRejections = pres.rejections ?? []
    next.lastRejectedPhase = pres.phase
    next.lastRejectedNext = pres.next ?? null
  }
  return next
}

/** Read-side projection: state → wire DTO. */
export function projectionToDTO(state: GauntletProjectionState): GauntletProjectionDTO {
  const units = state.units.map(u => ({ ...u, status: deriveUnitStatus(u.rounds) }))
  const won = units.filter(u => u.status === 'won').length
  const total = units.length
  const totalRounds = state.units.reduce((sum, u) => sum + u.rounds.length, 0)
  const phase = state.phase as GauntletPhaseDTO
  const isDone = phase === 'done'
  const isHalted = phase === 'halted'
  const blocked = state.lastRejected
    ? {
      error: state.lastRejectionError,
      rejections: state.lastRejections,
      phase: state.lastRejectedPhase,
      next: state.lastRejectedNext,
    }
    : null
  const status: GauntletStatusDTO = isDone ? 'complete' : isHalted ? 'halted' : blocked !== null ? 'blocked' : 'running'
  const dto: GauntletProjectionDTO = {
    version: 1,
    available: state.available,
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
  }
  if (state.unavailableReason !== undefined) dto.unavailableReason = state.unavailableReason
  return dto
}

const gauntletProjection = {
  key: 'gauntlet' as const,
  stateSchema,
  init: createInitialProjectionState,
  apply: applyProjectionEvent,
  wire: { viewSchema: dtoSchema, view: projectionToDTO },
  stateVersion: 1,
}

/**
 * Register the Gauntlet projection unit. Optional capability: without a
 * composed session-projection registry the callback never runs and headless
 * assemblies stay unaffected.
 * @param ctx - registrant context.
 */
export function registerGauntletProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(gauntletProjection)
  })
}