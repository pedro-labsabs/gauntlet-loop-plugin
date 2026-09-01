/**
 * Model-facing `gauntlet_loop` tool: an anti-subjectivity command refinement
 * gate followed by a builder/critic sub-agent quality loop.
 *
 * The lead agent (the model calling this tool) feeds a raw command through
 * `submit` → `refine` → `split` → per-piece `build`/`critique` → `complete`.
 * `refine` rejects vague quality bars and unresolved subjective terms before
 * the loop may start; `critique` only advances a piece when a separate critic
 * sub-agent picks `ours` in a blind comparison against the bar.
 * @module @deepseek-ai/dsh-tool-gauntlet
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'

export const name = 'tool-gauntlet'
export const inject = ['tools']

/** Subjective terms the refine gate flags for objective resolution. */
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
  'confiável', 'award-winning', 'premiado', 'feels-alive',
  'alta-qualidade',
]

/** One piece of split work, with its round history. */
interface PieceState {
  id: string
  title: string
  status: 'pending' | 'building' | 'won'
  rounds: {
    round: number
    artifact: { location: string; summary: string }
    builderSubagentId: string
    verdict: { winner: 'ours' | 'bar'; notes: string; criticSubagentId: string } | null
  }[]
}

/** One quality bar as stored. */
interface QualityBar {
  name: string
  fetchHow: string
  compareHow: string
  description: string
}

/** Per-session gauntlet loop state, keyed by agent session id. */
interface GauntletState {
  phase: 'idle' | 'refine' | 'split' | 'loop' | 'done'
  rawCommand: string | null
  refinedCommand: string | null
  bar: QualityBar | null
  subjectivity: { flagged: string[]; resolved: { term: string; objectiveDefinition: string; measuredBy: string }[] } | null
  refineRejections: { refined: string; bar: unknown; reasons: string[]; flagged: string[]; at: number }[]
  pieces: { id: string; title: string; description: string }[]
  piecesState: PieceState[]
  currentPiece: number
  round: number
  startedAt: number | null
  finishedAt: number | null
  summary: { outcome: string; lessons: string } | null
}

/** Identify subjective terms present in a command. */
function findSubjectiveTerms(text: string): string[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9áéíóúâêîôûãõçà-]+/g, ' ')} `
  const found: string[] = []
  for (const term of SUBJECTIVE_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower) && !found.includes(term)) found.push(term)
  }
  return found
}

function initialState(): GauntletState {
  return {
    phase: 'idle',
    rawCommand: null,
    refinedCommand: null,
    bar: null,
    subjectivity: null,
    refineRejections: [],
    pieces: [],
    piecesState: [],
    currentPiece: 0,
    round: 1,
    startedAt: null,
    finishedAt: null,
    summary: null,
  }
}

/** Stored per-session loop states; process-global keyed by the caller's agent session id. */
const SESSION_STATES = new Map<string, GauntletState>()

function stateFor(exec: ToolExecution): GauntletState {
  const sessionId = exec.agent?.id ?? 'anonymous'
  let state = SESSION_STATES.get(sessionId)
  if (!state) {
    state = initialState()
    SESSION_STATES.set(sessionId, state)
  }
  return state
}

function snapshot(state: GauntletState): JsonValue {
  return {
    phase: state.phase,
    rawCommand: state.rawCommand,
    refinedCommand: state.refinedCommand,
    bar: state.bar,
    subjectivity: state.subjectivity,
    refineRejections: state.refineRejections,
    pieces: state.pieces,
    piecesState: state.piecesState,
    currentPiece: state.currentPiece,
    round: state.round,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    summary: state.summary,
  } as unknown as JsonValue
}

function reset(state: GauntletState): void {
  const fresh = initialState()
  Object.assign(state, fresh)
}

/**
 * Register the `gauntlet_loop` tool on the calling scope's tools registry.
 * @param ctx - Cordis context carrying the tools service.
 */
export function apply(ctx: Context): void {
  const tool = defineTool({
    name: 'gauntlet_loop',
    description:
      'Gauntlet Loop (Matt Shumer technique): a LEAD AGENT breaks a project into small parts '
      + 'and uses SEPARATE critic SUB-AGENTS to test the work against a strict quality benchmark '
      + 'in a continuous loop. PRECEPTS: (1) real quality bar — named, fetchable, comparable '
      + '(never a rubric); (2) BEFORE the loop, de-subjectivize the prompt: every subjective term '
      + '(premium, modern, bonito, user-friendly, etc.) must be replaced or paired with an '
      + 'objective, measurable definition; (3) split work into small pieces; (4) for each piece, '
      + 'spawn a SEPARATE BUILDER SUB-AGENT (subagent tool) that produces the artifact, then a '
      + 'SEPARATE CRITIC SUB-AGENT with FRESH context that opens the artifact + the bar and does '
      + 'a BLIND comparison (labels stripped), returning a binary verdict; (5) loop until the '
      + 'piece WINS — never fixed rounds; (6) adapt the initial command until the bar is adequate. '
      + 'The LEAD AGENT (you) stays the orchestrator: spawn builders/critics via the subagent '
      + 'tool and report their ids here.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['submit', 'refine', 'split', 'build', 'critique', 'complete', 'status', 'reset'],
        description: 'Gauntlet Loop action.',
      },
      command: { type: 'string', description: 'Raw user command (for action=submit).' },
      refinedCommand: { type: 'string', description: 'Refined command (for action=refine).' },
      bar: { type: 'json', description: 'Quality bar: {name, fetchHow, compareHow, description} (for action=refine).' },
      subjectiveResolved: {
        type: 'json',
        description: 'For refine: array of subjective term resolutions [{term, objectiveDefinition, measuredBy}] — required when subjective terms are detected in refinedCommand.',
      },
      pieces: { type: 'json', description: 'Array of pieces: [{id, title, description}] (for action=split).' },
      pieceIndex: { type: 'integer', description: '0-based piece index (for build/critique).' },
      builderSubagentId: { type: 'string', description: 'Id of the separate BUILDER sub-agent that produced the artifact (for action=build).' },
      artifact: { type: 'json', description: 'Built artifact: {location, summary} (for action=build).' },
      criticSubagentId: { type: 'string', description: 'Id of the separate CRITIC sub-agent that did the blind comparison (for action=critique).' },
      verdict: { type: 'json', description: 'Binary critic verdict: {winner: "ours"|"bar", notes} (for action=critique).' },
      summary: { type: 'json', description: 'Final summary: {outcome, lessons} (for action=complete).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      const state = stateFor(exec)
      const action = String(args.action)
      const snapshotNow = (): JsonValue => snapshot(state)
      const jv = (value: unknown): JsonValue => value as unknown as JsonValue

      if (action === 'status') return jv({ ok: true, phase: state.phase, state: snapshotNow() })
      if (action === 'reset') {
        reset(state)
        return jv({ ok: true, phase: state.phase, message: 'Gauntlet resetado. Chame action="submit" com um novo comando.', state: snapshotNow(), next: 'submit' })
      }

      // ---- SUBMIT ----
      if (action === 'submit') {
        const cmd = typeof args.command === 'string' ? args.command.trim() : ''
        if (!cmd) return jv({ ok: false, phase: state.phase, error: 'Informe o comando em "command".', state: snapshotNow() })
        reset(state)
        state.rawCommand = cmd
        state.phase = 'refine'
        state.startedAt = Date.now()
        return jv({
          ok: true,
          phase: state.phase,
          message: 'Comando recebido. Fase REFINE: remova ou defina objetivamente cada termo subjetivo. Proponha um comando refinado, uma barra REAL (nomeada, fetchable, comparável), e para cada termo subjetivo que persistir, forneça subjectiveResolved=[{term, objectiveDefinition, measuredBy}].',
          state: snapshotNow(),
          next: 'refine',
        })
      }

      // ---- REFINE (anti-subjectivity gate) ----
      if (action === 'refine') {
        if (state.phase !== 'refine') return jv({ ok: false, phase: state.phase, error: 'refine só é válido após submit.', state: snapshotNow() })
        const refined = typeof args.refinedCommand === 'string' ? args.refinedCommand.trim() : ''
        const bar = args.bar && typeof args.bar === 'object' ? args.bar as Record<string, unknown> : null
        const subj = Array.isArray(args.subjectiveResolved) ? args.subjectiveResolved as Record<string, unknown>[] : []
        const reasons: string[] = []

        if (!refined) reasons.push('Informe refinedCommand.')
        if (!bar || typeof bar.name !== 'string' || !bar.name.trim()) reasons.push('bar.name vazio — a barra precisa de um NOME específico (ex.: site/página/post/repo real)')
        if (!bar || typeof bar.fetchHow !== 'string' || !bar.fetchHow.trim()) reasons.push('bar.fetchHow vazio — como o crítico vai ABRIR a barra? (URL, screenshot, comando)')
        if (!bar || typeof bar.compareHow !== 'string' || !bar.compareHow.trim()) reasons.push('bar.compareHow vazio — como o crítico compara CEGAMENTE? (ex.: screenshots lado a lado sem rótulos)')

        const flagged = refined ? findSubjectiveTerms(refined) : []
        const missing = flagged.filter((t) => !subj.some((r) => String(r.term ?? '').toLowerCase() === t.toLowerCase()))
        const incomplete = subj.filter((r) => !r || !String(r.objectiveDefinition ?? '').trim() || !String(r.measuredBy ?? '').trim())
        if (missing.length > 0) {
          reasons.push(`TERMOS SUBJETIVOS sem definição objetiva: ${missing.join(', ')}. Para cada um, remova-o do comando OU forneça subjectiveResolved com {term, objectiveDefinition, measuredBy}.`)
        }
        if (incomplete.length > 0) {
          reasons.push('subjectiveResolved incompleto: cada entrada precisa de term + objectiveDefinition (o que significa objetivamente) + measuredBy (como medir/comparar).')
        }

        if (reasons.length > 0) {
          state.refineRejections.push({ refined, bar, reasons, flagged, at: Date.now() })
          return jv({ ok: false, phase: 'refine', message: 'O comando/barra ainda não está adequado ao Gauntlet. Corrija os itens abaixo.', rejections: reasons, state: snapshotNow(), next: 'refine' })
        }

        state.refinedCommand = refined
        state.bar = {
          name: String(bar!.name).trim(),
          fetchHow: String(bar!.fetchHow).trim(),
          compareHow: String(bar!.compareHow).trim(),
          description: bar!.description ? String(bar!.description).trim() : '',
        }
        state.subjectivity = {
          flagged,
          resolved: subj.map((r) => ({ term: String(r.term).trim(), objectiveDefinition: String(r.objectiveDefinition).trim(), measuredBy: String(r.measuredBy).trim() })),
        }
        state.phase = 'split'
        return jv({
          ok: true,
          phase: state.phase,
          message: 'Comando refinado, barra aceita e subjetividade resolvida! Divida o trabalho em PEÇAS PEQUENAS: action="split" com pieces=[{id, title, description}].',
          state: snapshotNow(),
          next: 'split',
        })
      }

      // ---- SPLIT ----
      if (action === 'split') {
        if (state.phase !== 'split') return jv({ ok: false, phase: state.phase, error: 'split só é válido após refine.', state: snapshotNow() })
        const pieces = Array.isArray(args.pieces) ? args.pieces as Record<string, unknown>[] : []
        const valid = pieces.filter((p) => p && typeof p === 'object' && typeof p.title === 'string' && p.title.trim())
        if (valid.length === 0) return jv({ ok: false, phase: state.phase, error: 'Informe pieces com ao menos uma peça {title, description}.', state: snapshotNow() })
        state.pieces = valid.map((p, i) => ({
          id: p.id != null ? String(p.id) : `p${i + 1}`,
          title: String(p.title).trim(),
          description: p.description ? String(p.description) : '',
        }))
        state.piecesState = state.pieces.map((p) => ({ id: p.id, title: p.title, status: 'pending' as const, rounds: [] }))
        state.currentPiece = 0
        state.round = 1
        state.phase = 'loop'
        return jv({
          ok: true,
          phase: state.phase,
          message: `Trabalho dividido em ${state.pieces.length} peça(s). Fase LOOP: você é o LEAD AGENT. Para a peça 1, spawn um BUILDER SUB-AGENT separado (tool subagent), então chame action="build" com pieceIndex=0, builderSubagentId e artifact={location, summary}.`,
          state: snapshotNow(),
          next: 'build',
          currentPiece: state.piecesState[0],
        })
      }

      // ---- BUILD ----
      if (action === 'build') {
        if (state.phase !== 'loop') return jv({ ok: false, phase: state.phase, error: 'build só é válido na fase loop.', state: snapshotNow() })
        const idx = typeof args.pieceIndex === 'number' && Number.isInteger(args.pieceIndex) ? args.pieceIndex : -1
        const ps = state.piecesState[idx]
        if (!ps) return jv({ ok: false, phase: state.phase, error: `pieceIndex inválido: ${idx}.`, state: snapshotNow() })
        if (ps.status === 'won') return jv({ ok: false, phase: state.phase, error: 'Essa peça já venceu.', state: snapshotNow() })
        ps.status = 'building'
        const art = args.artifact && typeof args.artifact === 'object'
          ? { location: String((args.artifact as Record<string, unknown>).location ?? ''), summary: String((args.artifact as Record<string, unknown>).summary ?? '') }
          : { location: '', summary: '' }
        ps.rounds.push({ round: state.round, artifact: art, builderSubagentId: typeof args.builderSubagentId === 'string' ? args.builderSubagentId : '', verdict: null })
        state.currentPiece = idx
        return jv({
          ok: true,
          phase: state.phase,
          message: `Build da peça ${idx + 1} (round ${state.round}) registrado (builder: ${ps.rounds[ps.rounds.length - 1]!.builderSubagentId || 'não informado'}). Spawn um CRITIC SUB-AGENT SEPARADO com contexto FRESCO: ele deve abrir o artefato e a barra, comparar CEGAMENTE e devolver qual vence. Chame action="critique" com pieceIndex=${idx}, criticSubagentId e verdict={winner: "ours"|"bar", notes}.`,
          state: snapshotNow(),
          next: 'critique',
          piece: ps,
        })
      }

      // ---- CRITIQUE ----
      if (action === 'critique') {
        if (state.phase !== 'loop') return jv({ ok: false, phase: state.phase, error: 'critique só é válido na fase loop.', state: snapshotNow() })
        const idx = typeof args.pieceIndex === 'number' && Number.isInteger(args.pieceIndex) ? args.pieceIndex : -1
        const ps = state.piecesState[idx]
        if (!ps) return jv({ ok: false, phase: state.phase, error: `pieceIndex inválido: ${idx}.`, state: snapshotNow() })
        const v = args.verdict && typeof args.verdict === 'object' ? args.verdict as Record<string, unknown> : {}
        const winner = v.winner
        if (winner !== 'ours' && winner !== 'bar') return jv({ ok: false, phase: state.phase, error: 'verdict.winner deve ser "ours" ou "bar".', state: snapshotNow() })
        const last = ps.rounds[ps.rounds.length - 1]
        if (last) last.verdict = { winner, notes: String(v.notes ?? ''), criticSubagentId: typeof args.criticSubagentId === 'string' ? args.criticSubagentId : '' }
        if (winner === 'bar') {
          state.round += 1
          return jv({
            ok: true,
            phase: state.phase,
            message: `O crítico (sub-agent ${last?.verdict?.criticSubagentId ?? '?'}) escolheu a BARRA no round ${state.round - 1}. O trabalho ainda não venceu. REBUILD com um NOVO builder sub-agent: action="build" pieceIndex=${idx}. O loop SÓ TERMINA quando o crítico escolher "ours".`,
            state: snapshotNow(),
            next: 'build',
            verdict: last?.verdict ?? null,
            round: state.round,
          })
        }
        ps.status = 'won'
        if (state.currentPiece + 1 < state.piecesState.length) {
          state.currentPiece += 1
          state.round = 1
          const nextPiece = state.piecesState[state.currentPiece]
          return jv({
            ok: true,
            phase: state.phase,
            message: `Peça ${idx + 1} VENCEU a comparação cega! Avance. Construa a peça ${state.currentPiece + 1} com um builder sub-agent: action="build" pieceIndex=${state.currentPiece}.`,
            state: snapshotNow(),
            next: 'build',
            currentPiece: nextPiece,
          })
        }
        state.phase = 'done'
        state.finishedAt = Date.now()
        return jv({
          ok: true,
          phase: state.phase,
          message: 'TODAS as peças venceram a comparação cega contra a barra. Gauntlet Loop concluído! Chame action="complete" com summary={outcome, lessons}.',
          state: snapshotNow(),
          next: 'complete',
        })
      }

      // ---- COMPLETE ----
      if (action === 'complete') {
        if (state.phase !== 'done') return jv({ ok: false, phase: state.phase, error: 'complete só é válido após todas as peças vencerem.', state: snapshotNow() })
        const s = args.summary && typeof args.summary === 'object' ? args.summary as Record<string, unknown> : {}
        state.summary = { outcome: String(s.outcome ?? ''), lessons: String(s.lessons ?? '') }
        return jv({ ok: true, phase: state.phase, message: `Gauntlet Loop finalizado. ${state.summary.outcome}`, state: snapshotNow(), next: null })
      }

      return jv({ ok: false, phase: state.phase, error: `Ação desconhecida: ${action}`, state: snapshotNow() })
    },
  })

  ctx.tools.register(tool)
}
