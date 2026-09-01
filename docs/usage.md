# Using `gauntlet_loop`

The lead agent orchestrates real builder/critic sub-agents and records the resulting protocol trace through `gauntlet_loop`. The tool rejects invalid transitions instead of merely documenting them.

## 1. Submit

```json
{
  "action": "submit",
  "command": "Build a fast, polished checkout experience."
}
```

The next phase is `refine`.

## 2. Refine: objective command + real bar

Subjective words such as `fast` and `polished` must either disappear or receive objective definitions with a measurement method.

```json
{
  "action": "refine",
  "refinedCommand": "Build checkout with p95 local interaction latency below 100 ms and no horizontal overflow from 360 px to 1440 px.",
  "bar": {
    "name": "Stripe Checkout reference",
    "fetchHow": "Open https://stripe.com/payments/checkout and capture the relevant desktop/mobile reference before critique.",
    "compareHow": "Place the reference and our artifact side by side without labels and make a blind A/B choice before revealing identity.",
    "description": "Named interaction and visual reference."
  },
  "subjectiveResolved": []
}
```

A bar fails the gate if its name is empty, `fetchHow` is vague, or `compareHow` does not explicitly describe a blind/label-free comparison.

## 3. Split into judgeable units

```json
{
  "action": "split",
  "pieces": [
    {
      "id": "shell",
      "title": "Checkout shell",
      "description": "Layout, hierarchy and responsive behavior judged independently."
    },
    {
      "id": "interaction",
      "title": "Checkout interaction",
      "description": "Input, validation and latency behavior judged independently."
    }
  ]
}
```

IDs must be unique. Each unit needs a title and description. The hard maximum is 32 units.

## 4. Build with a fresh builder

First run an actual builder sub-agent. Then register what it produced:

```json
{
  "action": "build",
  "pieceIndex": 0,
  "builderSubagentId": "builder-run-17",
  "builderEvidence": "Unit tests pass; responsive smoke check completed.",
  "artifact": {
    "location": "/workspace/app/src/checkout.tsx",
    "summary": "Responsive checkout shell implemented and available for direct inspection."
  }
}
```

The same agent id cannot be reused anywhere else in this Gauntlet run. A second build for this unit is rejected until its pending build is critiqued.

## 5. Critique with a separate fresh critic

Spawn a new critic with fresh context. Give it the artifact and bar, but do not disclose which candidate is ours until after it chooses.

```json
{
  "action": "critique",
  "pieceIndex": 0,
  "criticSubagentId": "critic-run-31",
  "verdict": {
    "winner": "bar",
    "notes": "The reference preserves clearer visual hierarchy at 360 px.",
    "evidence": "Blind A/B screenshots: candidate B kept CTA and total visible while candidate A pushed the total below the first viewport.",
    "blind": true
  }
}
```

Required conditions:

- there must be exactly one pending build for the unit;
- the critic id must be new and different from the builder id;
- `winner` is exactly `ours` or `bar`;
- `notes` and observable `evidence` are non-empty;
- `blind` must literally be `true`.

If `bar` wins, the unit moves to `rebuild` and requires a **new builder id**. If `ours` wins, the unit moves to `won`.

## 6. Inspect progress

```json
{ "action": "status" }
```

The result is rendered as the visual workbench with phase, bar, progress, rounds, unit status, latest evidence and the recommended next protocol action.

## 7. Complete

Only after every unit is `won`:

```json
{
  "action": "complete",
  "summary": {
    "outcome": "All checkout units beat the named bar in blind evidence-backed comparisons.",
    "lessons": "Mobile hierarchy was the recurring failure mode and required one rebuild."
  }
}
```

## Halt instead of faking convergence

If the bar becomes unavailable, requirements change materially, a budget boundary is reached, or continuing no longer makes sense:

```json
{
  "action": "halt",
  "reason": "Reference became unavailable; a valid blind comparison can no longer be performed."
}
```

This records a terminal `halted` state. It is intentionally different from `done`.

## Important limitation

The plugin validates the trace supplied to it. It does not currently call the DSH sub-agent provider directly, so it cannot independently verify that a reported sub-agent id was really a fresh context. Do not claim the Gauntlet ran if the lead did not actually delegate the builder and critic work.
