/**
 * Client-side Gauntlet presentation helpers.
 *
 * No fold logic — the accumulated Gauntlet workbench arrives as a finished
 * whole value from the Host session-projection unit, read via
 * useProjection('gauntlet') (the SessionProjectionMap['gauntlet'] key).
 * This module provides a defensive wire parser (fail-closed), UI helpers, and
 * the SessionProjectionMap merge — no domain folding, no protocol
 * validation, no scanning of chat.legacy.nodes.
 */
import type {
  GauntletProjectionDTO, GauntletStatusDTO, ProjectedUnitDTO, UnitStatusDTO,
  ProjectedRoundDTO, BlockedDTO,
} from '../projection-types.js'
import { GAUNTLET_PROJECTION_VERSION } from '../projection-types.js'

export type { GauntletProjectionDTO, GauntletStatusDTO, ProjectedUnitDTO, UnitStatusDTO, ProjectedRoundDTO, BlockedDTO }

// ---- Defensive wire parser (fail-closed) ----

const NL = '\n'
const DL = '\n\n'

/**
 * Parse and validate a raw wire value as a GauntletProjectionDTO.
 * Returns null when the value is missing, malformed, or carries an
 * incompatible version — the caller must then fall back to the generic card.
 * This is a STRICT structural validation of every field the UI actually
 * consumes (units, rounds, won/total, bar/next, blocked, summary,
 * haltedReason, asOfSeq/asOfCallId).  Manual shape check (no zod in the
 * client bundle); the host validates its output via zod viewSchema.parse
 * before it leaves.
 */
const PHASES = new Set(['idle', 'refine', 'split', 'loop', 'report', 'done', 'halted'])
const STATUSES = new Set(['running', 'blocked', 'complete', 'halted'])
const UNIT_STATUSES = new Set(['pending', 'awaiting_critique', 'rebuild', 'won'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isValidRound(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.round === 'number'
    && isString(value.builder)
    && isString(value.artifactLocation)
    && isString(value.artifactSummary)
    && isString(value.builderEvidence)
    && isNullableString(value.critic)
    && (value.winner === null || value.winner === 'ours' || value.winner === 'bar')
    && isNullableString(value.criticNotes)
    && isNullableString(value.criticEvidence)
}

function isValidUnit(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isString(value.id)
    && isString(value.title)
    && typeof value.status === 'string' && UNIT_STATUSES.has(value.status)
    && Array.isArray(value.rounds) && value.rounds.every(isValidRound)
}

function isValidBlocked(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value)) return false
  return isNullableString(value.error)
    && Array.isArray(value.rejections) && value.rejections.every(isString)
    && isString(value.phase)
    && isNullableString(value.next)
}

export function parseProjectionWire(value: unknown): GauntletProjectionDTO | null {
  if (!isRecord(value)) return null
  if (typeof value.version !== 'number' || value.version !== GAUNTLET_PROJECTION_VERSION) return null
  if (value.available !== true) return null
  if (!(typeof value.phase === 'string' && PHASES.has(value.phase))) return null
  if (!(typeof value.status === 'string' && STATUSES.has(value.status))) return null
  if (!isNullableString(value.barName)) return null
  if (!isNullableString(value.next)) return null
  if (value.nextPieceIndex !== null && typeof value.nextPieceIndex !== 'number') return null
  if (!Array.isArray(value.units) || !value.units.every(isValidUnit)) return null
  if (typeof value.won !== 'number' || typeof value.total !== 'number') return null
  if (typeof value.totalRounds !== 'number') return null
  if (!isValidBlocked(value.blocked)) return null
  if (value.summary !== null && !(isRecord(value.summary)
    && isString(value.summary.outcome) && isString(value.summary.lessons))) return null
  if (!isNullableString(value.haltedReason)) return null
  if (value.asOfSeq !== null && typeof value.asOfSeq !== 'number') return null
  if (!isNullableString(value.asOfCallId)) return null
  return value as unknown as GauntletProjectionDTO
}


// ---- Per-call stable envelope (for historical cards) ----

/** The bounded presentation envelope persisted on ONE tool/result.meta. */
export interface BlockPresentationView {
  phase: string | null
  next: string | null
  error?: string
  rejections?: string[]
}

/**
 * Read the per-call presentation envelope from a frozen ToolResultNode's
 * meta.  Used to render a STABLE historical card (the state as of that
 * individual call), never the current session projection.  Returns null when
 * the envelope is missing/incompatible — the caller shows raw output.
 */
export function parseBlockPresentation(meta: unknown): BlockPresentationView | null {
  if (!isRecord(meta)) return null
  const pres = meta.presentation
  if (!isRecord(pres)) return null
  if (typeof pres.version !== 'number' || pres.version !== GAUNTLET_PROJECTION_VERSION) return null
  if (typeof pres.phase !== 'string' || pres.phase === '') return null
  return {
    phase: pres.phase,
    next: isNullableString(pres.next) ? pres.next : null,
    ...(typeof pres.error === 'string' ? { error: pres.error } : {}),
    ...(Array.isArray(pres.rejections) && pres.rejections.every(isString)
      ? { rejections: pres.rejections as string[] }
      : {}),
  }
}

// ---- UI helpers ----

function firstLine(text: string): string {
  const nl = text.indexOf(NL)
  return nl === -1 ? text : text.slice(0, nl)
}

/** Cap a long text block for the fallback card (bounded disclosure). */
export function boundedText(text: string, limit = 1200): string {
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

/** Flatten durable result blocks under the generic Tool-row text contract. */
function resultText(content: readonly { type: string; text?: string }[] | undefined, error?: { name: string; code: string }): string | null {
  if (!content || content.length === 0) {
    if (error) return error.name + ': ' + error.code
    return null
  }
  const parts: string[] = []
  for (const item of content) {
    parts.push(item.type === 'text' && item.text !== undefined ? item.text : JSON.stringify(item, null, 2))
  }
  return parts.join(NL) || null
}

/** Parse the action name from wire args (empty when unavailable). */
function actionOf(argsRaw: string | null): string {
  if (argsRaw === null || argsRaw === '') return ''
  try {
    const parsed = JSON.parse(argsRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const action = (parsed as Record<string, unknown>).action
    return typeof action === 'string' ? action : ''
  } catch {
    return ''
  }
}

function statusLabel(status: string, t: (key: string, params?: unknown) => string): string {
  switch (status) {
    case 'blocked': return t('row.blocked')
    case 'complete': return t('row.complete')
    case 'halted': return t('row.halted')
    default: return t('row.running')
  }
}

function unitStatusLabel(status: string, t: (key: string, params?: unknown) => string): string {
  switch (status) {
    case 'won': return t('row.won')
    case 'awaiting_critique': return t('row.awaitingCritique')
    case 'rebuild': return t('row.rebuild')
    default: return t('row.pending')
  }
}

function unitGlyphStatus(status: string): 'done' | 'ongoing' | 'warning' {
  switch (status) {
    case 'won': return 'done'
    case 'awaiting_critique': return 'ongoing'
    case 'rebuild': return 'warning'
    default: return 'done'
  }
}

/** Only filesystem-like paths are openable through the Host. */
function isOpenablePath(location: string): boolean {
  if (typeof location !== 'string' || location.length === 0) return false
  // URLs (with scheme) are never local paths.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return false
  // Opaque ids without a path separator, extension, or fs prefix are not openable.
  const hasSeparator = location.indexOf('/') !== -1 || location.indexOf('\\') !== -1
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(location)
  const hasFsPrefix = location.startsWith('./') || location.startsWith('../')
    || location.startsWith('/') || location.startsWith('~')
  return hasSeparator || hasExtension || hasFsPrefix
}

export { firstLine, resultText, actionOf, statusLabel, unitStatusLabel, unitGlyphStatus, isOpenablePath, DL }