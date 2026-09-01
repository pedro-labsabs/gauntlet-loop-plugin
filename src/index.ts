/**
 * Stateful Gauntlet Loop protocol for DeepSeek Harness.
 *
 * The tool is intentionally an orchestrator/state-machine rather than a builder:
 * the lead agent must delegate real work to fresh builder/critic sub-agents, then
 * register auditable artifacts and evidence here. The state machine refuses the
 * common fake-gauntlet shortcuts (self-critique, critique-before-build, reused
 * critic context, empty artifact locations, non-blind verdicts).
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  createInitialState,
  runGauntletAction,
  type GauntletActionInput,
  type GauntletState,
} from './core.js'
import { renderToolValue } from './presentation.js'

export const name = 'tool-gauntlet'
export const inject = ['tools']

const MAX_SESSION_STATES = 128
const SESSION_STATES = new Map<string, GauntletState>()

function stateKey(exec: ToolExecution): string {
  return exec.agent?.id ?? 'anonymous'
}

function stateFor(exec: ToolExecution): GauntletState {
  const key = stateKey(exec)
  let state = SESSION_STATES.get(key)
  if (state) return state

  if (SESSION_STATES.size >= MAX_SESSION_STATES) {
    const first = SESSION_STATES.keys().next().value as string | undefined
    if (first !== undefined) SESSION_STATES.delete(first)
  }
  state = createInitialState()
  SESSION_STATES.set(key, state)
  return state
}

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
      refinedCommand: { type: 'string', description: 'Objective/mensurable command after refinement (refine).' },
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
      const liveState = stateFor(exec)
      const result = runGauntletAction(
        liveState,
        args as unknown as GauntletActionInput,
        { now: Date.now(), runId: String(exec.callId) },
      )
      // DSH deep-freezes canonical tool values. Never return the live mutable
      // session state object or subsequent protocol actions would mutate frozen data.
      return detachedJson(result)
    },
  })

  ctx.tools.register(tool)
}
