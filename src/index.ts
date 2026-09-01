/**
 * Stateful Gauntlet Loop protocol for DeepSeek Harness.
 *
 * The tool reconstructs its canonical state from the durable session event log
 * by replaying every settled `gauntlet_loop` tool call through the pure core
 * state machine (`src/core.ts`).  No in-memory mutable state is maintained
 * between calls — the session event log IS the durable source of truth.
 *
 * Every successful call persists a verification `meta` on its `tool/result`
 * (protocol version + semantic fingerprint of the post-action state).  On
 * restart/reload the session log is replayed from persistence (JSONL/SQLite);
 * the first tool call after reload reconstructs the exact pre-restart state
 * and FAILS CLOSED if any settled call does not reproduce its persisted result
 * (tampering, incompatible protocol version, or a stale log without meta).
 *
 * The live fold is incremental: a per-session watermark checkpoint re-folds
 * only the delta on each call, while the full deterministic replay remains
 * available for verification and tests.
 *
 * Cross-session isolation is guaranteed: each session has its own event log
 * and its own fold checkpoint.  The 'anonymous' fallback is removed — a tool
 * call without an owning agent session is rejected.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  createInitialState,
  GAUNTLET_PROTOCOL_VERSION,
  GAUNTLET_SCHEMA_VERSION,
  GAUNTLET_PRESENTATION_VERSION,
  runGauntletAction,
  stateFingerprint,
  type GauntletActionInput,
  type GauntletResult,
} from './core.js'
import { findCallTime, reconstructFromSessionEvents, ReplayCheckpointCache } from './replay.js'
import { renderToolValue } from './presentation.js'

export const name = 'tool-gauntlet'
export const inject = ['tools']

/**
 * Per-session in-memory fold checkpoints keyed by the Session INSTANCE
 * identity (`WeakMap`), not by `SessionId`.  A pure cache of the last
 * reconstruction position — NEVER a source of truth: the canonical state is
 * always derivable from (and verified against) the session event log.  A new
 * Session incarnation with the same id always misses the cache and re-verifies
 * the full history.
 * @see reconstructFromSessionEvents
 */
const replayCheckpoints = new ReplayCheckpointCache()

function detachedJson(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue
}

/** Register the `gauntlet_loop` model-facing tool. */
export function apply(ctx: Context): void {
  const tool = defineTool({
    name: 'gauntlet_loop',
    description:
      'Run a strict Gauntlet Loop quality protocol. The lead sets a named/fetchable/comparable real bar, '
      + 'removes or measures subjective wording, splits the goal into independently judgeable units, then '
      + 'uses a NEW builder sub-agent and a NEW harsh critic sub-agent for every round. The critic must inspect '
      + 'the real artifact, compare blindly against the bar, provide observable evidence, and return one binary '
      + 'winner: "ours" or "bar". A bar win forces rebuild. A reused/self critic, critique without a pending '
      + 'build, empty artifact, or non-blind/evidence-free verdict is rejected. Use status at any time for the '
      + 'visual workbench. The loop ends only after every unit wins, or halt explicitly records why it stopped.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['submit', 'refine', 'split', 'build', 'critique', 'complete', 'status', 'halt', 'reset'],
        description: 'Protocol action.',
      },
      command: { type: 'string', description: 'Raw user goal (submit).' },
      refinedCommand: { type: 'string', description: 'Objective/measurable command after refinement (refine).' },
      bar: {
        type: 'json',
        description: 'Real quality bar {name, fetchHow, compareHow, description}. name must identify a specific reference; fetchHow must be reproducible; compareHow must describe a blind comparison.',
      },
      subjectiveResolved: {
        type: 'json',
        description: 'Subjective-term resolutions [{term, objectiveDefinition, measuredBy}] required for any flagged term that remains in refinedCommand.',
      },
      pieces: {
        type: 'json',
        description: 'Small judgeable units [{id, title, description}] (split). IDs must be unique and descriptions non-empty.',
      },
      pieceIndex: { type: 'integer', description: '0-based unit index (build/critique).' },
      builderSubagentId: {
        type: 'string',
        description: 'Fresh builder sub-agent id for this round (build). Reuse is rejected.',
      },
      builderEvidence: {
        type: 'string',
        description: 'Optional concise build-side evidence such as tests/commands run; critic must still inspect the artifact independently.',
      },
      artifact: {
        type: 'json',
        description: 'Real artifact {location, summary} (build). location must let the critic open the actual output, not only a prose summary.',
      },
      criticSubagentId: {
        type: 'string',
        description: 'Fresh critic sub-agent id for this round (critique). Must differ from builder and every previously used critic.',
      },
      verdict: {
        type: 'json',
        description: 'Blind verdict {winner:"ours"|"bar", notes, evidence, blind:true}. Evidence must be observable and tied to the artifact/reference comparison.',
      },
      summary: { type: 'json', description: 'Final report {outcome, lessons} after all units win (complete).' },
      reason: { type: 'string', description: 'Why an active gauntlet is intentionally stopped (halt).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: renderToolValue(value) }],
      // Persisted verification meta on every top-level tool/result: the
      // protocol/schema versions that produced the state plus a semantic
      // fingerprint of the post-action state.  Replay recomputes the
      // fingerprint from the reproduced state and fails closed on divergence.
      presentationMeta: (_args: unknown, value: JsonValue) => {
        const result = value as Partial<GauntletResult> | null
        const state = result?.state ?? null
        const pres: Record<string, unknown> = {
          version: GAUNTLET_PRESENTATION_VERSION,
          phase: result?.phase ?? 'idle',
          next: result?.next ?? null,
        }
        if (result?.nextPieceIndex !== undefined) pres.nextPieceIndex = result.nextPieceIndex
        if (result?.error !== undefined) pres.error = result.error
        if (result?.rejections !== undefined && result.rejections.length > 0) {
          pres.rejections = result.rejections
        }
        return detachedJson({
          protocol: GAUNTLET_PROTOCOL_VERSION,
          schema: GAUNTLET_SCHEMA_VERSION,
          ok: result?.ok === true,
          fingerprint: state ? stateFingerprint(state) : null,
          presentation: pres,
        })
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: `Gauntlet · ${String(args.action)}`,
      kind: 'execute',
      rawInput: typeof args.pieceIndex === 'number' ? { pieceIndex: args.pieceIndex } : undefined,
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: `Gauntlet · ${String(args.action)}`,
      content: result.content,
    }),
    async execute(args: Record<string, unknown>, exec: ToolExecution): Promise<JsonValue> {
      // ---- session guard: no 'anonymous' fallback ----
      const agent = exec.agent
      if (!agent?.session) {
        return detachedJson({
          ok: false,
          phase: 'idle',
          error: 'gauntlet_loop requires an owning agent session (no global anonymous state)',
          next: null,
          state: createInitialState(),
        })
      }

      const session = agent.session
      const events = session.events
      const callId = String(exec.callId ?? '')

      // ---- reconstruct the canonical state from the durable session log ----
      // The in-flight tool/call for THIS action is already in the log but has
      // no settled result yet, so reconstruction skips it — the base state is
      // exactly the state before the current action.  Resume from the cached
      // checkpoint when it is still within the log (incremental fold).  The
      // cache is keyed by the live Session instance, so a new incarnation
      // (same id, different object) always re-verifies the full history.
      const cached = replayCheckpoints.get(session)
      const checkpoint = cached !== undefined && cached.lastSeq <= events.length ? cached : undefined
      const reconstruction = reconstructFromSessionEvents(events, checkpoint)
      if (reconstruction.error) {
        // Fail closed: never serve a corrupted/unverifiable Gauntlet as valid.
        return detachedJson({
          ok: false,
          phase: 'idle',
          error: `Gauntlet state reconstruction failed: ${reconstruction.error.detail}`,
          next: null,
          state: reconstruction.state,
        })
      }
      if (reconstruction.checkpoint) {
        replayCheckpoints.set(session, reconstruction.checkpoint)
      }

      // Deterministic `now`: prefer the current tool/call event time so the
      // live action and its later replay agree byte-for-byte.
      const now = findCallTime(events, callId) ?? Date.now()

      // ---- apply the current action through the core (exactly once) ----
      const result = runGauntletAction(reconstruction.state, args as unknown as GauntletActionInput, { now, runId: callId })

      // DSH deep-freezes canonical tool values. Never return the live mutable
      // session state object or subsequent protocol actions would mutate frozen data.
      return detachedJson(result)
    },
  })

  ctx.tools.register(tool)
}