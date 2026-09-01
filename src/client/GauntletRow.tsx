/**
 * Gauntlet workbench toolview: a dedicated card for each `gauntlet_loop`
 * call in the transcript.
 *
 * The accumulated workbench state arrives as a finished whole value from the
 * Host session-projection unit, read via `useProjection('gauntlet')` — NOT
 * by folding a partial client window (`chat.legacy.nodes`).  The host fold
 * covers the full durable log regardless of transcript paging, and the value
 * is seeded with the history-tail baseline and updated by
 * `session/projection` push frames.  A reconstructed session renders
 * semantically identical cards to one observed live.
 *
 * The card is a READ-ONLY projection.  It never runs protocol rules or
 * decides transition validity; it only presents the host-computed DTO.
 */

import { memo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconInspectOutline12, IconSparkle16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RunningToolCall, ToolCallBlock, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  parseProjectionWire, parseBlockPresentation, isOpenablePath, resultText, actionOf, boundedText, unitGlyphStatus,
  type GauntletProjectionDTO, type BlockedDTO, type ProjectedRoundDTO, type ProjectedUnitDTO,
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
  return <StateDot state={unitGlyphStatus(status)} size={10} className={status === 'pending' ? css.unitPending : undefined} />
}

function winnerBadge(winner: 'ours' | 'bar', t: GauntletRowProps['t']): ReactNode {
  const cls = winner === 'ours' ? css.winnerOurs : css.winnerBar
  const label = winner === 'ours' ? t('row.ours') : t('row.bar')
  return <span className={`${css.winnerBadge} ${cls}`}>{label}</span>
}

// ---- Blocked panel ----

const BlockedPanel = memo(function BlockedPanel({
  blocked, t,
}: { blocked: BlockedDTO; t: GauntletRowProps['t'] }) {
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
}: { round: ProjectedRoundDTO; openFile: (path: string) => void; t: GauntletRowProps['t'] }) {
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
  unit: ProjectedUnitDTO
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
  const output = 'kind' in block ? resultText(block.content, block.error) : null
  const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : 'error'
  return (
    <div className={css.card} data-tool="gauntlet_loop" data-state={state}>
      <div className={css.fallback}>
        <span className={css.fallbackTitle}>{t('row.unavailable')}</span>
        {reason !== undefined && reason !== '' ? (
          <span className={css.fallbackReason}>{reason}</span>
        ) : null}
        {argsRaw !== '' ? <pre className={css.fallbackCode}>{boundedText(argsRaw)}</pre> : null}
        {output !== null ? <pre className={css.fallbackCode}>{boundedText(output)}</pre> : null}
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
 * Render one `gauntlet_loop` call as the accumulated workbench, sourced from
 * the Host session projection (`useProjection('gauntlet')`).
 * @param props - keyed toolview payload plus the gauntlet locale seat.
 * @returns the dedicated workbench card.
 */

// ---- Historical per-call stable row (block-derived, never drifts) ----

const HistoricalCard = memo(function HistoricalCard({
  block, t, openFile, inspect,
}: {
  block: ToolCallBlock
  t: GauntletRowProps['t']
  openFile: (path: string) => void
  inspect?: (() => void) | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = !('kind' in block)
  const settled = isRunning ? null : block as ToolResultNode
  const action = isRunning
    ? actionOf((block as RunningToolCall).argsRaw)
    : actionOf(settled !== null ? settled.call?.argsRaw ?? null : null)
  const title = action !== '' ? `${t('row.gauntlet')} · ${action}` : t('row.gauntlet')
  const output = settled !== null ? resultText(settled.content, settled.error) : null
  const pres = settled !== null ? parseBlockPresentation(settled.meta) : null
  const showBlocked = !isRunning && pres?.error !== undefined
  const expandable = output !== null || showBlocked
  const open = expanded && expandable

  const toggleExpand = (): void => setExpanded(v => !v)
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

  const state = isRunning || settled === null ? 'running' : settled.error?.code === 'interrupted' ? 'stopped' : 'ok'
  return (
    <div className={css.card} data-tool="gauntlet_loop" data-state={state}>
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
        {pres?.phase !== null && pres?.phase !== undefined ? (
          <span className={css.phaseTag}>{pres.phase}</span>
        ) : null}
        {isRunning ? (
          <span className={`${css.statusTag} ${css.statusRunning}`}>{t('row.running')}</span>
        ) : null}
        {pres !== null && pres !== undefined && pres.next !== null ? (
          <span className={css.nextAction}>{t('row.next')} {pres.next}</span>
        ) : null}
      </div>
      {open ? (
        <div className={css.bodyWrap}>
          {showBlocked ? (
            <div className={css.blockedPanel} role="alert">
              <div className={css.blockedHeader}>{t('row.blockedHeading')}</div>
              {pres.error ? <div className={css.blockedError}>{pres.error}</div> : null}
              {pres.rejections && pres.rejections.length > 0 ? (
                <ul className={css.rejectionList}>
                  {pres.rejections.slice(0, 5).map((r, i) => (
                    <li key={i} className={css.rejection}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {output !== null ? (
            <pre className={css.fallbackCode}>{boundedText(output)}</pre>
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
})
export function GauntletRow({ block, useProjection, openFile, inspect, t }: GauntletRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [openUnits, setOpenUnits] = useState<ReadonlySet<string>>(new Set())

  const workbench = useProjection('gauntlet')
  const projection = parseProjectionWire(workbench)

  // Determine if this settled card is the projection's current cut
  // (the last settled gauntlet result the DTO reflects).
  const isSettled = 'kind' in block
  const isCurrentCut = isSettled && projection !== null
    && projection.asOfCallId !== null && block.callId === projection.asOfCallId

  // --- Fallback: unavailable projection or capability absent ---
  if (projection === null || !projection.available) {
    return (
      <GenericFallback
        block={block}
        reason={projection?.unavailableReason}
        t={t}
        inspect={inspect}
      />
    )
  }

  // --- Historical card (not the current cut): stable per-call representation ---
  if (!isCurrentCut) {
    return <HistoricalCard block={block} t={t} openFile={openFile} inspect={inspect} />
  }

  // --- Current cut: full workbench ---
  const isRunning = !isSettled
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