/**
 * GauntletRow component tests.
 *
 * The workbench is a projection of the Host session-projection unit, read via
 * useProjection('gauntlet') — the tests stub that hook with a DTO (or
 * undefined for capability absence) and verify the UI renders the DTO, the
 * fallback triggers safely, artifact paths open conservatively, and keyboard /
 * aria contracts hold.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { GauntletRow } from '../../src/client/GauntletRow.tsx'
import { en } from '../../src/client/locale.ts'
import type { GauntletProjectionDTO } from '../../src/projection-types.ts'

type GauntletRowProps = Parameters<typeof GauntletRow>[0]

/** Simple translate stub matching the en locale. */
function t(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key]
  if (template === undefined) return key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}
const tFn: GauntletRowProps['t'] = t as any

afterEach(cleanup)

// ---- DTO factory ----

const BAR = { name: 'Stripe Checkout', fetchHow: 'Open https://stripe.com', compareHow: 'blind A/B compare' }

function dto(overrides: Partial<GauntletProjectionDTO> = {}): GauntletProjectionDTO {
  return {
    version: 1,
    available: true,
    phase: 'loop',
    status: 'running',
    barName: BAR.name,
    next: 'build',
    nextPieceIndex: 0,
    units: [
      {
        id: 'p1',
        title: 'Checkout shell',
        status: 'won',
        rounds: [{
          round: 1,
          builder: 'builder-1',
          artifactLocation: 'src/checkout.ts',
          artifactSummary: 'Shell.',
          builderEvidence: 'tests pass',
          critic: 'critic-1',
          winner: 'ours',
          criticNotes: 'wins',
          criticEvidence: 'blind A/B',
        }],
      },
    ],
    won: 1,
    total: 1,
    totalRounds: 1,
    blocked: null,
    summary: null,
    haltedReason: null,
    asOfSeq: 1,
    asOfCallId: 'call-gl',
    ...overrides,
  }
}

/** A settled gauntlet block (used for header action / fallback content). */
function settledBlock(): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 1000,
    callId: 'call-gl',
    call: { name: 'gauntlet_loop', argsRaw: '{"action":"submit"}' },
    callTime: 900,
    content: [{ type: 'text', text: 'dashboard text' }],
    isError: false,
    meta: { protocol: 1, schema: 2, ok: true, fingerprint: 'fp', presentation: { version: 1, phase: 'loop', next: 'build' } },
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

/** Render with a stubbed useProjection. */
function renderWithProjection(value: GauntletProjectionDTO | undefined, block = settledBlock(), opts: { openFile?: (p: string) => void } = {}) {
  const useProjection = ((key: string) => value) as unknown as GauntletRowProps['useProjection']
  const propsObj: GauntletRowProps = {
    callId: block.callId,
    toolName: 'gauntlet_loop',
    block,
    useProjection,
    openFile: opts.openFile ?? vi.fn(),
    inspect: vi.fn(),
    t: tFn,
  } as unknown as GauntletRowProps
  return render(<GauntletRow {...propsObj} />)
}

// ---- Tests ----

describe('GauntletRow', () => {
  it('renders header with phase, status, bar, NEXT, and progress', () => {
    const view = renderWithProjection(dto())
    const text = view.container.textContent!
    expect(text).toContain('Gauntlet')
    expect(text).toContain('loop')
    expect(text).toContain('Stripe Checkout')
    expect(text).toContain('Next')
    expect(text).toContain('1/1')
  })

  it('collapsed by default; expands and collapses on click', () => {
    const view = renderWithProjection(dto())
    const row = view.container.querySelector('[data-expandable]')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('displays units with their statuses when expanded', () => {
    const view = renderWithProjection(dto())
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('p1')
    expect(text).toContain('Checkout shell')
    expect(text).toContain('Won')
  })

  it('unit expansion reveals round history with builder/critic identities', () => {
    const view = renderWithProjection(dto())
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const unit = view.container.querySelector('[data-status="won"]')!
    fireEvent.click(unit)
    const text = view.container.textContent!
    expect(text).toContain('builder-1')
    expect(text).toContain('critic-1')
    expect(text).toContain('src/checkout.ts')
    expect(text).toContain('tests pass')
    expect(text).toContain('Ours')
  })

  it('blocked panel renders when DTO carries blocked state', () => {
    const view = renderWithProjection(dto({
      status: 'blocked',
      blocked: { error: 'Invalid command', rejections: ['Empty command'], phase: 'refine', next: 'refine' },
    }))
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('BLOCKED')
    expect(text).toContain('Invalid command')
    expect(text).toContain('Empty command')
  })

  it('terminal state shows complete with summary', () => {
    const view = renderWithProjection(dto({
      status: 'complete',
      phase: 'done',
      next: null,
      summary: { outcome: 'Won', lessons: 'Learn' },
    }))
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('Complete')
    expect(text).toContain('Won')
    expect(text).toContain('Learn')
  })

  it('terminal state shows halted with reason', () => {
    const view = renderWithProjection(dto({
      status: 'halted',
      phase: 'halted',
      next: null,
      haltedReason: 'Scope changed',
    }))
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('Halted')
    expect(text).toContain('Scope changed')
  })

  it('keyboard interaction: Enter and Space toggle expansion', () => {
    const view = renderWithProjection(dto())
    const row = view.container.querySelector('[data-expandable]')!
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('capability absent (useProjection undefined) -> safe generic fallback with textual content', () => {
    const view = renderWithProjection(undefined, settledBlock())
    const text = view.container.textContent!
    expect(text).toContain('unavailable')
    expect(text).toContain('dashboard text')
  })

  it('unavailable DTO -> safe fallback (never a fabricated workbench)', () => {
    const view = renderWithProjection(dto({ available: false, unavailableReason: 'stale log' }))
    const text = view.container.textContent!
    expect(text).toContain('unavailable')
    // Fail-closed: the parser drops unavailable DTOs, so the fallback shows
    // the raw args + textual output, never a fabricated workbench.
    expect(text).not.toContain('1/1')
    expect(text).toContain('dashboard text')
  })

  it('running state (in-flight block) shows compact header', () => {
    const block: RunningToolCall = {
      callId: 'call-running',
      name: 'gauntlet_loop',
      argsRaw: '{"action":"submit"}',
      turn: 1,
      step: 1,
      time: 1000,
      callView: null,
      subCalls: [],
    }
    const view = renderWithProjection(dto({ units: [], total: 0 }), block)
    expect(view.container.textContent).toContain('Gauntlet')
    expect(view.container.querySelector('[data-expandable]')).toBeNull()
  })

  it('aria labels and data attributes are present for accessibility', () => {
    const view = renderWithProjection(dto())
    const card = view.container.querySelector('[data-tool="gauntlet_loop"]')!
    expect(card.getAttribute('data-tool')).toBe('gauntlet_loop')
    expect(card.getAttribute('data-status')).toBe('running')
    const row = view.container.querySelector('[data-expandable]')!
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('aria-label')).toBe('Expand gauntlet')
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })


  it('historical card does NOT drift: call A keeps its own state after projection advances to call B', () => {
    // Call A block (seq 1, callId call-gl) settled as submit -> refine
    const blockA: ToolResultNode = {
      kind: 'tool-result',
      seq: 1,
      time: 1000,
      callId: 'call-gl',
      call: { name: 'gauntlet_loop', argsRaw: '{"action":"submit"}' },
      callTime: 900,
      content: [{ type: 'text', text: 'Comando recebido. Refine o objetivo.' }],
      isError: false,
      meta: {
        protocol: 1, schema: 2, ok: true, fingerprint: 'fp',
        presentation: { version: 1, phase: 'refine', next: 'refine' },
      },
      callView: null,
      resultView: null,
      subCalls: [],
    }
    // Projection A: cut at call A (submit, refine)
    const projectionA = dto({ phase: 'refine', next: 'refine', status: 'running', units: [], won: 0, total: 0, asOfSeq: 1, asOfCallId: 'call-gl' })
    const viewA = renderWithProjection(projectionA, blockA)
    expect(viewA.container.textContent).toContain('refine')

    // Projection advances to call B (complete)
    const projectionB = dto({ phase: 'done', status: 'complete', summary: { outcome: 'Done', lessons: 'L' }, asOfSeq: 9, asOfCallId: 'call-B' })
    const viewB = renderWithProjection(projectionB, blockA)
    // Call A must NOT show call B's terminal state
    expect(viewB.container.textContent).not.toContain('Complete')
    expect(viewB.container.textContent).not.toContain('Done')
    // It still shows A's own phase (from the frozen block meta)
    expect(viewB.container.textContent).toContain('refine')
  })

  it('full workbench renders only on the cut card (asOfCallId match)', () => {
    // Settled block with a DIFFERENT callId than the projection cut -> historical row
    const block: ToolResultNode = {
      kind: 'tool-result',
      seq: 2,
      time: 2000,
      callId: 'call-other',
      call: { name: 'gauntlet_loop', argsRaw: '{"action":"refine"}' },
      callTime: 1900,
      content: [{ type: 'text', text: 'old text' }],
      isError: false,
      meta: { protocol: 1, schema: 2, ok: true, fingerprint: 'fp', presentation: { version: 1, phase: 'split', next: 'split' } },
      callView: null,
      resultView: null,
      subCalls: [],
    }
    // Projection cut is at call-gl
    const view = renderWithProjection(dto(), block)
    // Not the cut card -> shows the historical row, not the full workbench
    expect(view.container.textContent).not.toContain('1/1')
    expect(view.container.textContent).toContain('split')
    // Expand the historical row to see its own textual output
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.textContent).toContain('old text')
    expect(view.container.textContent).not.toContain('1/1')
  })

  it('artifact path click calls openFile only for filesystem-like paths', () => {
    const openFile = vi.fn()
    const view = renderWithProjection(dto(), settledBlock(), { openFile })
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const unit = view.container.querySelector('[data-status="won"]')!
    fireEvent.click(unit)
    const link = view.container.querySelector('[role="button"][title="src/checkout.ts"]')!
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledWith('src/checkout.ts')
  })

  it('does not open opaque artifact ids (conservative heuristic)', () => {
    const openFile = vi.fn()
    const view = renderWithProjection(dto({
      units: [{
        id: 'p1',
        title: 'Shell',
        status: 'won',
        rounds: [{
          round: 1,
          builder: 'b1',
          artifactLocation: 'artifact-final',
          artifactSummary: 'opaque id',
          builderEvidence: '',
          critic: 'c1',
          winner: 'ours',
          criticNotes: 'wins',
          criticEvidence: 'e',
        }],
      }],
    }), settledBlock(), { openFile })
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const unit = view.container.querySelector('[data-status="won"]')!
    fireEvent.click(unit)
    const link = view.container.querySelector('[role="button"][title="artifact-final"]')
    expect(link).toBeNull()
    expect(view.container.textContent).toContain('artifact-final')
    expect(openFile).not.toHaveBeenCalled()
  })
})