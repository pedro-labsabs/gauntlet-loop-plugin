/**
 * Gauntlet workbench toolview: a dedicated card for each `gauntlet_loop`
 * call in the transcript.  The card shows the accumulated workbench state
 * as of that call — projected deterministically from the durable wire
 * material (the conversation snapshot's settled tool results), so a
 * reconstructed session renders semantically identical cards.
 *
 * The card is a READ-ONLY projection.  It never runs protocol rules or
 * decides transition validity; it only presents facts the host already
 * accepted (`meta.ok` + the bounded `meta.presentation` envelope) combined
 * with the persisted `argsRaw`.
 */

import { memo, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconInspectOutline12, IconSparkle16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ConversationNode, RunningToolCall, ToolCallBlock, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  projectGauntlet, parseGauntletArgs,
  type BlockedView, type GauntletCallSlice, type ProjectedRound, type ProjectedUnit,
} from './model.ts'
import { type GauntletKey } from './locale.ts'
import css from './GauntletRow.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated gauntlet workbench card's copy. */
    gauntlet: GauntletKey
  }
}

// ---- Full row props: toolview runtime share + this package's locale seat. ----
type GauntletRowProps = ToolCallViewProps & PropsLocale<'gauntlet'>

// ---- Fallback helpers ----

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Flatten durable result blocks under the generic Tool-row text contract. */
function resultText(block: ToolCallBlock): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/** Parse the action name from wire args (empty when unavailable). */
function actionOf(argsRaw: string | null): string {
  const args = parseGauntletArgs(argsRaw)
  if (args === null) return ''
  const action = args['action']
  return typeof action === 'string' ? action : ''
}

/**
 * Collect every SETTLED gauntlet_loop call slice in the conversation,
 * walking nested sub-calls.  Running (in-flight) gauntlet calls are not
 * settled, so they are excluded — the current running state rides the
 * block prop instead.
 */
function collectGauntletSlices(nodes: readonly ConversationNode[]): GauntletCallSlice[] {
  const slices: GauntletCallSlice[] = []
  const walk = (blocks: readonly ToolCallBlock[]): void => {
    for (const block of blocks) {
      if ('kind' in block) {
        if (block.call?.name === 'gauntlet_loop') {
          slices.push({
            seq: block.seq,
            argsRaw: block.call.argsRaw,
            meta: block.meta,
            isError: block.isError,
            error: block.error,
          })
        }
        walk(block.subCalls)
      } else {
        walk(block.subCalls)
      }
    }
  }
  for (const node of nodes) {
    if (node.kind === 'tool-result') walk([node as ToolResultNode])
  }
  slices.sort((left, right) => left.seq - right.seq)
  return slices
}

// ---- Display helpers ----

function statusLabel(status: string, t: GauntletRowProps['t']): string {
  switch (status) {
    case 'blocked': return t('row.blocked')
    case 'complete': return t('row.complete')
    case 'halted': return t('row.halted')
    default: return t('row.running')
  }
}

function unitStatusLabel(status: string, t: GauntletRowProps['t']): string {
  switch (status) {
    case 'won': return t('row.won')
    case 'awaiting_critique': return t('row.awaitingCritique')
    case 'rebuild': return t('row.rebuild')
    default: return t('row.pending')
  }
}

function unitGlyph(status: string): ReactNode {
  switch (status) {
    case 'won': return <StateDot state="done" size={10} />
    case 'awaiting_critique': return <StateDot state="ongoing" size={10} />
    case 'rebuild': return <StateDot state="warning" size={10} />
    default: return <StateDot state="done" size={10} className={css.unitPending} />
  }
}

function winnerBadge(winner: 'ours' | 'bar', t: GauntletRowProps['t']): ReactNode {
  const cls = winner === 'ours' ? css.winnerOurs : css.winnerBar
  const label = winner === 'ours' ? t('row.ours') : t('row.bar')
  return <span className={`${css.winnerBadge} ${cls}`}>{label}</span>
}

/** Only filesystem-like paths are openable through the Host; URLs/ids never are. */
function isOpenablePath(location: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(location)
}

// ---- Blocked panel ----

const BlockedPanel = memo(function BlockedPanel({
  blocked, t,
}: { blocked: BlockedView; t: GauntletRowProps['t'] }) {
  return (
    <div className={css.blockedPanel} role="alert">
      <div className={css.blockedHeader}>{t('row.blockedHeading')}</div>
      {blocked.error !== null ? <div className={css.blockedError}>{blocked.error}</div> : null}
      {blocked.rejections.length > 0 ? (
        <ul className={css.rejectionList}>
          {blocked.rejections.slice(0, 5).map((rejection, index) => (
            <li key={index} className={css.rejection}>{rejection}</li>
          ))}
          {blocked.rejections.length > 5 ? (
            <li className={css.rejection}>{t('row.rejections')}: …{blocked.rejections.length - 5} more</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
})

// ---- Round history detail ----

const RoundDetail = memo(function RoundDetail({
  round, openFile, t,
}: { round: ProjectedRound; openFile: (path: string) => void; t: GauntletRowProps['t'] }) {
  const openable = isOpenablePath(round.artifactLocation)
  const openArtifact = (): void => { if (openable) openFile(round.artifactLocation) }
  return (
    <div className={css.roundDetail}>
      <div className={css.roundHeader}>{t('row.roundLabel')} {round.round}</div>
      <div className={css.detailRow}>
        <span className={css.detailLabel}>{t('row.builder')}</span>
        <span className={css.detailValue}>{round.builder}</span>
      </div>
      {round.artifactLocation !== '' ? (
        <div className={css.detailRow}>
          <span className={css.detailLabel}>{t('row.artifact')}</span>
          <span
            className={`${css.detailValue} ${openable ? css.artifactLink : ''}`}
            role={openable ? 'button' : undefined}
            tabIndex={openable ? 0 : undefined}
            onClick={openable ? openArtifact : undefined}
            onKeyDown={openable ? (event: KeyboardEvent<HTMLSpanElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openArtifact()
              }
            } : undefined}
            title={round.artifactLocation}
          >
            {round.artifactLocation}
          </span>
        </div>
      ) : null}
      {round.builderEvidence !== '' ? (
        <div className={css.detailRow}>
          <span className={css.detailLabel}>{t('row.evidence')}</span>
          <span className={css.detailValue}>{round.builderEvidence}</span>
        </div>
      ) : null}
      {round.critic === null ? (
        <div className={css.detailRow}>
          <span className={css.detailLabel}>{t('row.critic')}</span>
          <span className={css.detailValue}>{t('row.pending')}</span>
        </div>
      ) : (
        <>
          <div className={css.detailRow}>
            <span className={css.detailLabel}>{t('row.critic')}</span>
            <span className={css.detailValue}>{round.critic}</span>
          </div>
          {round.winner !== null ? (
            <div className={css.detailRow}>
              <span className={css.detailLabel}>{t('row.verdict')}</span>
              <span className={css.detailValue}>{winnerBadge(round.winner, t)}</span>
            </div>
          ) : null}
          {round.criticEvidence !== '' ? (
            <div className={css.detailRow}>
              <span className={css.detailLabel}>{t('row.evidence')}</span>
              <span className={css.detailValue}>{round.criticEvidence}</span>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
})

// ---- Unit item ----

const UnitItem = memo(function UnitItem({
  unit, expanded, onToggle, openFile, t,
}: {
  unit: ProjectedUnit
  expanded: boolean
  onToggle: () => void
  openFile: (path: string) => void
  t: GauntletRowProps['t']
}) {
  const expandable = unit.rounds.length > 0
  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onToggle()
  }
  return (
    <>
      <div
        className={css.unitRow}
        data-status={unit.status}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? expanded : undefined}
        aria-label={`${unit.id}: ${unitStatusLabel(unit.status, t)}`}
        onClick={expandable ? onToggle : undefined}
        onKeyDown={handleKey}
      >
        <span className={css.unitGlyph}>
          {expandable && expanded
            ? <IconChevronDownOutline14 size={12} />
            : expandable
              ? <IconChevronRightOutline14 size={12} />
              : unitGlyph(unit.status)}
        </span>
        <span className={css.unitId}>{unit.id}</span>
        <span className={css.unitTitle}>{unit.title}</span>
        {unit.rounds.length > 0 ? <span className={css.roundCount}>R{unit.rounds.length}</span> : null}
        <span className={css.unitStatusTag}>{unitStatusLabel(unit.status, t)}</span>
      </div>
      {expanded && expandable ? (
        <div className={css.roundsList}>
          {unit.rounds.map(round => (
            <RoundDetail key={round.round} round={round} openFile={openFile} t={t} />
          ))}
        </div>
      ) : null}
    </>
  )
})

// ---- Generic fallback (projection unavailable) ----

const GenericFallback = memo(function GenericFallback({
  block, reason, t, inspect,
}: {
  block: ToolCallBlock
  reason?: string
  t: GauntletRowProps['t']
  inspect?: (() => void) | undefined
}) {
  const settled = 'kind' in block
  const argsRaw = settled ? (block as ToolResultNode).call?.argsRaw ?? '' : (block as RunningToolCall).argsRaw
  const output = resultText(block)
  const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : 'error'
  return (
    <div className={css.card} data-tool="gauntlet_loop" data-state={state}>
      <div className={css.fallback}>
        <span className={css.fallbackTitle}>{t('row.unavailable')}</span>
        {reason !== undefined && reason !== '' ? (
          <span className={css.fallbackReason}>{reason}</span>
        ) : null}
        {argsRaw !== '' ? <pre className={css.fallbackCode}>{firstLine(argsRaw)}</pre> : null}
        {output !== null ? <pre className={css.fallbackCode}>{firstLine(output)}</pre> : null}
      </div>
      {inspect !== undefined ? (
        <button type="button" className={css.inspectButton} onClick={inspect}>
          <IconInspectOutline12 />
          {t('row.inspect')}
        </button>
      ) : null}
    </div>
  )
})

// ---- Main card ----

/**
 * Render one `gauntlet_loop` call as the accumulated workbench as of that
 * call.
 * @param props - keyed toolview payload plus the gauntlet locale seat.
 * @returns the dedicated workbench card.
 */
export function GauntletRow({ block, useSession, openFile, inspect, t }: GauntletRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [openUnits, setOpenUnits] = useState<ReadonlySet<string>>(new Set())

  // The projection is derived from the durable conversation snapshot
  // (replay-stable).  We select the settled node list and fold only the
  // gauntlet_loop slices up to and including this call.
  const nodes = useSession(snapshot => snapshot.chat.legacy.nodes)
  const projection = useMemo(() => {
    const slices = collectGauntletSlices(nodes)
    const blockSeq = 'kind' in block ? block.seq : null
    const window = blockSeq === null
      ? slices
      : slices.filter(slice => slice.seq <= blockSeq)
    const running = !('kind' in block)
    return projectGauntlet(window, running)
  }, [nodes, block])

  // ---- Fallback: unavailable projection renders generic/textual ----
  if (!projection.available) {
    return (
      <GenericFallback
        block={block}
        reason={projection.unavailableReason}
        t={t}
        inspect={inspect}
      />
    )
  }

  // ---- Header ----
  const isRunning = !('kind' in block)
  const action = isRunning
    ? actionOf((block as RunningToolCall).argsRaw)
    : actionOf((block as ToolResultNode).call?.argsRaw ?? null)
  const title = action !== '' ? `${t('row.gauntlet')} · ${action}` : t('row.gauntlet')
  const expandable = projection.units.length > 0 || projection.blocked !== null
    || projection.summary !== null || projection.haltedReason !== null
  const open = expanded && expandable

  const toggleExpand = (): void => setExpanded(value => !value)
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  const disclosureProps = expandable ? {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': open,
    'aria-label': open ? t('row.collapse') : t('row.expand'),
    onClick: toggleExpand,
    onKeyDown: toggleFromKeyboard,
  } : {}

  const statusClass = projection.status === 'blocked' ? css.statusBlocked
    : projection.status === 'complete' ? css.statusComplete
      : projection.status === 'halted' ? css.statusHalted
        : css.statusRunning

  const toggleUnit = (id: string): void => {
    setOpenUnits(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className={css.card} data-tool="gauntlet_loop" data-status={projection.status}>
      <div
        className={css.row}
        data-expandable={expandable || undefined}
        {...disclosureProps}
      >
        <span className={css.leading}>
          {open
            ? <IconChevronDownOutline14 size={14} />
            : <>
              <span className={css.iconIdle}><IconSparkle16 size={14} /></span>
              <IconChevronDownOutline14 className={`${css.chevron} ${css.chevronHover}`} size={14} />
            </>}
        </span>
        <span className={css.badge}>{t('row.gauntlet')}</span>
        {projection.phase !== null && projection.phase !== 'idle' ? (
          <span className={css.phaseTag}>{projection.phase}</span>
        ) : null}
        <span className={`${css.statusTag} ${statusClass}`}>{statusLabel(projection.status, t)}</span>
        {projection.barName !== null ? (
          <span className={css.barName} title={projection.barName}>{projection.barName}</span>
        ) : null}
        {projection.next !== null ? (
          <span className={css.nextAction}>
            {t('row.next')} {projection.next}
            {projection.nextPieceIndex !== null ? ` [${projection.nextPieceIndex}]` : ''}
          </span>
        ) : null}
        {projection.total > 0 ? (
          <span className={css.progressBar}>
            <span className={css.progressTrack}>
              <span
                className={css.progressFill}
                style={{ width: `${(projection.won / projection.total) * 100}%` }}
              />
            </span>
            <span>{t('row.progress', { won: String(projection.won), total: String(projection.total) })}</span>
          </span>
        ) : null}
      </div>

      {isRunning && !open ? <span className={css.visuallyHidden}>{t('row.running')}</span> : null}

      {open ? (
        <div className={css.bodyWrap}>
          {projection.blocked !== null ? <BlockedPanel blocked={projection.blocked} t={t} /> : null}

          {projection.units.length > 0 ? (
            <div className={css.unitsList}>
              {projection.units.map(unit => (
                <UnitItem
                  key={unit.id}
                  unit={unit}
                  expanded={openUnits.has(unit.id)}
                  onToggle={() => toggleUnit(unit.id)}
                  openFile={openFile}
                  t={t}
                />
              ))}
            </div>
          ) : null}

          {projection.status === 'complete' && projection.summary !== null ? (
            <div className={css.terminalPanel}>
              <div className={css.terminalHeader}>{t('row.complete')}</div>
              <div className={css.detailRow}>
                <span className={css.detailLabel}>{t('row.summary')}</span>
                <span className={css.detailValue}>{projection.summary.outcome}</span>
              </div>
              {projection.summary.lessons !== '' ? (
                <div className={css.detailRow}>
                  <span className={css.detailLabel}>{t('row.lessons')}</span>
                  <span className={css.detailValue}>{projection.summary.lessons}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {projection.status === 'halted' && projection.haltedReason !== null ? (
            <div className={css.terminalPanel}>
              <div className={css.terminalHeader}>{t('row.halted')}</div>
              <div className={css.detailRow}>
                <span className={css.detailLabel}>{t('row.reason')}</span>
                <span className={css.detailValue}>{projection.haltedReason}</span>
              </div>
            </div>
          ) : null}

          {inspect !== undefined ? (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutline12 />
              {t('row.inspect')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default GauntletRow