/**
 * Client-side model tests: the defensive wire parser (fail-closed) and the
 * pure UI helpers.  No fold — the projection arrives as a finished DTO from
 * the Host session-projection unit.
 */
import { describe, expect, it } from 'vitest'
import {
  parseProjectionWire, isOpenablePath, actionOf, resultText, firstLine, boundedText,
  type GauntletProjectionDTO,
} from '../../src/client/model.ts'

// ---- defensive parser ----

describe('parseProjectionWire', () => {
  const valid: GauntletProjectionDTO = {
    version: 1,
    available: true,
    phase: 'loop',
    status: 'running',
    barName: 'Stripe Checkout',
    next: 'build',
    nextPieceIndex: 0,
    units: [{ id: 'p1', title: 'Shell', status: 'pending', rounds: [] }],
    won: 0,
    total: 1,
    totalRounds: 0,
    blocked: null,
    summary: null,
    haltedReason: null,
  }

  it('accepts a well-formed wire value', () => {
    expect(parseProjectionWire(valid)).toEqual(valid)
  })

  it('rejects null / undefined / non-object', () => {
    expect(parseProjectionWire(null)).toBeNull()
    expect(parseProjectionWire(undefined)).toBeNull()
    expect(parseProjectionWire('x')).toBeNull()
    expect(parseProjectionWire(42)).toBeNull()
  })

  it('rejects incompatible version', () => {
    expect(parseProjectionWire({ ...valid, version: 99 })).toBeNull()
  })

  it('rejects unavailable projection (fallback trigger)', () => {
    expect(parseProjectionWire({ ...valid, available: false })).toBeNull()
  })

  it('rejects unknown status', () => {
    expect(parseProjectionWire({ ...valid, status: 'weird' })).toBeNull()
  })
})

// ---- artifact path heuristic ----

describe('isOpenablePath (conservative)', () => {
  it('opens plausible filesystem paths', () => {
    expect(isOpenablePath('src/checkout.ts')).toBe(true)
    expect(isOpenablePath('./build/out.js')).toBe(true)
    expect(isOpenablePath('/abs/path/file.md')).toBe(true)
    expect(isOpenablePath('checkout.ts')).toBe(true) // extension
  })

  it('does NOT open URLs', () => {
    expect(isOpenablePath('https://stripe.com/payments/checkout')).toBe(false)
    expect(isOpenablePath('http://localhost:3000/ref')).toBe(false)
    expect(isOpenablePath('file:///etc/passwd')).toBe(false)
  })

  it('does NOT open opaque ids without path evidence', () => {
    expect(isOpenablePath('artifact-final')).toBe(false)
    expect(isOpenablePath('build-42')).toBe(false)
    expect(isOpenablePath('call-1234')).toBe(false)
    expect(isOpenablePath('')).toBe(false)
  })
})

// ---- arg / text helpers ----

describe('actionOf', () => {
  it('parses the action from wire args', () => {
    expect(actionOf('{"action":"split","pieces":[]}')).toBe('split')
    expect(actionOf(null)).toBe('')
    expect(actionOf('not json')).toBe('')
  })
})

describe('resultText', () => {
  it('flattens text blocks', () => {
    expect(resultText([{ type: 'text', text: 'a\nb' }])).toBe('a\nb')
  })
  it('falls back to error line', () => {
    expect(resultText([], { name: 'E', code: 'c' })).toBe('E: c')
  })
  it('returns null for empty content without error', () => {
    expect(resultText([])).toBeNull()
  })
})

describe('firstLine / boundedText', () => {
  it('firstLine trims to the first line', () => {
    expect(firstLine('a\nb')).toBe('a')
  })
  it('boundedText preserves content within limit and truncates beyond', () => {
    const short = 'abc'
    const long = 'x'.repeat(100)
    expect(boundedText(short, 50)).toBe(short)
    const capped = boundedText(long, 10)
    expect(capped.length).toBe(11) // 10 + ellipsis
    expect(capped.endsWith('…')).toBe(true)
  })
})
