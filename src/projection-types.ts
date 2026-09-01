/**
 * Shared wire types of the Gauntlet session projection: the presentation DTO
 * the client renders and the `SessionProjectionMap` merge.  This module is
 * client-safe (zero node imports) so both halves can consume the same DTO
 * contract without dragging host-only dependencies into the browser bundle.
 *
 * @module gauntlet-loop-plugin/projection-types
 */

/** Wire version of the projection DTO.  The client fail-closes on mismatch. */
export const GAUNTLET_PROJECTION_VERSION = 1

export interface ProjectedRoundDTO {
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

export type UnitStatusDTO = 'pending' | 'awaiting_critique' | 'rebuild' | 'won'

export interface ProjectedUnitDTO {
  id: string
  title: string
  status: UnitStatusDTO
  rounds: readonly ProjectedRoundDTO[]
}

export interface BlockedDTO {
  error: string | null
  rejections: readonly string[]
  phase: string
  next: string | null
}

export type GauntletPhaseDTO = 'idle' | 'refine' | 'split' | 'loop' | 'report' | 'done' | 'halted'
export type GauntletStatusDTO = 'running' | 'blocked' | 'complete' | 'halted'

export interface GauntletProjectionDTO {
  /** Projection DTO version; the client fail-closes on mismatch. */
  version: number
  /** Whether the projection could be safely derived from the full log. */
  available: boolean
  /** Human-readable reason when unavailable (debugging aid). */
  unavailableReason?: string
  /** Current protocol phase (from the last settled call's envelope). */
  phase: GauntletPhaseDTO | null
  /** Display status derived from phase + blocked. */
  status: GauntletStatusDTO
  /** Quality bar name. */
  barName: string | null
  /** Next action expected. */
  next: string | null
  /** Piece index for the next action, when applicable. */
  nextPieceIndex: number | null
  /** List of units. */
  units: readonly ProjectedUnitDTO[]
  /** Number of won units. */
  won: number
  /** Total units. */
  total: number
  /** Total accumulated rounds. */
  totalRounds: number
  /** Blocked state when the last settled call was rejected. */
  blocked: BlockedDTO | null
  /** Terminal summary when the gauntlet completed. */
  summary: { outcome: string; lessons: string } | null
  /** Reason when the gauntlet was halted. */
  haltedReason: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The accumulated Gauntlet workbench presentation (whole value). Absent
     * key = capability absent (unit not registered / not yet baseline).
     */
    gauntlet: GauntletProjectionDTO
  }
}
