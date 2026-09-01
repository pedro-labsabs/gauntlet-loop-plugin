import { createHash } from 'node:crypto'

export type GauntletPhase = 'idle' | 'refine' | 'split' | 'loop' | 'report' | 'done' | 'halted'
export type PieceStatus = 'pending' | 'awaiting_critique' | 'rebuild' | 'won'

/**
 * Version of the protocol FOLD semantics — the rules in `runGauntletAction`
 * that turn one settled call into the next state.  Bump this constant whenever
 * those rules change in a way that could produce a different state for the
 * same inputs: a persisted log written under an older version must then fail
 * closed at reconstruction instead of being silently replayed under new rules.
 */
export const GAUNTLET_PROTOCOL_VERSION = 1

/**
 * Version of the `GauntletState` SHAPE (schemaVersion field).  Bump when the
 * serialized state fields change.  Distinct from the fold-semantics version:
 * a state-shape change also requires a protocol-semantics review.
 */
export const GAUNTLET_SCHEMA_VERSION = 2

export interface QualityBar {
  name: string
  fetchHow: string
  compareHow: string
  description: string
}

export interface Artifact {
  location: string
  summary: string
}

export interface CriticVerdict {
  winner: 'ours' | 'bar'
  notes: string
  evidence: string
  blind: true
  criticSubagentId: string
}

export interface RoundState {
  round: number
  artifact: Artifact
  builderSubagentId: string
  builderEvidence: string
  verdict: CriticVerdict | null
}

export interface PieceState {
  id: string
  title: string
  status: PieceStatus
  rounds: RoundState[]
}

export interface GauntletState {
  schemaVersion: typeof GAUNTLET_SCHEMA_VERSION
  protocolVersion: typeof GAUNTLET_PROTOCOL_VERSION
  runId: string | null
  phase: GauntletPhase
  rawCommand: string | null
  refinedCommand: string | null
  bar: QualityBar | null
  subjectivity: {
    flagged: string[]
    resolved: { term: string; objectiveDefinition: string; measuredBy: string }[]
  } | null
  refineRejections: { refined: string; bar: unknown; reasons: string[]; flagged: string[]; at: number }[]
  pieces: { id: string; title: string; description: string }[]
  piecesState: PieceState[]
  startedAt: number | null
  finishedAt: number | null
  summary: { outcome: string; lessons: string } | null
  haltedReason: string | null
}

export interface GauntletActionInput {
  action: string
  command?: unknown
  refinedCommand?: unknown
  bar?: unknown
  subjectiveResolved?: unknown
  pieces?: unknown
  pieceIndex?: unknown
  builderSubagentId?: unknown
  builderEvidence?: unknown
  artifact?: unknown
  criticSubagentId?: unknown
  verdict?: unknown
  summary?: unknown
  reason?: unknown
}

export interface GauntletActionContext {
  now: number
  runId?: string
}

export interface GauntletResult {
  ok: boolean
  phase: GauntletPhase
  message?: string
  error?: string
  rejections?: string[]
  next: string | null
  nextPieceIndex?: number
  state: GauntletState
}

const SUBJECTIVE_TERMS = [
  'premium', 'modern', 'moderno', 'bonito', 'beautiful', 'clean', 'limpo',
  'fast', 'rapido', 'rápido', 'good', 'great', 'excelente', 'intuitive',
  'intuitivo', 'easy', 'facil', 'fácil', 'user-friendly', 'amigável',
  'alive', 'viva', 'vivo', 'dinamico', 'dinâmico', 'dynamic', 'engaging',
  'atraente', 'high-quality', 'professional', 'profissional', 'smooth',
  'fluido', 'polished', 'refinado', 'impressive', 'impressionante',
  'seamless', 'natural', 'robust', 'robusto', 'scalable', 'escalável',
  'nice', 'wow', 'best', 'melhor', 'awesome', 'incrivel', 'incrível',
  'cool', 'elegant', 'elegante', 'effective', 'eficaz', 'efficient',
  'eficiente', 'responsive', 'responsivo', 'reliable', 'confiavel',
  'confiável', 'award-winning', 'premiado', 'feels-alive', 'alta-qualidade',
]

const VAGUE_FETCH = /^(search|google|find|look up|browse|pesquise|procure|busque)(\s+(online|web|internet|na web|no google))?\.?$/i
const BLIND_COMPARE = /(blind|cego|cega|sem\s+r[oó]tul|without\s+labels?|labels?\s+(removed|hidden)|a\/b)/i

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function findSubjectiveTerms(input: string): string[] {
  const normalized = ` ${input.toLowerCase().replace(/[^a-z0-9áéíóúâêîôûãõçà-]+/g, ' ')} `
  const found: string[] = []
  for (const term of SUBJECTIVE_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(normalized) && !found.includes(term)) found.push(term)
  }
  return found
}

export function createInitialState(): GauntletState {
  return {
    schemaVersion: GAUNTLET_SCHEMA_VERSION,
    protocolVersion: GAUNTLET_PROTOCOL_VERSION,
    runId: null,
    phase: 'idle',
    rawCommand: null,
    refinedCommand: null,
    bar: null,
    subjectivity: null,
    refineRejections: [],
    pieces: [],
    piecesState: [],
    startedAt: null,
    finishedAt: null,
    summary: null,
    haltedReason: null,
  }
}

function resetInto(state: GauntletState): void {
  Object.assign(state, createInitialState())
}

/**
 * Deterministic semantic fingerprint of a GauntletState, used to verify that a
 * replayed settled call reproduces the exact result that was originally
 * persisted.  Excludes volatile timestamps (`startedAt`, `finishedAt`,
 * `refineRejections[].at`) and the envelope versions (checked separately via
 * the persisted meta), so live execution and replay agree byte-for-byte even
 * when the harness stamps slightly different wall-clock times.  Every field
 * that shapes the protocol's next transition is included, so any tampering
 * that changes a call's semantics produces a different fingerprint.
 *
 * Returns a FIXED-SIZE SHA-256 hex digest of a canonical (deterministically
 * key-sorted) JSON representation — never the whole state JSON.  This keeps
 * the persisted `tool/result.meta` constant-sized regardless of how large the
 * accumulated state grows (no O(n²) write amplification).
 */
export function stateFingerprint(state: GauntletState): string {
  const payload = {
    phase: state.phase,
    runId: state.runId,
    rawCommand: state.rawCommand,
    refinedCommand: state.refinedCommand,
    bar: state.bar,
    subjectivity: state.subjectivity,
    refineRejections: state.refineRejections.map(rejection => ({
      refined: rejection.refined,
      bar: rejection.bar,
      reasons: rejection.reasons,
      flagged: rejection.flagged,
    })),
    pieces: state.pieces,
    piecesState: state.piecesState,
    summary: state.summary,
    haltedReason: state.haltedReason,
  }
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

/**
 * Deterministic JSON encoding with recursively sorted object keys, so the
 * digest input is independent of key insertion order (a canonical form).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const child = record[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`)
  }
  return `{${parts.join(',')}}`
}

function allAgentIds(state: GauntletState): Set<string> {
  const ids = new Set<string>()
  for (const piece of state.piecesState) {
    for (const round of piece.rounds) {
      if (round.builderSubagentId) ids.add(round.builderSubagentId)
      if (round.verdict?.criticSubagentId) ids.add(round.verdict.criticSubagentId)
    }
  }
  return ids
}

function nextStep(state: GauntletState): { action: string | null; pieceIndex?: number } {
  if (state.phase === 'idle') return { action: 'submit' }
  if (state.phase === 'refine') return { action: 'refine' }
  if (state.phase === 'split') return { action: 'split' }
  if (state.phase === 'report') return { action: 'complete' }
  if (state.phase === 'done' || state.phase === 'halted') return { action: null }
  const critiqueIndex = state.piecesState.findIndex(piece => piece.status === 'awaiting_critique')
  if (critiqueIndex >= 0) return { action: 'critique', pieceIndex: critiqueIndex }
  const buildIndex = state.piecesState.findIndex(piece => piece.status === 'rebuild' || piece.status === 'pending')
  return buildIndex >= 0 ? { action: 'build', pieceIndex: buildIndex } : { action: null }
}

function result(state: GauntletState, ok: boolean, fields: Omit<GauntletResult, 'ok' | 'phase' | 'state' | 'next'> = {}): GauntletResult {
  const next = nextStep(state)
  return {
    ok,
    phase: state.phase,
    ...fields,
    next: next.action,
    ...(next.pieceIndex === undefined ? {} : { nextPieceIndex: next.pieceIndex }),
    state,
  }
}

function fail(state: GauntletState, error: string): GauntletResult {
  return result(state, false, { error })
}

export function runGauntletAction(state: GauntletState, input: GauntletActionInput, context: GauntletActionContext): GauntletResult {
  const action = text(input.action)

  if (action === 'status') return result(state, true, { message: 'Gauntlet status.' })

  if (action === 'reset') {
    resetInto(state)
    return result(state, true, { message: 'Gauntlet resetado.' })
  }

  if (action === 'submit') {
    const command = text(input.command)
    if (!command) return fail(state, 'Informe o comando em "command".')
    resetInto(state)
    state.runId = text(context.runId) || `gauntlet-${context.now}`
    state.rawCommand = command
    state.phase = 'refine'
    state.startedAt = context.now
    return result(state, true, {
      message: 'Comando recebido. Refine o objetivo, torne termos subjetivos mensuráveis e defina uma barra real, nomeada, acessível e comparável.',
    })
  }

  if (action === 'halt') {
    if (state.phase === 'idle' || state.phase === 'done' || state.phase === 'halted') {
      return fail(state, 'halt só é válido durante um gauntlet ativo.')
    }
    const reason = text(input.reason)
    if (!reason) return fail(state, 'Informe reason para registrar por que o gauntlet foi interrompido.')
    state.phase = 'halted'
    state.haltedReason = reason
    state.finishedAt = context.now
    return result(state, true, { message: `Gauntlet interrompido: ${reason}` })
  }

  if (action === 'refine') {
    if (state.phase !== 'refine') return fail(state, 'refine só é válido após submit.')
    const refined = text(input.refinedCommand)
    const bar = asRecord(input.bar)
    const subjective = Array.isArray(input.subjectiveResolved)
      ? input.subjectiveResolved.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
      : []
    const reasons: string[] = []

    if (!refined) reasons.push('Informe refinedCommand.')
    const barName = text(bar?.name)
    const fetchHow = text(bar?.fetchHow)
    const compareHow = text(bar?.compareHow)
    if (!barName) reasons.push('bar.name vazio — use uma referência específica e nomeada.')
    if (!fetchHow) reasons.push('bar.fetchHow vazio — diga exatamente como o crítico abre/obtém a referência.')
    else if (VAGUE_FETCH.test(fetchHow) || fetchHow.length < 8) reasons.push('bar.fetchHow é vago demais — forneça URL, caminho, comando ou procedimento reproduzível.')
    if (!compareHow) reasons.push('bar.compareHow vazio — diga como artefato e barra serão comparados sem rótulos.')
    else if (compareHow.length < 12 || !BLIND_COMPARE.test(compareHow)) reasons.push('bar.compareHow deve descrever explicitamente uma comparação cega/sem rótulos reproduzível.')

    const flagged = refined ? findSubjectiveTerms(refined) : []
    const missing = flagged.filter(term => !subjective.some(entry => text(entry.term).toLowerCase() === term.toLowerCase()))
    const incomplete = subjective.filter(entry => !text(entry.term) || !text(entry.objectiveDefinition) || !text(entry.measuredBy))
    if (missing.length) reasons.push(`Termos subjetivos sem definição objetiva: ${missing.join(', ')}.`)
    if (incomplete.length) reasons.push('subjectiveResolved incompleto: cada entrada precisa de term, objectiveDefinition e measuredBy.')

    if (reasons.length) {
      state.refineRejections.push({ refined, bar: input.bar ?? null, reasons, flagged, at: context.now })
      return result(state, false, {
        message: 'O comando/barra ainda não passa pelo gate de qualidade.',
        rejections: reasons,
      })
    }

    state.refinedCommand = refined
    state.bar = {
      name: barName,
      fetchHow,
      compareHow,
      description: text(bar?.description),
    }
    state.subjectivity = {
      flagged,
      resolved: subjective.map(entry => ({
        term: text(entry.term),
        objectiveDefinition: text(entry.objectiveDefinition),
        measuredBy: text(entry.measuredBy),
      })),
    }
    state.phase = 'split'
    return result(state, true, { message: 'Gate de qualidade aprovado. Divida o trabalho em unidades pequenas e julgáveis.' })
  }

  if (action === 'split') {
    if (state.phase !== 'split') return fail(state, 'split só é válido após refine.')
    const rawPieces = Array.isArray(input.pieces) ? input.pieces : []
    const pieces = rawPieces.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    if (!pieces.length) return fail(state, 'Informe ao menos uma peça {id, title, description}.')
    if (pieces.length > 32) return fail(state, 'Máximo de 32 peças por gauntlet; agrupe unidades excessivamente pequenas.')

    const normalized = pieces.map((piece, index) => ({
      id: text(piece.id) || `p${index + 1}`,
      title: text(piece.title),
      description: text(piece.description),
    }))
    const invalid = normalized.find(piece => !piece.title || !piece.description)
    if (invalid) return fail(state, `Peça ${invalid.id} precisa de title e description não vazios.`)
    const ids = normalized.map(piece => piece.id)
    if (new Set(ids).size !== ids.length) return fail(state, 'IDs de peças devem ser únicos.')

    state.pieces = normalized
    state.piecesState = normalized.map(piece => ({ id: piece.id, title: piece.title, status: 'pending', rounds: [] }))
    state.phase = 'loop'
    return result(state, true, { message: `Gauntlet iniciado com ${normalized.length} peça(s). Builders e críticos devem usar contextos separados.` })
  }

  if (action === 'build') {
    if (state.phase !== 'loop') return fail(state, 'build só é válido na fase loop.')
    const index = typeof input.pieceIndex === 'number' && Number.isInteger(input.pieceIndex) ? input.pieceIndex : -1
    const piece = state.piecesState[index]
    if (!piece) return fail(state, `pieceIndex inválido: ${index}.`)
    if (piece.status === 'won') return fail(state, 'Essa peça já venceu.')
    if (piece.status === 'awaiting_critique') return fail(state, 'Essa peça já tem um build aguardando crítica; critique-o antes de reconstruir.')

    const builderSubagentId = text(input.builderSubagentId)
    if (!builderSubagentId) return fail(state, 'builderSubagentId é obrigatório; o lead não pode registrar um build sem um builder separado.')
    if (allAgentIds(state).has(builderSubagentId)) return fail(state, 'builderSubagentId já foi usado neste gauntlet; cada round deve usar um sub-agent novo.')

    const artifact = asRecord(input.artifact)
    const location = text(artifact?.location)
    const summary = text(artifact?.summary)
    if (!location || !summary) return fail(state, 'artifact precisa de location e summary não vazios para o crítico inspecionar o artefato real.')

    piece.rounds.push({
      round: piece.rounds.length + 1,
      artifact: { location, summary },
      builderSubagentId,
      builderEvidence: text(input.builderEvidence),
      verdict: null,
    })
    piece.status = 'awaiting_critique'
    return result(state, true, { message: `Build ${piece.id} R${piece.rounds.length} registrado. Agora use um crítico novo, cego e separado.` })
  }

  if (action === 'critique') {
    if (state.phase !== 'loop') return fail(state, 'critique só é válido na fase loop.')
    const index = typeof input.pieceIndex === 'number' && Number.isInteger(input.pieceIndex) ? input.pieceIndex : -1
    const piece = state.piecesState[index]
    if (!piece) return fail(state, `pieceIndex inválido: ${index}.`)
    if (piece.status !== 'awaiting_critique') return fail(state, 'Não existe build pendente de crítica para essa peça.')
    const last = piece.rounds[piece.rounds.length - 1]
    if (!last || last.verdict !== null) return fail(state, 'Round inválido: a crítica precisa corresponder ao último build ainda não julgado.')

    const criticSubagentId = text(input.criticSubagentId)
    if (!criticSubagentId) return fail(state, 'criticSubagentId é obrigatório; autoavaliação do builder não conta como Gauntlet.')
    if (criticSubagentId === last.builderSubagentId) return fail(state, 'O crítico deve ser um sub-agent diferente do builder.')
    if (allAgentIds(state).has(criticSubagentId)) return fail(state, 'criticSubagentId já foi usado; cada round exige crítico com contexto fresco.')

    const verdict = asRecord(input.verdict)
    if (!verdict) return fail(state, 'verdict deve ser um objeto com winner, notes, evidence e blind.')
    const winner = verdict.winner
    if (winner !== 'ours' && winner !== 'bar') return fail(state, 'verdict.winner deve ser "ours" ou "bar".')
    const notes = text(verdict.notes)
    const evidence = text(verdict.evidence)
    if (!notes) return fail(state, 'verdict.notes é obrigatório e deve explicar a decisão do crítico.')
    if (!evidence) return fail(state, 'verdict.evidence é obrigatório e deve registrar evidência observável da comparação.')
    if (verdict.blind !== true) return fail(state, 'verdict.blind deve ser true; sem comparação cega não declare um Gauntlet válido.')

    last.verdict = { winner, notes, evidence, blind: true, criticSubagentId }
    if (winner === 'bar') {
      piece.status = 'rebuild'
      return result(state, true, { message: `${piece.id} perdeu R${last.round}. Rebuild obrigatório com novo builder.` })
    }

    piece.status = 'won'
    if (state.piecesState.every(candidate => candidate.status === 'won')) {
      state.phase = 'report'
      return result(state, true, { message: 'Todas as peças venceram a barra. Registre o relatório final com evidências e lições.' })
    }
    return result(state, true, { message: `${piece.id} venceu R${last.round}. Continue nas peças restantes.` })
  }

  if (action === 'complete') {
    if (state.phase !== 'report') return fail(state, 'complete só é válido depois que todas as peças vencerem.')
    const summary = asRecord(input.summary)
    const outcome = text(summary?.outcome)
    if (!outcome) return fail(state, 'summary.outcome é obrigatório.')
    state.summary = { outcome, lessons: text(summary?.lessons) }
    state.phase = 'done'
    state.finishedAt = context.now
    return result(state, true, { message: `Gauntlet concluído. ${outcome}` })
  }

  return fail(state, `Ação desconhecida: ${action}`)
}
