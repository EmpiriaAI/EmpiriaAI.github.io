# Field coverage — what got exported, and what did not

Three separate layers lose data. Only layer 3 was fixable here.

```
mining run (bench_worker)  ──1──►  minions_v148_pack_20260911  ──2──►  pack/explorer/*.js  ──3──►  swe-trajectory-data.js
   manifests 01..10                 tasks/*/task/**                    (v1 exporter)          (export-swe-trajectories)
   full codex stdout                trace.jsonl (capped)
```

---

## Layer 3 — the exporter shipped inside the pack (`minions_v148_pack_20260911/explorer/trajectory-data.js`)

This is the layer `tools/export-swe-trajectories.py` replaces. It was the largest loss.

### 3a. The page rendered nothing

Every trajectory was missing `trajectoryClass`. The upstream explorer filters with
`trajectory.trajectoryClass === category` for `feedback | swe | terminal`, so
`categoryItems()` returned an empty list for all three tabs — 83/83 runs invisible,
no error in the console.

### 3b. Fields the schema defines that v1 never emitted

| Field | v1 | now | why it matters |
|---|---|---|---|
| `trajectoryClass` | absent | `"swe"` | without it nothing renders (3a) |
| `environment{}` | absent | 91 keys | drives the Environment / Task / Verification panels — all three were blank |
| `agentStepCount` | absent | `result.steps` | "Agent steps" metric |
| `eventCount` | absent | set | timeline counter |
| `tokenUsage{}` | absent | `{total, source}` | "Total tokens" metric |
| `conversationId`, `category`, `agent`, `serviceTier`, `valueTier` | absent | set where known | header meta line, task facts |
| `estimatedTokens` | `null` ×83 | 45 runs | the value is in the transcript footer (`tokens used\n34,935`) — never parsed |
| `errorRate` | `null` ×83 | computed | fraction of failed shell calls |
| `counts` | `{"events": n}` only | all 7 event types | the filter bar showed 0 for every type |
| event `timestamp` | absent | from `command_result` | timeline shows clock time, not `msg 12` |
| event `status` / `summary` / `target` | absent | set | failed results auto-expand and are colour-coded |

### 3c. The codex transcript was one opaque blob

v1 emitted each `codex_transcript` as a **single `assistant` event capped at 20,000
characters**: 900,558 of 2,588,552 transcript characters kept — **34.8 %**; 45 of 76
transcripts hit the cap. Nothing inside was parsed.

The transcript is a structured stream (`exec` / result line / stdout / `codex` /
`tokens used`). Parsing it recovers, per run:

| Recovered | v1 | now |
|---|---|---|
| Reasoning (`thinking`) events | 0 | **393** |
| Assistant messages | 0 (1 blob/run) | **258** |
| Command stdout (`tool_result`) | 0 | **1,073** |
| Exit status + duration per call | 0 | 395 calls |
| Token footer | 0 | 45 runs |

### 3d. Pack artifacts that had no representation at all

| Artifact | Count | Now shown as |
|---|---|---|
| `GATE.json` (empty-arm / gold-arm rc, reward, pytest tail) | 47 | "Two-arm gate" + raw tails |
| `runs/*/suite.log` (verifier output) | 83 | a `context` event per run |
| `task.toml` `[metadata]` (difficulty, variant, source_image, subject, commit_subject, patch_lines, domain) | 47 | environment + provenance panels |
| `task.toml` `[environment]` / `[agent]` / `[verifier]` (cpus, memory, storage, internet, workdir, timeouts) | 47 | Environment panel + budgets |
| `solution/gold.patch` | 47 | file list, +/− line counts |
| `tests/hidden/*` | 57 | hidden-test file names |
| `tests/suite.sh` | 47 | "Verifier command" |
| `image.json` (base image, tarball) | 47 | Task construction |
| `result.json` `verifier_rc`, `reward.detail.suite_rc`, `reward.detail.graded_by`, `seconds` | 83 | Run outcome |

Still **not** exported by choice: `environment/tree.tar`, `environment/Dockerfile`,
`solution/solve.sh` full body, `SHA256SUMS`, and the 13 GB of `images/*.tar.gz`.
Nothing renders them; they belong in the pack, not the page.

### 3e. Mining provenance — never in the pack at all

The pack keeps the task but not where it came from. Joining
`mining_v148*/manifests/{02..10}` back in (47/47 tasks matched) recovers:

`commit`, `parent`, `subject`, `author`, `author_date`, `is_merge`, `repo_url`,
`bucket_id`, `issue_refs`, `issue_tracker`, `instance_id`, `route`, `shape`,
`test_origin`, `statement_origin`, `withheld`, `harbor_ref`, `image_digest`,
`gold_patch_digest`, `test_patch_digest`, `files.gold`, `files.test`,
`evidence{base_rc, broken_rc, fixed_rc, gold_patch_rc, test_patch_rc, tree_rc}`,
and the LLM `judge.behavior_summary{user_scenario, wrong_behavior, expected_behavior}`.

That last one is the answer to "is this task fair?" and it had no path to a viewer.

---

## Layer 2 — losses inside the pack (NOT fixable from the pack)

These are capture-time losses. The exporter surfaces them instead of hiding them.

### 2a. `codex_transcript` is truncated to its last ~59 KB

41 of 76 transcripts sit at 58–59.3 KB. Consequence:

| | |
|---|---|
| `command_result` events (every command) | **1,039** |
| `exec` blocks surviving in transcripts | **396** |
| commands with captured stdout | **395 (38 %)** |
| commands with no output anywhere in the pack | **644 (62 %)** |

Worst case `electrum-mine-0a1977a7`: 126 commands, 2 with output. In the explorer
those 644 calls carry an explicit `output not captured` result rather than
disappearing, so the timeline still matches the real step count.

### 2b. `command_result` never stores output

Its payload is `{command}` and nothing else — no stdout, no stderr, no exit code,
no duration. Everything a viewer needs about *what happened* lives only in the
transcript, which is the thing that gets truncated.

### 2c. `command_result` truncates multi-line commands at the first line

**340 of 1,039** commands are stored as just their first line — e.g.
`... bash -lc 'python - <<"PY"` (88 chars), with the whole heredoc body gone.
The exporter matches these against the transcript by prefix and restores the full
text where the transcript survived; for the other ~62 % the command body is
unrecoverable.

### 2d. 7 runs have a 0-byte `trace.jsonl`

`relay unreachable` ×7 and `agent error: relay rate limited` ×1. They are exported
with a `system` event stating the verdict, so the run count stays honest at 83.

### 2e. No per-step token accounting

The transcript carries one `tokens used` footer per run (45 runs). There is no
prompt/cached/output split and no per-step usage anywhere, so the token panel is
flagged `tokenUsageEstimated` and the cached/uncached/output bars stay empty.

---

## Layer 1 — mining-run artifacts still outside all of this

Present in `mining_v148*/` but in neither the pack nor the page. Not lost, just not
wired up: `manifests/01_discover_pairs` (repo/window/language/verified-instance
counts), the `.dropped.jsonl` companion of every stage (**why** a candidate was
rejected; in `mining_v148early_20260911`: 244 mined → 140 gated → 66 suite-flip-verified → 33 packaged), `stream/*/tasks.jsonl`
(`schema`, `provenance`, `judge`, `language`), `llm_cache/`, `events.jsonl`,
`ledger.json`, `flow/progress.json`.

The drop reasons are the most useful of these: they are the yield story of the
pipeline, and today they exist only as JSONL on the shared filesystem.

---

## Known imperfection in the transcript parser

Codex writes stdout and its own reasoning to the same stream with no delimiter —
only a blank line separates the tail of a command's output from the reasoning
paragraph that follows. The parser splits on a prose heuristic (trailing paragraphs
that read as English and match no shell-output pattern). Spot checks put it near
90 %; a few reasoning fragments stay glued to the end of a `tool_result`, and a
short prose line can occasionally be absorbed as output. It is a heuristic on an
ambiguous stream, not a parse of a structured log. The fix belongs upstream: have
the harness record codex's JSONL session rollout instead of its rendered stdout.
