/** Package-owned invariant companion for gauntlet-loop-plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'gauntlet-loop-plugin'

export const name = 'tool-gauntlet-invariant'
export const inject = ['invariants']

/**
 * State-transition validation lives in the pure core and rejects invalid
 * protocol actions synchronously. Cross-restart/session-replay validation is
 * intentionally deferred until the loop state moves from process memory into
 * a durable DSH projection.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
