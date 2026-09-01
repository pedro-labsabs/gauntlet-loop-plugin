/**
 * GauntletRow component tests.
 *
 * Each gauntlet_loop call renders its own card; a card shows the accumulated
 * workbench state AS OF that call (projection over settled calls with
 * `seq` ≤ the block's `seq`).  The newest call therefore shows the full
 * accumulated workbench; an earlier call shows the state at that point.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationNode, RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { GauntletRow } from '../../src/client/GauntletRow.tsx'
import { en } from '../../src/client/locale.ts'

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

// ---- Test factories ----

const BAR = { name: 'Stripe Checkout', fetchHow: 'Open https://stripe.com', compareHow: 'blind A/B compare' }
const PIECES = [{ id: 'p1', title: 'Checkout shell', description: 'Shell.' }]

function presentationMeta(ok: boolean, phase: string, next: string | null, extraPres?: Record<string, unknown>) {
  const pres: Record<string, unknown> = { version: 1, phase, next: next ?? null }
  if (extraPres) Object.assign(pres, extraPres)
  return { protocol: 1, schema: 2, ok, fingerprint: 'fp', presentation: pres }
}

function settled(overrides: Partial<ToolResultNode> & { name: string; action: string; phase: string; next: string | null }): ToolResultNode {
  const args = JSON.stringify({ action: overrides.action, ...((overrides as any).extra ?? {}) })
  return {
    kind: 'tool-result',
    seq: overrides.seq ?? 1,
    time: 1000,
    callId: overrides.callId ?? `call-${overrides.seq ?? 1}`,
    call: { name: overrides.name, argsRaw: args },
    callTime: 900,
    content: overrides.content ?? [{ type: 'text', text: 'ok' }],
    isError: overrides.isError ?? false,
    error: overrides.error,
    meta: presentationMeta(overrides.ok ?? true, overrides.phase, overrides.next, (overrides as any).extraPres),
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

function running(overrides: Partial<RunningToolCall> & { action: string }): RunningToolCall {
  return {
    callId: 'call-running',
    name: 'gauntlet_loop',
    argsRaw: JSON.stringify({ action: overrides.action }),
    turn: 1,
    step: 1,
    time: 1000,
    callView: null,
    subCalls: [],
  }
}

/** Build a fake `useSession` that returns a snapshot with the given nodes. */
function stubUseSession(nodes: readonly ConversationNode[], runningCalls: readonly RunningToolCall[] = []): GauntletRowProps['useSession'] {
  return ((selector: (snap: any) => any) => selector({
    sessionId: 's1',
    chat: {
      legacy: { nodes, runningCalls },
      nodes: { values: () => nodes.map(n => ({ key: `tool:${(n as any).callId}`, kind: 'tool-call', data: { root: n }, id: (n as any).callId })) as any },
      order: [],
      locations: { getTurn: () => [], getStep: () => [] },
      timeline: { turnOrder: [], turns: new Map() },
    },
    nodes,
    runningCalls,
    views: { get: () => undefined },
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  })) as any
}

/** Render the newest settled call's card against the full node list. */
function renderNewest(nodes: readonly ConversationNode[], runningCalls: readonly RunningToolCall[] = []) {
  const last = nodes[nodes.length - 1] as ToolResultNode
  const propsObj: GauntletRowProps = {
    callId: last.callId,
    toolName: 'gauntlet_loop',
    block: last,
    useSession: stubUseSession(nodes, runningCalls),
    openFile: vi.fn(),
    inspect: vi.fn(),
    t: tFn,
  } as unknown as GauntletRowProps
  return { view: render(<GauntletRow {...propsObj} />), last }
}

/** A settled happy-path: submit -> refine -> split -> build -> critique(ours). */
function happyPath(): ConversationNode[] {
  return [
    settled({ seq: 1, name: 'gauntlet_loop', action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
    settled({ seq: 2, name: 'gauntlet_loop', action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
    settled({ seq: 3, name: 'gauntlet_loop', action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
    settled({ seq: 4, name: 'gauntlet_loop', action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'builder-1', artifact: { location: 'src/checkout.ts', summary: 'Shell.' }, builderEvidence: 'tests pass' } }),
    settled({ seq: 5, name: 'gauntlet_loop', action: 'critique', phase: 'loop', next: 'complete', extra: { pieceIndex: 0, criticSubagentId: 'critic-1', verdict: { winner: 'ours', notes: 'wins', evidence: 'blind A/B', blind: true } } }),
  ]
}

// ---- Tests ----

describe('GauntletRow', () => {
  it('renders header with phase, status, bar, NEXT, and progress on the newest call', () => {
    const nodes = happyPath()
    const { view } = renderNewest(nodes)
    const text = view.container.textContent!
    expect(text).toContain('Gauntlet')
    expect(text).toContain('loop')
    expect(text).toContain('Stripe Checkout')
    expect(text).toContain('Next')
    expect(text).toContain('1/1')
  })

  it('shows the quality bar name after refine', () => {
    const nodes = [happyPath()[0], happyPath()[1]]
    const { view } = renderNewest(nodes)
    expect(view.container.textContent).toContain('Stripe Checkout')
  })

  it('an earlier call card shows the state as of that call, not the final state', () => {
    // Render the split call (seq 3) as the block; later calls exist in the
    // snapshot but must NOT leak into this card (live == replay).
    const nodes = happyPath()
    const block = nodes[2] as ToolResultNode
    const propsObj: GauntletRowProps = {
      callId: block.callId,
      toolName: 'gauntlet_loop',
      block,
      useSession: stubUseSession(nodes),
      openFile: vi.fn(),
      inspect: vi.fn(),
      t: tFn,
    } as unknown as GauntletRowProps
    const view = render(<GauntletRow {...propsObj} />)
    // The split card shows units but no won units (build/critique come later).
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('p1')
    expect(text).toContain('Checkout shell')
    expect(text).toContain('0/1')
    expect(text).not.toContain('builder-1')
  })

  it('collapsed by default; expands and collapses on click', () => {
    const nodes = happyPath()
    const { view } = renderNewest(nodes)
    const row = view.container.querySelector('[data-expandable]')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('displays units with their statuses when expanded', () => {
    const nodes = happyPath()
    const { view } = renderNewest(nodes)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('p1')
    expect(text).toContain('Checkout shell')
    expect(text).toContain('Won')
  })

  it('unit expansion reveals round history with builder/critic identities', () => {
    const nodes = happyPath()
    const { view } = renderNewest(nodes)
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

  it('blocked panel renders when the last call was rejected', () => {
    const nodes: ConversationNode[] = [
      settled({ seq: 1, name: 'gauntlet_loop', action: 'submit', ok: false, phase: 'idle', next: 'submit', extraPres: { error: 'Invalid command', rejections: ['Empty command'] } }),
    ]
    const { view } = renderNewest(nodes)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('BLOCKED')
    expect(text).toContain('Invalid command')
    expect(text).toContain('Empty command')
  })

  it('terminal state shows complete with summary', () => {
    const nodes: ConversationNode[] = [
      settled({ seq: 1, name: 'gauntlet_loop', action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      settled({ seq: 2, name: 'gauntlet_loop', action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      settled({ seq: 3, name: 'gauntlet_loop', action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      settled({ seq: 4, name: 'gauntlet_loop', action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'a', summary: 's' } } }),
      settled({ seq: 5, name: 'gauntlet_loop', action: 'critique', phase: 'report', next: 'complete', extra: { pieceIndex: 0, criticSubagentId: 'c1', verdict: { winner: 'ours', notes: 'n', evidence: 'e', blind: true } } }),
      settled({ seq: 6, name: 'gauntlet_loop', action: 'complete', phase: 'done', next: null, extra: { summary: { outcome: 'Won', lessons: 'Learn' } } }),
    ]
    const { view } = renderNewest(nodes)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('Complete')
    expect(text).toContain('Won')
    expect(text).toContain('Learn')
  })

  it('terminal state shows halted with reason', () => {
    const nodes: ConversationNode[] = [
      settled({ seq: 1, name: 'gauntlet_loop', action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      settled({ seq: 2, name: 'gauntlet_loop', action: 'halt', phase: 'halted', next: null, extra: { reason: 'Scope changed' } }),
    ]
    const { view } = renderNewest(nodes)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const text = view.container.textContent!
    expect(text).toContain('Halted')
    expect(text).toContain('Scope changed')
  })

  it('keyboard interaction: Enter and Space toggle expansion', () => {
    const nodes = happyPath()
    const { view } = renderNewest(nodes)
    const row = view.container.querySelector('[data-expandable]')!
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('malformed/old events produce the generic fallback, not a crash', () => {
    const block: ToolResultNode = {
      kind: 'tool-result',
      seq: 1,
      time: 1000,
      callId: 'call-gl',
      call: { name: 'gauntlet_loop', argsRaw: '{"action":"submit"}' },
      callTime: 900,
      content: [{ type: 'text', text: 'dashboard text' }],
      isError: false,
      meta: { protocol: 1, schema: 2, ok: true, fingerprint: 'fp' }, // no presentation
      callView: null,
      resultView: null,
      subCalls: [],
    }
    const propsObj: GauntletRowProps = {
      callId: 'call-gl',
      toolName: 'gauntlet_loop',
      block,
      useSession: stubUseSession([block]),
      openFile: vi.fn(),
      inspect: vi.fn(),
      t: tFn,
    } as unknown as GauntletRowProps
    const view = render(<GauntletRow {...propsObj} />)
    expect(view.container.textContent).toContain('unavailable')
    expect(view.container.textContent).toContain('dashboard text')
  })

  it('running state shows compact header without expandable details', () => {
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
    const propsObj: GauntletRowProps = {
      callId: 'call-running',
      toolName: 'gauntlet_loop',
      block,
      useSession: stubUseSession([]),
      openFile: vi.fn(),
      inspect: vi.fn(),
      t: tFn,
    } as unknown as GauntletRowProps
    const view = render(<GauntletRow {...propsObj} />)
    expect(view.container.textContent).toContain('Gauntlet')
    expect(view.container.querySelector('[data-expandable]')).toBeNull()
  })

  it('aria labels and data attributes are present for accessibility', () => {
    const nodes = happyPath()
    const { view } = renderNewest(nodes)
    const card = view.container.querySelector('[data-tool="gauntlet_loop"]')!
    expect(card.getAttribute('data-tool')).toBe('gauntlet_loop')
    expect(card.getAttribute('data-status')).toBe('running')
    const row = view.container.querySelector('[data-expandable]')!
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('aria-label')).toBe('Expand gauntlet')
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('artifact path click calls openFile only for filesystem-like paths', () => {
    const nodes: ConversationNode[] = [
      settled({ seq: 1, name: 'gauntlet_loop', action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      settled({ seq: 2, name: 'gauntlet_loop', action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      settled({ seq: 3, name: 'gauntlet_loop', action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      settled({ seq: 4, name: 'gauntlet_loop', action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'src/checkout.ts', summary: 'Shell.' } } }),
    ]
    const last = nodes[nodes.length - 1] as ToolResultNode
    const openFile = vi.fn()
    const propsObj: GauntletRowProps = {
      callId: last.callId,
      toolName: 'gauntlet_loop',
      block: last,
      useSession: stubUseSession(nodes),
      openFile,
      inspect: vi.fn(),
      t: tFn,
    } as unknown as GauntletRowProps
    const view = render(<GauntletRow {...propsObj} />)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const unit = view.container.querySelector('[data-status="awaiting_critique"]')!
    fireEvent.click(unit)
    const link = view.container.querySelector('[role="button"][title="src/checkout.ts"]')!
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledWith('src/checkout.ts')
  })

  it('does not open URL-like artifact locations', () => {
    const nodes: ConversationNode[] = [
      settled({ seq: 1, name: 'gauntlet_loop', action: 'submit', phase: 'refine', next: 'refine', extra: { command: 'Go' } }),
      settled({ seq: 2, name: 'gauntlet_loop', action: 'refine', phase: 'split', next: 'split', extra: { refinedCommand: 'Objective.', bar: BAR } }),
      settled({ seq: 3, name: 'gauntlet_loop', action: 'split', phase: 'loop', next: 'build', nextPieceIndex: 0, extra: { pieces: PIECES } }),
      settled({ seq: 4, name: 'gauntlet_loop', action: 'build', phase: 'loop', next: 'critique', nextPieceIndex: 0, extra: { pieceIndex: 0, builderSubagentId: 'b1', artifact: { location: 'https://example.com/ref', summary: 'Remote reference.' } } }),
    ]
    const last = nodes[nodes.length - 1] as ToolResultNode
    const openFile = vi.fn()
    const propsObj: GauntletRowProps = {
      callId: last.callId,
      toolName: 'gauntlet_loop',
      block: last,
      useSession: stubUseSession(nodes),
      openFile,
      inspect: vi.fn(),
      t: tFn,
    } as unknown as GauntletRowProps
    const view = render(<GauntletRow {...propsObj} />)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    const unit = view.container.querySelector('[data-status="awaiting_critique"]')!
    fireEvent.click(unit)
    // URL is not a button; the location renders as plain text.
    const link = view.container.querySelector('[role="button"][title="https://example.com/ref"]')
    expect(link).toBeNull()
    expect(view.container.textContent).toContain('https://example.com/ref')
    expect(openFile).not.toHaveBeenCalled()
  })
})
