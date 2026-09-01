/** Package-owned invariant companion for gauntlet-loop-plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { reconstructFromSessionEvents, validateReconstructedState } from './replay.js'

const PACKAGE_NAME = 'gauntlet-loop-plugin'

export const name = 'tool-gauntlet-invariant'
export const inject = ['invariants']

/**
 * Replay/cross-event invariant for the gauntlet loop.
 *
 * The installer subscribes to `session/event` globally (across all sessions)
 * and folds the gauntlet tool calls in the session log.  On each event, it
 * checks that the reconstructed state is valid, detecting cross-event
 * inconsistencies such as:
 *
 * - Piece marked `won` without a valid verdict.
 * - Critique without a preceding build.
 * - Reused builder/critic agent ids.
 * - Phase transitions that violate the core state machine.
 * - Schema/version incompatibility.
 *
 * This invariant runs both during live execution (event-driven) and on
 * session replay (the installer seeds itself by folding the full log).
 */
const install: InvariantInstaller = (ctx, fail) => {
  /**
   * Fold the gauntlet events for one session and validate the reconstructed
   * state.  Called on every relevant `session/event` and once on seed.
   */
  const foldSession = (session: { id: string | { toString(): string }; events: readonly { type: string; time: number; data?: unknown }[] }): void => {
    const id = String(session.id)
    let outcome: { error?: { kind: string; detail: string }; state?: import('./core.js').GauntletState }
    try {
      outcome = reconstructFromSessionEvents(session.events)
    } catch (err: unknown) {
      fail(`Gauntlet replay invariant: session "${id}" threw ${String(err)}`)
      return
    }
    if (outcome.error) {
      fail(`Gauntlet replay invariant: session "${id}" — ${outcome.error.detail}`)
      return
    }
    const errors = validateReconstructedState(outcome.state!)
    if (errors.length > 0) {
      fail(`Gauntlet state invariant: session "${id}" — ${errors.join('; ')}`)
    }
  }

  /**
   * Sessions that have at least one `gauntlet_loop` call.  Only these pay the
   * fold cost; ordinary sessions never do.
   */
  const gauntletSessions = new Set<string>()

  /** Whether an event can change the gauntlet reconstruction for a session. */
  const relevant = (sessionId: string, event: { type: string; data?: unknown }): boolean => {
    if (event.type === 'tool/call') {
      const data = (event.data ?? {}) as Record<string, unknown>
      const isGauntletCall = data.name === 'gauntlet_loop'
      if (isGauntletCall) gauntletSessions.add(sessionId)
      return isGauntletCall
    }
    // A tool/result matters only when this session has gauntlet activity (its
    // verdicts/aborts are part of the reconstruction).
    if (event.type === 'tool/result') return gauntletSessions.has(sessionId)
    // Foreign vocabulary that could carry gauntlet state in future versions.
    if (typeof event.type === 'string' && event.type.startsWith('gauntlet/')) {
      gauntletSessions.add(sessionId)
      return true
    }
    return false
  }

  // Seed: fold every existing session on installation.
  // The session store is available via ctx.sessions.
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    try {
      for (const session of sessions.list()) {
        foldSession(session as unknown as { id: string; events: readonly { type: string; time: number; data?: unknown }[] })
      }
    } catch {
      // sessions.list() may not be available in all contexts; skip seed.
    }
  }

  // Fold only when an event could advance the gauntlet fold, keeping the
  // per-event cost constant for ordinary (non-gauntlet) traffic.
  ctx.on('session/event', (session: unknown, event: unknown) => {
    const id = String((session as { id?: unknown }).id ?? '')
    if (!id || !relevant(id, event as { type: string; data?: unknown })) return
    foldSession(session as { id: string; events: readonly { type: string; time: number; data?: unknown }[] })
  }, { global: true })
}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
