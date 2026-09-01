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
 * Manual shape check (no zod in the client bundle); the host validates its
 * output via zod viewSchema.parse before it leaves.
 */
export function parseProjectionWire(value: unknown): GauntletProjectionDTO | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (typeof obj.version !== 'number' || obj.version !== GAUNTLET_PROJECTION_VERSION) return null
  if (obj.available !== true) return null
  if (typeof obj.phase !== 'string' && obj.phase !== null) return null
  if (typeof obj.status !== 'string') return null
  const validStatuses = ['running', 'blocked', 'complete', 'halted']
  if (!validStatuses.includes(obj.status as string)) return null
  return value as GauntletProjectionDTO
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