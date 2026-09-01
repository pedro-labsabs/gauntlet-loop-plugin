/**
 * Pure projection-model tests (no React).  The model is deterministic: the
 * same call slices always produce the same workbench view, and live events
 * (incremental) produce the same projection as the same events replayed from
 * scratch.  These tests are the "live == replay" proof at the model layer.
 */
import { describe, expect, it } from 'vitest'
import {
  GAUNTLET_PRESENTATION_VERSION,
  projectGauntlet,
  parsePresentationMeta,
  parseGauntletArgs,
  type GauntletCallSlice,
} from '../../src/client/model.ts'

// ---- helpers ----

const BAR = { name: 'Stripe Checkout demo', fetchHow: 'Open https://stripe.com/payments/checkout', compareHow: 'blind A/B compare' }
const PIECES = [
  { id: 'p1', title: 'Checkout shell', description: 'Independent shell.' },
  { id: 'p2', title: 'Payment form', description: 'Independent form.' },
  { id: 'p3', title: 'Confirmation', description: 'Independent confirmation.' },
]

interface SliceArgs {
  seq: number
  action: string
  ok?: boolean
  phase?: string
  next?: string | null  // null means explicitly null
  nextPieceIndex?: number
  error?: string
  rejections?: string[]
  extra?: Record<string, unknown>
  isError?: boolean
}

/** Build a settled call slice from a high-level description. */
function slice(a: SliceArgs): GauntletCallSlice {
  const args: Record<string, unknown> = { action: a.action, ...(a.extra ?? {}) }
  const pres: Record<string, unknown> = {
    version: GAUNTLET_PRESENTATION_VERSION,
    phase: a.phase ?? 'loop',
  }
  // Explicitly handle null vs undefined for next
  if (a.next !== undefined) pres.next = a.next
  else pres.next = 'build'
  if (a.nextPieceIndex !== undefined) pres.nextPieceIndex = a.nextPieceIndex
  if (a.error !== undefined) pres.error = a.error
  if (a.rejections !== undefined) pres.rejections = a.rejections
  return {
    seq: a.seq,
    argsRaw: JSON.stringify(args),
    meta: { protocol: 1, schema: 2, ok: a.ok ?? true, fingerprint: 'fp', presentation: pres },
    isError: a.isError ?? false,
  }
}

/** The canonical happy-path sequence: submit -> refine -> split -> builds -> critiques. */
function happySlices(): GauntletCallSlice[] {
  return [
    slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Build checkout.' } }),
    slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Build checkout with p95 < 100ms.', bar: BAR } }),
    slice({ seq: 3, action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
    slice({ seq: 4, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/checkout.ts', summary: 'Shell.' }, builderEvidence: 'tests pass' } }),
    slice({ seq: 5, action: 'critique', phase: 'loop', next: 'build', nextPieceIndex: 1, extra: { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'bar', notes: 'reference wins', evidence: 'A/B capture', blind: true } } }),
    slice({ seq: 6, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b2', artifact: { location: 'src/checkout.ts', summary: 'Fixed.' } } }),
    slice({ seq: 7, action: 'critique', phase: 'loop', next: 'build', nextPieceIndex: 1, extra: { pieceIndex: 0, criticSubagentId: 'c2', verdict: { winner: 'ours', notes: 'ours wins', evidence: 'blind A/B chose ours', blind: true } } }),
  ]
}

// ---- 1-13: state machine projection ----

describe('projectGauntlet', () => {
  it('1. idle (no calls) has no bar/units and a submit next action', () => {
    const view = projectGauntlet([])
    expect(view.available).toBe(true)
    expect(view.phase).toBe('idle')
    expect(view.status).toBe('running')
    expect(view.barName).toBeNull()
    expect(view.units).toHaveLength(0)
    expect(view.next).toBe('submit')
  })

  it('2. submit accepted starts the run (phase refine)', () => {
    const view = projectGauntlet([slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } })])
    expect(view.available).toBe(true)
    expect(view.phase).toBe('refine')
    expect(view.status).toBe('running')
    expect(view.next).toBe('refine')
    expect(view.barName).toBeNull()
  })

  it('3. refine accepted exposes the named quality bar', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
    ])
    expect(view.available).toBe(true)
    expect(view.phase).toBe('split')
    expect(view.barName).toBe('Stripe Checkout demo')
  })

  it('4. split accepted adds units; build moves a unit to awaiting critique', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      slice({ seq: 3, action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      slice({ seq: 4, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/checkout.ts', summary: 'Shell.' } } }),
    ])
    expect(view.units).toHaveLength(3)
    expect(view.units[0].status).toBe('awaiting_critique')
    expect(view.units[0].rounds).toHaveLength(1)
    expect(view.units[0].rounds[0].builder).toBe('b1')
    expect(view.units[0].rounds[0].artifactLocation).toBe('src/checkout.ts')
    expect(view.won).toBe(0)
    expect(view.total).toBe(3)
  })

  it('5. critique OURS -> unit won', () => {
    const view = projectGauntlet(happySlices())
    expect(view.available).toBe(true)
    expect(view.units[0].status).toBe('won')
    expect(view.units[0].rounds[1].critic).toBe('c2')
    expect(view.units[0].rounds[1].winner).toBe('ours')
    expect(view.won).toBe(1)
    expect(view.totalRounds).toBe(2)
  })

  it('6. critique BAR -> unit rebuild', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      slice({ seq: 3, action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      slice({ seq: 4, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 's' } } }),
      slice({ seq: 5, action: 'critique', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'bar', notes: 'n', evidence: 'e', blind: true } } }),
    ])
    expect(view.units[0].status).toBe('rebuild')
    expect(view.next).toBe('build')
    expect(view.nextPieceIndex).toBe(0)
  })

  it('7. multiple rounds of the same unit accumulate round history', () => {
    const view = projectGauntlet(happySlices())
    const unit = view.units[0]
    expect(unit.rounds).toHaveLength(2)
    expect(unit.rounds.map(r => r.round)).toEqual([1, 2])
    expect(unit.rounds[0].builder).toBe('b1')
    expect(unit.rounds[0].critic).toBe('c1')
    expect(unit.rounds[0].winner).toBe('bar')
    expect(unit.rounds[1].builder).toBe('b2')
    expect(unit.rounds[1].winner).toBe('ours')
  })

  it('8. multiple units track independent statuses', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      slice({ seq: 3, action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      slice({ seq: 4, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 's' } } }),
      slice({ seq: 5, action: 'critique', phase: 'loop', next: 'build', nextPieceIndex: 1, extra: { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: 'n', evidence: 'e', blind: true } } }),
      slice({ seq: 6, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 1, extra: { pieceIndex: 1, builderSubagentId: 'b2', artifact: { location: 'b', summary: 's' } } }),
    ])
    expect(view.units[0].status).toBe('won')
    expect(view.units[1].status).toBe('awaiting_critique')
    expect(view.units[2].status).toBe('pending')
    expect(view.won).toBe(1)
    expect(view.total).toBe(3)
  })

  it('9. complete -> terminal done with summary', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      slice({ seq: 3, action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      slice({ seq: 4, action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 's' } } }),
      slice({ seq: 5, action: 'critique', phase: 'loop', next: 'complete', extra: { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: 'n', evidence: 'e', blind: true } } }),
      slice({ seq: 6, action: 'complete', phase: 'done', next: null, extra: { summary: { outcome: 'Won the bar.', lessons: 'Hierarchy mattered.' } } }),
    ])
    expect(view.status).toBe('complete')
    expect(view.phase).toBe('done')
    expect(view.next).toBeNull()
    expect(view.summary).toEqual({ outcome: 'Won the bar.', lessons: 'Hierarchy mattered.' })
  })

  it('10. halt -> terminal halted with reason', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'halt', phase: 'halted', next: null, extra: { reason: 'Scope changed.' } }),
    ])
    expect(view.status).toBe('halted')
    expect(view.phase).toBe('halted')
    expect(view.haltedReason).toBe('Scope changed.')
    expect(view.next).toBeNull()
  })

  it('11. rejected call -> blocked state, presented state unchanged, NEXT intact', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', ok: false, phase: 'refine', next: 'refine', error: 'gate failed', rejections: ['Termos subjetivos sem definição objetiva: modern.'], extra: { refinedCommand: 'Modern.', bar: BAR } }),
    ])
    expect(view.available).toBe(true)
    expect(view.status).toBe('blocked')
    expect(view.phase).toBe('refine')
    expect(view.next).toBe('refine')
    expect(view.barName).toBeNull()
    expect(view.blocked).toEqual({
      error: 'gate failed',
      rejections: ['Termos subjetivos sem definição objetiva: modern.'],
      phase: 'refine',
      next: 'refine',
    })
  })

  it('12. multiple rejection messages surface as structured rejections', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', ok: false, phase: 'refine', next: 'refine', rejections: ['a', 'b', 'c'], extra: { refinedCommand: 'Modern.' } }),
    ])
    expect(view.blocked?.rejections).toEqual(['a', 'b', 'c'])
  })

  it('13. reset clears the accumulated projection', () => {
    const view = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      slice({ seq: 2, action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      slice({ seq: 3, action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      slice({ seq: 4, action: 'reset', phase: 'idle', next: 'submit' }),
    ])
    expect(view.available).toBe(true)
    expect(view.phase).toBe('idle')
    expect(view.units).toHaveLength(0)
    expect(view.barName).toBeNull()
    expect(view.next).toBe('submit')
  })
})

// ---- 14-17: fail-closed ----

describe('fail-closed', () => {
  it('14. malformed args -> unavailable', () => {
    const view = projectGauntlet([{ seq: 1, argsRaw: '{not json', meta: { ok: true, presentation: { version: 1, phase: 'loop', next: null } }, isError: false }])
    expect(view.available).toBe(false)
    expect(view.unavailableReason).toBeDefined()
  })

  it('15. missing presentation meta -> unavailable', () => {
    const view = projectGauntlet([{ seq: 1, argsRaw: '{"action":"submit"}', meta: { ok: true }, isError: false }])
    expect(view.available).toBe(false)
  })

  it('16. incompatible presentation version -> unavailable', () => {
    const view = projectGauntlet([{ seq: 1, argsRaw: '{"action":"submit"}', meta: { ok: true, presentation: { version: 99, phase: 'loop', next: null } }, isError: false }])
    expect(view.available).toBe(false)
  })

  it('17. interrupted/error result -> unavailable (cannot be trusted)', () => {
    const view = projectGauntlet([{ seq: 1, argsRaw: '{"action":"submit"}', meta: { ok: true, presentation: { version: 1, phase: 'refine', next: 'refine' } }, isError: true, error: { name: 'Interrupted', code: 'interrupted' } }])
    expect(view.available).toBe(false)
  })
})

// ---- 18: live incremental == replay from scratch ----

describe('live == replay', () => {
  it('18. incremental folding of arriving events equals full replay from scratch', () => {
    const all = happySlices()
    // "Live": fold incrementally as each event arrives
    const incrementalResults: ReturnType<typeof projectGauntlet>[] = []
    const accumulated: GauntletCallSlice[] = []
    for (const call of all) {
      accumulated.push(call)
      incrementalResults.push(projectGauntlet([...accumulated]))
    }
    // "Replay": fold the complete durable set at once
    const replayed = projectGauntlet(all)
    // The final incremental projection equals the replayed full projection
    expect(incrementalResults[incrementalResults.length - 1]).toEqual(replayed)
    // The projection at step 5 (first 5 events) equals folding events 1..5
    expect(incrementalResults[4]).toEqual(projectGauntlet(all.slice(0, 5)))
    // Every step's projection is prefix-stable: folding [1..N] then adding
    // N+1 produces a superset that doesn't change the prior projection's
    // phase/units/bar for the first N elements.
    for (let i = 1; i < incrementalResults.length; i++) {
      const prev = incrementalResults[i - 1]
      const curr = incrementalResults[i]
      // The bar and units from earlier steps persist (monotonic addition)
      if (prev.barName !== null) {
        expect(curr.barName).toBe(prev.barName)
      }
      // Units from earlier steps are still present (may have more)
      if (prev.units.length > 0 && curr.units.length > 0) {
        expect(curr.units[0].id).toBe(prev.units[0].id)
      }
    }
  })
})

// ---- 19: session isolation ----

describe('session isolation', () => {
  it('19. projections for independent call sequences never share state', () => {
    const sessionA = projectGauntlet(happySlices())
    const sessionB = projectGauntlet([
      slice({ seq: 1, action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Other' } }),
      slice({ seq: 2, action: 'halt', phase: 'halted', next: null, extra: { reason: 'nope' } }),
    ])
    // B must not see A's bar/units, and vice versa.
    expect(sessionB.units).toHaveLength(0)
    expect(sessionB.barName).toBeNull()
    expect(sessionA.status).not.toBe(sessionB.status)
    // A's model is unaffected by B's fold (pure function; no shared mutable state).
    const sessionAAgain = projectGauntlet(happySlices())
    expect(sessionAAgain).toEqual(sessionA)
  })
})

// ---- 20: no duplicated full canonical state in metadata ----

describe('wire contract', () => {
  it('20. the presentation envelope never carries the full canonical state', () => {
    // The wire meta only carries the bounded presentation fields.
    const meta = {
      protocol: 1,
      schema: 2,
      ok: true,
      fingerprint: 'fp',
      presentation: { version: 1, phase: 'loop', next: 'build', nextPieceIndex: 0 },
    }
    const pres = parsePresentationMeta(meta)
    expect(pres).not.toBeNull()
    expect(pres).toEqual({ version: 1, phase: 'loop', next: 'build', nextPieceIndex: 0 })
    // No units/rounds/state tree is serialized into the envelope.
    expect(JSON.stringify(pres)).not.toContain('piecesState')
    expect(JSON.stringify(pres)).not.toContain('rounds')
    expect(JSON.stringify(pres)).not.toContain('stateFingerprint')
  })

  it('parseGauntletArgs recovers original action fields from the wire args', () => {
    const args = parseGauntletArgs(JSON.stringify({ action: 'critique', pieceIndex: 2, criticSubagentId: 'c9', verdict: { winner: 'bar' } }))
    expect(args?.action).toBe('critique')
    expect(args?.pieceIndex).toBe(2)
  })
})
