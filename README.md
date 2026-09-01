# Gauntlet Loop Plugin for DSH

A strict, auditable implementation of the **Gauntlet Loop** for DeepSeek Harness (DSH), with an in-tool visual workbench.

The plugin does not build the artifact itself. It makes the **lead agent** follow a verifiable protocol: define a real quality bar, split the work, use a fresh builder, use a separate fresh critic, compare blindly, record evidence, and rebuild whenever the bar wins.

## Why v1.1 exists

The original implementation tracked the intended ritual, but it was possible to register an empty builder/artifact, critique before a build, reuse critic context, or mark a piece as won without evidence. Its tool output was also raw JSON.

v1.1 turns that loose recorder into a stricter state machine:

- **build-before-critique is mandatory**;
- every round requires a **new builder sub-agent id**;
- every critique requires a **new critic sub-agent id**, different from the builder;
- `artifact.location` and `artifact.summary` are mandatory;
- verdicts require `notes`, observable `evidence`, and `blind: true`;
- a `"bar"` verdict forces `rebuild`;
- subjective wording is blocked until it is removed or made measurable;
- the quality bar must be named, reproducibly fetchable, and explicitly compared blind/without labels;
- all state transitions are validated by a pure core with automated tests.

## Visual workbench

Every result is rendered as a compact dashboard instead of a JSON dump. DSH Host surfaces also receive a native generic tool card; clients that do not implement that card still receive the same dashboard as text.

```text
┌─ GAUNTLET LOOP ─────────────────────────────────────────────
│ OK  BUILD ⇄ BLIND CRITIC  ·  call-42
│ █████████░░░░░░░░░  1/2 units won  ·  3 round(s)
│ BAR  Stripe Checkout
├─ UNITS
│ ✓ shell  Checkout shell  ·  R2 OURS
│    ↳ artifact src/checkout.ts · OURS · blind A/B selected ours…
│ ◇ polish  Interaction polish  ·  R1 awaiting critic
│    ↳ artifact src/ui.ts
├─ NEXT  critique piece[1]
└─────────────────────────────────────────────────────────────
```

Status glyphs: `○` pending, `◇` awaiting critic, `↻` rebuild required, `✓` won.

## Protocol

1. `submit` — record the raw goal.
2. `refine` — make requirements objective and define the real comparison bar.
3. `split` — create small, independently judgeable units.
4. `build` — register work produced by a fresh builder sub-agent.
5. `critique` — register a blind, evidence-backed verdict from a separate fresh critic.
6. If the bar wins, rebuild that unit with a new builder. If ours wins, continue.
7. When every unit wins, `complete` records the final outcome and lessons.
8. `halt` is the explicit escape hatch when continuing is no longer appropriate; it records the reason instead of pretending convergence happened.

`status` is safe at any phase and renders the current workbench. `reset` starts over.

## Install as a DSH bundle

This package ships its own `cordis.patch.yml` and `dsh.bundle` manifest. Add it to the DSH profile where you want the tool available:

```bash
dsh plugin --profile <profile> add github:pedro-labsabs/gauntlet-loop-plugin
```

Or install a local checkout/package into the profile:

```bash
npm install
npm run check
npm pack
dsh plugin --profile <profile> add ./gauntlet-loop-plugin-1.2.0.tgz
```

The bundle inserts:

```yaml
- insert:
    - id: tool-gauntlet-loop
      name: gauntlet-loop-plugin
```

> **Note:** the harness base bundle ships its own built-in row with the id
> `tool-gauntlet` (`@deepseek-ai/dsh-tool-gauntlet`). Duplicate loader entry
> ids abort the boot, so this bundle uses a unique id and the profile's user
> layer must disable the built-in row to activate this plugin:
>
> ```yaml
> - id: tool-gauntlet
>   name: '@deepseek-ai/dsh-tool-gauntlet'
>   disabled: true
> ```

## Tool contract

| Action | Required data | Gate |
|---|---|---|
| `submit` | `command` | non-empty goal |
| `refine` | `refinedCommand`, `bar`, subjective resolutions when flagged | real/fetchable bar + blind comparison plan |
| `split` | `pieces[]` | 1–32 unique, titled, described units |
| `build` | `pieceIndex`, `builderSubagentId`, `artifact` | fresh builder + openable artifact |
| `critique` | `pieceIndex`, `criticSubagentId`, `verdict` | fresh separate critic + evidence + `blind:true` |
| `complete` | `summary.outcome` | only after every unit won |
| `halt` | `reason` | only while active |
| `status` | — | any phase |
| `reset` | — | any phase |

See [docs/usage.md](docs/usage.md) for a complete call sequence.

## What the plugin proves — and what it does not

The state machine can prove that the **registered protocol trace** is internally valid: a critique cannot exist without a build, agent ids cannot be reused inside the run, the builder cannot also be the critic, and accepted verdicts carry blind/evidence assertions.

It cannot independently prove that a supplied sub-agent id corresponds to a genuinely fresh DSH process/context, nor inspect arbitrary artifacts by itself. The lead/harness still owns the actual delegation and artifact access. The stricter contract makes skipped steps visible and rejectable instead of silently accepting them.

State is durable: the canonical run is reconstructed from the session event log (every settled `gauntlet_loop` call is a `tool/call` + `tool/result` pair that DSH persists across restarts). Restarting/reloading the DSH process replays the log through the pure core and resumes exactly where the run stopped. No ad-hoc file, second store, or independent state manager is introduced.

**Fail-closed reconstruction:** every settled call persists a verification `meta` on its `tool/result` (protocol/schema version + semantic fingerprint of the post-action state). Replay recomputes the fingerprint from the reproduced state and **fails closed** on any divergence: a tampered call, an incompatible protocol version, a forged verdict, or a stale log without verification metadata can never silently normalize into a valid Gauntlet.

## Architecture

- `src/core.ts` — pure protocol/state machine; no DSH dependency. Sole authority on rules and transitions.
- `src/replay.ts` — pure reconstruction: folds settled `gauntlet_loop` calls from the session event log through the core, plus fail-closed cross-field validation.
- `src/presentation.ts` — deterministic dashboard renderer.
- `src/index.ts` — thin DSH tool adapter + Host presentation card.
- `src/invariant.ts` — package invariant companion; live replay/cross-event checks over the session log.
- `src/projection.ts` — Host **session-projection unit**: folds the full durable log over `tool/call` + `tool/result` into a presentation DTO, registered via `ctx.sessionProjections`. Never runs `runGauntletAction`; applies only host-accepted facts. Copy-on-write transitions (pure fold).
- `src/projection-types.ts` — shared wire DTO types + `SessionProjectionMap['gauntlet']` merge.
- `src/client/` — browser half (Web Client dedicated workbench). `index.ts` registers the `gauntlet_loop` keyed toolview in `tool.call.toolview`; `GauntletRow.tsx` renders it from `useProjection('gauntlet')`; `model.ts` is a defensive wire parser + UI helpers (no client-side fold).
- `test/` — protocol, visual renderer, restart/reconstruction, corruption, real-session integration, Host projection, and client model/component regression tests.

## Web Client workbench

The DSH Web Client renders each `gauntlet_loop` call through the official keyed tool-view slot (`tool.call.toolview`), backed by a Host session projection:

- the **full workbench** (phase, status, bar, NEXT, progress, units, round history, blocked/rejections, terminal) appears on the card that matches the projection's current cut (`asOfCallId`);
- **historical cards** (calls superseded by the current projection) render a stable per-call row derived from the frozen block + its own `meta.presentation` + textual output — they never drift toward the current projection;
- malformed/old logs fall back to the generic textual card (fail-closed), never a fabricated workbench.

The browser half ships as `exports["./client"]` + `dsh.client` and is bundled to `lib/client.js` in the DSH loader format. The Web UI is a **read-only projection** — it never becomes protocol authority.

## Credits

The Gauntlet Loop approach is associated with Matt Shumer. This project was also informed by community implementations such as RoboNuggets' gauntlet-loop skill.

## License

MIT