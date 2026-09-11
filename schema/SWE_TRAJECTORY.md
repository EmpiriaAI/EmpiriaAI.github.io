# SWE trajectory field interface — `swe-trajectory/1.0`

The contract between a producer (mining run + agent harness) and the two
trajectory viewers on this site, `trajectory-explorer.html` and
`trajectory-dialogue.html`. Machine-readable form:
[`swe-trajectory.schema.json`](swe-trajectory.schema.json). Produced by
`tools/export-swe-trajectories.py`.

Both viewers concatenate three globals — `EMPIRIA_RAW_TRAJECTORIES`
(`trajectory-data.js`: two feedback runs and the django__django-11119 SWE run),
`EMPIRIA_SWE_TRAJECTORIES` (`swe-trajectory-data.js`, this schema) and
`EMPIRIA_FEEDBACK_SNAPSHOTS` (lazy) — into one array, routed by `trajectoryClass`.
The django run is the reference shape: every rollout in `swe-trajectory-data.js`
follows its conventions (`kind` on every event, `returnCode` on results,
`kindCounts` / `statusCounts`, `"Reward 1.0"`, `"n / N"` FAIL_TO_PASS,
`"x passed · y failed"` test tallies). **Every field below is optional**; a viewer that finds `null` hides
the row rather than printing a hole. That is the whole point of writing the
interface first: a producer can start filling a field at any time and it lights
up with no viewer change.

Status column:

- **A** — filled today, read by a viewer today
- **B** — filled today from pack files that previously had no field
- **C** — **interface written, producer does not emit it yet.** Fill it and it renders.

---

## 1. Run object

| Path | Type | Status | Drives |
|---|---|---|---|
| `id` | string | A | stable run key, `<task>--<stamp>` |
| `shortId` | string | A | sidebar label, two-lane deep link (`?run=<shortId>`) — must be unique per run |
| `title` | string | A | run headline |
| `trajectoryClass` | `"swe"` | A | **category routing — omit it and nothing renders** |
| `situation` | `"successful"｜"failed"` | A | status pill, sidebar dot, outcome filter |
| `score` | string | A | Reward metric |
| `model` / `agent` / `serviceTier` | string | A | header meta, run-source rail |
| `dataSource` / `conversationId` | string | A | provenance line |
| `snapshotLabel` | string | A | `run 2/3` when a task has several rollouts |
| `report` | string | A | one-line verdict summary |
| `messageCount` / `eventCount` / `toolCallCount` / `agentStepCount` | int | A | metric strip |
| `counts` | `{user, thinking, assistant, tool_call, tool_result, context, system}` | A | filter-bar counters (both viewers) |
| `kindCounts` / `statusCounts` | `{[kind]: int}` / `{[status]: int}` | A | the two-lane reader's corpus overview ranks runs by these without walking events; `missing` is kept out of its fail-rate denominator |
| `toolCounts` | `{[tool]: int}` | A | per-tool histogram |
| `errorRate` | float | A | error-rate metric |
| `tokenUsage` | object, §4 | A/C | token panel + two-lane token bar |
| `tokenUsageEstimated` | bool | A | switches the token panel to "estimated" |
| `captureCoverage` | float | B | fraction of tool calls with real output |
| `capture` | object, §5 | B | declares what the producer did and did not record |
| `environment` | object, §2 | A/B/C | Environment / Task / Verification panels, run-source rail |
| `events` | array, §3 | A | the timeline and the two lanes |
| `valueTier` | string | C | value-tier chip (no SWE meaning yet) |
| `pipelineDetail` | object | C | two-lane "quality pipeline" rail group |

## 2. `environment`

**Task identity — A**
`benchmark`, `task`, `taskName`, `repository`, `baseCommit`, `version`, `difficulty`,
`taskCategory`, `issue` (full instruction), `taskSummary` (one-line deliverable).

**Runtime — A**
`runtime`, `os`, `architecture`, `image`, `workdir`, `cpu`, `memory`, `storage`,
`internet`, `agent`, `model`, `verifier`.

**Outcome — A**
`reward`, `resolved`, `outcome`, `verdict`, `tests`, `duration`, `agentDuration`,
`verifierDuration`, `verifierRc`, `suiteRc`, `gradedBy`, `steps`, `codexRc`,
`stoppedBecause`, `exception`, `patchExists`, `patchApplied`, `failToPass`, `passToPass`.

**Two-arm gate — B**
`gateEmptyRc`, `gateEmptyReward`, `gateOracleRc`, `gateOracleReward`,
`gateEmptyTail`, `gateOracleTail`.

**Oracle & tests — B**
`goldFiles`, `goldAdd`, `goldDel`, `patchLines`, `hiddenTests`, `solveCommand`,
`testEntry`, `dockerfileLines`, `buildCommand`, `baseTarball`.

**Mining provenance — B** (joined from `mining_v148*/manifests/{01..10}`)
`provInstanceId`, `provRoute`, `provShape`, `provTestOrigin`, `provStatementOrigin`,
`provWithheld`, `provHarborRef`, `provImageDigest`, `provAuthor`, `provAuthorDate`,
`provIssueRefs`, `provIssueTracker`, `provParent`, `provIsMerge`, `provRepoUrl`,
`provBucket`, `provGoldDigest`, `provTestDigest`, `provGoldFiles`, `provTestFiles`,
`provEvidence{base_rc, broken_rc, fixed_rc, gold_patch_rc, test_patch_rc, tree_rc}`,
`provJudge`, `provStatementMeta`, `provStatementTitle`, `provStats`, `provSwebench`,
`language`, `miningWindow`, `verifiedInstancesTotal`, `commitStats`.

**Rail plumbing — A/C**
`conversationId`, `snapshot`, `sourceFile`, `runOrdinal`, `runsForTask` (A);
`requestId` (**C** — needs the relay request id threaded through).

**Lifecycle — A/C**
`agentDuration`, `verifierDuration` (A);
`environmentSetupDuration`, `agentSetupDuration` (**C** — the runner knows these,
it just never writes them; they complete the four-stage lifecycle bar).

## 3. `events[]`

| Path | Type | Status | Notes |
|---|---|---|---|
| `type` | `user｜system｜context｜thinking｜assistant｜tool_call｜tool_result` | A | left lane: user/system/context/tool_result · right lane: thinking/assistant/tool_call |
| `sourceIndex` | int | A | stable index, used by the annotation sidebar |
| `title` / `summary` / `content` | string | A | header, preview, body |
| `kind` | see schema enum | A | exported explicitly; the reader only derives it for old snapshots |
| `returnCode` | int | A | `0` when the harness reported success, `null` when unknown |
| `status` | `success｜error｜timeout｜rejected｜missing` | A | `error/timeout/rejected` count as failures; **`missing` = capture gap, deliberately not a failure** |
| `timestamp` | ISO-8601 | A/C | today only on `tool_call` (from `command_result`); **C** for every other type |
| `toolCallId` / `toolName` / `target` | string | A | call↔result pairing, tool histogram, cwd/step |
| `stepMetrics` | `{prompt, cached, output, reasoning}` | **C** | renders a per-step token strip in the linear viewer — **the single highest-value missing field** |
| `exitCode` / `durationMs` | int | B/C | duration is parsed from the transcript for 395 calls; exit code is inferred from `succeeded｜failed` and should be recorded verbatim |
| `filesChanged` | string[] | **C** | files the workspace gained/lost after this call — enables a workspace timeline |
| `contextTokens` | int | **C** | prompt size at this step — makes compaction visible |

## 4. `tokenUsage`

`total` (A, run total from the transcript footer, 45/83 runs) ·
`cachedInput`, `uncachedInput`, `cacheWrite`, `output`, `thinkingTokens`,
`promptTokens`, `rawInput`, `requestId`, `serviceTier` (**all C**) ·
`source` (A, free text naming where the number came from).

Both viewers already draw a three-segment composition bar from
`cachedInput / uncachedInput / output`. It is empty today only because nothing
records them.

## 5. `capture` — the honesty block

```json
{
  "schemaVersion": "swe-trajectory/1.0",
  "producer": "swe-task-forge/minions mining-v1.2.0 + codex harness",
  "commandsRecorded": 44, "commandsWithOutput": 12,
  "transcriptChars": 59113, "transcriptTruncated": true,
  "available": {
    "perStepTokens": false, "fullCommandOutput": false, "structuredRollout": false,
    "agentFinalDiff": false, "perTestResults": false, "relayEnvelope": false,
    "fileMutations": false, "samplingParams": false,
    "eventTimestamps": "tool_call only", "contextWindowPerStep": false
  }
}
```

A viewer reads `available` to decide between *"this run had no reasoning"* and
*"this producer does not record reasoning"*. Those are very different statements
and today's data cannot tell them apart without it.

---

## 6. Tier C — what to start storing

Ordered by visualisation value per unit of producer work. Each one has a field
above waiting for it.

| # | Store | Where it comes from | Unlocks |
|---|---|---|---|
| 1 | **Per-step token usage** → `events[].stepMetrics`, `tokenUsage.*` | the provider response `usage` block on every call | per-step token strip, real composition bar, cost-per-step curves, context-growth charts |
| 2 | **Full stdout/stderr per command** → `command_result.payload.{stdout, stderr, exit_code, duration_ms}` | the runner already has them; it writes only `command` | closes the 62 % hole — 644 of 1039 calls currently have no output anywhere |
| 3 | **Structured rollout** → codex JSONL session file instead of rendered stdout | `~/.codex/sessions/*.jsonl` | removes the prose-vs-stdout heuristic entirely; exact message boundaries |
| 4 | **Agent final diff** → `environment.agentPatch` (+ `agentPatchFiles`, `agentPatchAdd/Del`) | `git diff` in the workspace when the run ends | agent-patch vs gold-patch side by side — the thing you actually want to look at on a failure |
| 5 | **Per-test results** → `environment.testResults[] {id, arm, status, duration}` | the verifier already runs pytest; parse `-rA` / junit-xml instead of keeping the tail | which test flipped and when; real F2P/P2P sets instead of "1 failing on empty patch" |
| 6 | **Relay envelope** → `environment.relay{attempts, lastStatus, rateLimited, retryAfter}` | the relay client | 8 of 83 runs died here and today that is one line of prose |
| 7 | **Sampling params** → `environment.sampling{temperature, topP, maxTokens, reasoningEffort, seed}` | the harness config | makes runs comparable; without it a reward delta is unattributable |
| 8 | **Timestamps on every event** → `events[].timestamp` | the harness clock | a real time axis instead of step ordinals; idle-gap detection |
| 9 | **File mutations per call** → `events[].filesChanged` | `git status --porcelain` after each call | workspace timeline; catches "edited the test file" cheating live |
| 10 | **Setup durations** → `environment.{environmentSetupDuration, agentSetupDuration}` | the runner | completes the four-stage lifecycle bar (two of four stages are blank today) |

Items 1–3 are the ones that change what the viewers can show. 4 and 5 are the
ones that change what a *reviewer* can conclude.
