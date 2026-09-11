# EmpiriaAI.github.io

The Empiria Labs homepage, served by GitHub Pages at
**<https://empiriaai.github.io/>**.

Three files and a stylesheet, no build step and no dependencies. What is
committed here is exactly what is served.

```
index.html      the page
style.css       every rule, including the reduced-motion path
script.js       reveal, the hero's pointer work, the scroll-linked weight ramp
fonts.css       @font-face for the four self-hosted faces
fonts/          Space Grotesk, Inter Tight (+ italic), JetBrains Mono
.nojekyll       opt out of Jekyll — this is plain static output
```

## Local preview

```bash
python3 -m http.server 8000
```

Any static server works. Opening `index.html` directly over `file://` also
works, but the scroll-linked effects are easier to judge over HTTP.

## Two decisions that are easy to undo by accident

**The fonts are self-hosted, not linked.** `fonts.googleapis.com` does not
resolve from mainland China. The request does not degrade, it fails — so the
page fell all the way through to the system stack and the typography, which
is the entire visual identity here, silently disappeared for a large share of
readers. A mirror CDN only relocates the single point of failure. Only the
latin subset is shipped: every character the page renders was audited against
the subset ranges, and the CJK text is set in the system stack by design.

**Every hover rule sits inside `@media (hover: hover) and (pointer: fine)`.**
Ungated, a tap on a touch screen latches the state, and for the two marquees
that stops them for good. Focus rings are on `:focus-visible` so a mouse click
does not leave one behind.

`prefers-reduced-motion` is a real path rather than a token gesture: the
marquees unroll into their complete lists instead of freezing on an arbitrary
clipped slice, the loop diagram parks in a readable resting state rather than
mid-beat, pointer interaction in the hero is never armed, and hover colour
feedback is kept while movement is dropped.

## Trajectory pages

```
trajectory-explorer.html   linear event stream; ?category=feedback|swe opens a tab
trajectory-dialogue.html   two-lane reader: fed-to-model left, model-produced right
trajectory-data.js         two feedback runs + django__django-11119 (inline)
swe-trajectory-data.js     83 swe-task-forge rollouts over 47 tasks (inline)
feedback-snapshot-index.js 42 feedback snapshots, bodies lazy in data/
tools/                     importers that produce the data files above
schema/                    the SWE field contract and its capture-gap ledger
```

Both pages concatenate `EMPIRIA_RAW_TRAJECTORIES`, `EMPIRIA_SWE_TRAJECTORIES`
and `EMPIRIA_FEEDBACK_SNAPSHOTS` and route on `trajectoryClass`.

**SWE rollouts** come from `tools/export-swe-trajectories.py`, which reads a
swe-task-forge pack and the mining manifests behind it. The field contract is
`schema/SWE_TRAJECTORY.md` (+ `swe-trajectory.schema.json`): every field is
optional and a `null` hides its row, so a producer can start filling a reserved
field and it appears with no viewer change. For SWE runs the pipeline panel
becomes a provenance panel — commit source, task construction, both gate arms
with their raw pytest tails, suite-flip evidence, gold patch and hidden tests.

Read `schema/SWE_FIELD_COVERAGE.md` before trusting a number: only 395 of the
1,039 commands in this corpus have output anywhere in the pack, because the
harness keeps the last ~59 KB of the codex transcript and its `command_result`
events store the command but never the output. Those calls carry
`status: "missing"` — rendered muted, and kept out of every failure count,
because a capture gap is not an agent failure.

## Source

Site source and the rest of the lab's work: <https://github.com/EmpiriaAI>
