/**
 * Gauntlet Loop plugin, browser half: registers the keyed `gauntlet_loop`
 * toolview in the `tool.call.toolview` slot.  The workbench card is a
 * read-only projection of the durable session history — never protocol
 * authority.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GauntletRow } from './GauntletRow.tsx'
import type {} from '../projection-types.ts'
import { en, NS, zh, type GauntletKey } from './locale.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated gauntlet workbench card's copy. */
    gauntlet: GauntletKey
  }
}

/** Required services: slot registry and locale service. */
export const inject = ['slots', 'locale']

/**
 * Client plugin entry: register the `gauntlet_loop` toolview and locale
 * dictionaries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gauntlet: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'gauntlet_loop', locale: NS },
    GauntletRow,
  ))
}