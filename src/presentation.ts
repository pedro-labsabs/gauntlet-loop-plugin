import type { GauntletResult, GauntletState, PieceState } from './core.js'

const BAR_WIDTH = 18

function progress(state: GauntletState): { won: number; total: number; rounds: number } {
  return {
    won: state.piecesState.filter(piece => piece.status === 'won').length,
    total: state.piecesState.length,
    rounds: state.piecesState.reduce((sum, piece) => sum + piece.rounds.length, 0),
  }
}

function progressBar(won: number, total: number): string {
  if (total <= 0) return '░'.repeat(BAR_WIDTH)
  const filled = Math.round((won / total) * BAR_WIDTH)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
}

function pieceGlyph(piece: PieceState): string {
  switch (piece.status) {
    case 'won': return '✓'
    case 'awaiting_critique': return '◇'
    case 'rebuild': return '↻'
    default: return '○'
  }
}

function pieceDetail(piece: PieceState): string {
  const last = piece.rounds[piece.rounds.length - 1]
  if (!last) return 'not built'
  if (!last.verdict) return `R${last.round} awaiting critic`
  return `R${last.round} ${last.verdict.winner === 'ours' ? 'OURS' : 'BAR'}`
}

function compact(text: string, max = 180): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`
}

function latestEvidence(piece: PieceState): string | null {
  const last = piece.rounds[piece.rounds.length - 1]
  if (!last) return null
  if (!last.verdict) return `artifact ${compact(last.artifact.location, 80)}`
  return `artifact ${compact(last.artifact.location, 60)} · ${last.verdict.winner.toUpperCase()} · ${compact(last.verdict.evidence, 100)}`
}

function phaseLabel(state: GauntletState): string {
  switch (state.phase) {
    case 'idle': return 'IDLE'
    case 'refine': return 'REFINE / SET THE BAR'
    case 'split': return 'SPLIT / DEFINE UNITS'
    case 'loop': return 'BUILD ⇄ BLIND CRITIC'
    case 'report': return 'FINAL REPORT'
    case 'done': return 'COMPLETE'
    case 'halted': return 'HALTED'
  }
}

function nextLabel(result: GauntletResult): string {
  if (!result.next) return 'none'
  return result.nextPieceIndex === undefined ? result.next : `${result.next} piece[${result.nextPieceIndex}]`
}

export function renderDashboard(result: GauntletResult): string {
  const state = result.state
  const stats = progress(state)
  const lines = [
    '┌─ GAUNTLET LOOP ─────────────────────────────────────────────',
    `│ ${result.ok ? 'OK' : 'BLOCKED'}  ${phaseLabel(state)}${state.runId ? `  ·  ${state.runId}` : ''}`,
  ]

  if (stats.total > 0) {
    lines.push(`│ ${progressBar(stats.won, stats.total)}  ${stats.won}/${stats.total} units won  ·  ${stats.rounds} round(s)`)
  }

  if (state.bar) lines.push(`│ BAR  ${state.bar.name}`)
  if (result.error) lines.push(`│ ERROR  ${result.error}`)
  else if (result.message) lines.push(`│ ${result.message}`)
  if (result.rejections?.length) {
    for (const rejection of result.rejections.slice(0, 5)) lines.push(`│ × ${rejection}`)
    if (result.rejections.length > 5) lines.push(`│ × … ${result.rejections.length - 5} more rejection(s)`)
  }

  if (state.piecesState.length) {
    lines.push('├─ UNITS')
    for (const piece of state.piecesState.slice(0, 12)) {
      lines.push(`│ ${pieceGlyph(piece)} ${piece.id}  ${piece.title}  ·  ${pieceDetail(piece)}`)
      const evidence = latestEvidence(piece)
      if (evidence) lines.push(`│    ↳ ${evidence}`)
    }
    if (state.piecesState.length > 12) lines.push(`│ … ${state.piecesState.length - 12} more unit(s)`)
  }

  if (state.phase === 'halted' && state.haltedReason) lines.push(`│ HALT  ${state.haltedReason}`)
  lines.push(`├─ NEXT  ${nextLabel(result)}`)
  lines.push('└─────────────────────────────────────────────────────────────')
  return lines.join('\n')
}

export function renderToolValue(value: unknown): string {
  const candidate = value as Partial<GauntletResult> | null
  if (candidate && typeof candidate === 'object' && candidate.state && typeof candidate.ok === 'boolean') {
    return renderDashboard(candidate as GauntletResult)
  }
  return JSON.stringify(value, null, 2)
}
