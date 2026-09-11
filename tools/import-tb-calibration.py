#!/usr/bin/env python3
"""Import Terminal-Bench (Harbor-format) calibration attempts into the trajectory pages.

A tb pack (e.g. tb_calibrated_pack_20260909) records each calibration attempt only
as a verdict and the agent's final summary. The attempts themselves were Claude
Code sessions, and the full session logs stay with the CLI that ran them. This
matches every attempt to its session and exports the whole run.

    python3 tools/import-tb-calibration.py \\
        --pack     /path/to/tb_calibrated_pack_20260909 \\
        --sessions ~/.claude/projects \\
        --redact   ~/.config/swe-export-redact.tsv        # optional, not in git

Writes tb-trajectory-index.js (window.EMPIRIA_TB_TRAJECTORIES; bodies lazy) and
data/tb-trajectories/<id>.json. Messages go through the feedback importer's own
build_events(), so kinds, statuses and redaction match the feedback corpus.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import difflib
import importlib.util
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "tb-trajectories"
INDEX_FILE = ROOT / "tb-trajectory-index.js"

_spec = importlib.util.spec_from_file_location("feedback_importer", ROOT / "tools" / "import-feedback-snapshots.py")
feedback = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(feedback)

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--pack", required=True, help="unpacked tb pack (tasks/<name>/{task,calibration,image.json})")
ap.add_argument("--sessions", default=str(Path.home() / ".claude" / "projects"),
                help="Claude Code projects directory holding the calibration sessions")
ap.add_argument("--redact", help="optional file of extra 'regex<TAB>replacement' lines (keep it out of git)")
ARGS = ap.parse_args()

# ---------------------------------------------------------------- redaction
# The feedback importer already strips keys, tokens, routable IPs and mail
# addresses. Calibration sessions add paths from the machines they ran on.
SCRUB = [
    (re.compile(r"/mnt/shared-storage-user/[^/\s\"']+/[^/\s\"']+"), "/shared"),
    (re.compile(r"\.claude/projects/[^/\s\"']+"), ".claude/projects/<project>"),   # dash-encoded local paths
    (re.compile(r"/private/tmp/claude-\d+(?:/[^\s\"']*)?"), "<local-scratch>"),
    (re.compile(r"/Users/[^/\s\"']+"), "~"),
    (re.compile(r"\bharbor\.[\w.-]+/"), ""),
]
if ARGS.redact:
    for line in open(ARGS.redact, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            pat, _, rep = line.rstrip("\n").partition("\t")
            SCRUB.append((re.compile(pat), rep))


def scrub(text):
    if not isinstance(text, str):
        return text
    for pattern, replacement in SCRUB:
        text = pattern.sub(replacement, text)
    return text


def scrub_all(value):
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, list):
        return [scrub_all(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub_all(v) for k, v in value.items()}
    return value


def iso(stamp):
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def family(model):
    model = model or ""
    return "opus" if "opus" in model else "haiku" if "haiku" in model else model


# ---------------------------------------------------------------- sessions
def _flatten(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif isinstance(block, str):
            parts.append(block)
    return "\n".join(parts)


def session_messages(path):
    """Claude Code session JSONL -> the role/content/tool_calls shape build_events takes.

    One API response is written as several rows sharing message.id, one row per
    content block; they are merged back into a single assistant message."""
    rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    rows = [r for r in rows if r.get("type") in ("user", "assistant") and not r.get("isSidechain")]
    messages, current = [], None
    for row in rows:
        message = row.get("message") or {}
        blocks = message.get("content")
        if row["type"] == "assistant":
            blocks = [b for b in (blocks or []) if isinstance(b, dict)]
            if current is not None and current["_id"] == message.get("id"):
                current["_blocks"].extend(blocks)
                current["_usage"] = message.get("usage") or current["_usage"]
                continue
            current = {"role": "assistant", "_id": message.get("id"), "_blocks": list(blocks),
                       "_usage": message.get("usage"), "_ts": row.get("timestamp"),
                       "_model": message.get("model"), "_request": row.get("requestId")}
            messages.append(current)
            continue
        current = None
        if isinstance(blocks, str):
            messages.append({"role": "user", "content": blocks, "_ts": row.get("timestamp")})
            continue
        texts = []
        for block in blocks or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                messages.append({"role": "tool", "tool_call_id": block.get("tool_use_id", ""),
                                 "content": _flatten(block.get("content")),
                                 "is_error": bool(block.get("is_error")), "_ts": row.get("timestamp")})
            elif block.get("type") == "text":
                texts.append(block.get("text", ""))
        if texts:
            messages.append({"role": "user", "content": "\n".join(texts), "_ts": row.get("timestamp")})
    for message in messages:
        if message["role"] != "assistant":
            continue
        blocks = message.pop("_blocks")
        message["content"] = [b for b in blocks if b.get("type") in feedback.REASONING_BLOCKS | {"text"}]
        message["tool_calls"] = [
            {"id": b.get("id", ""), "function": {"name": b.get("name", "Tool"),
                                                 "arguments": json.dumps(b.get("input", {}), ensure_ascii=False)}}
            for b in blocks if b.get("type") == "tool_use"]
    return messages


def session_summary(path):
    messages = session_messages(path)
    stamps = [m["_ts"] for m in messages if m.get("_ts")]
    first_user = next((m["content"] for m in messages if m["role"] == "user"), "")
    finals = [feedback._block_text(b) for m in messages if m["role"] == "assistant"
              for b in m["content"] if b.get("type") == "text"]
    return {
        "path": path, "id": Path(path).stem, "messages": messages,
        "model": next((m["_model"] for m in messages if m["role"] == "assistant" and m.get("_model")), None),
        "seconds": (iso(stamps[-1]) - iso(stamps[0])).total_seconds() if len(stamps) > 1 else 0,
        "final": re.sub(r"\s+", " ", finals[-1]).strip() if finals else "",
        "is_agent": first_user.lstrip().startswith("You are the coding agent"),
    }


# ---------------------------------------------------------------- commands
# Calibration agents reach the task container through
#   ssh <host> 'DOCKER_HOST=… docker exec -w /workspace <ctr> bash -lc "<command>"'
_SSH = re.compile(r"^ssh\s+(\S+)\s+(.*)$", re.S)
# any program may follow the container: bash -lc "…", python -c "…", ls -la, cat > f << EOF …
_EXEC = re.compile(r"^(docker exec(?: -[a-zA-Z]+(?: (?!(?:bash|sh)\b)[^\s'\"]+)?)*) (\S+) (.*)$", re.S)
_SHELL_C = re.compile(r"^(?:bash|sh) -l?c (.*)$", re.S)


def _unquote_head(text):
    """Unquote a leading '…' or "…" token and keep whatever follows it (a heredoc, say)."""
    text = text.strip()
    if text[:1] == '"':
        m = re.match(r'^"((?:[^"\\]|\\.)*)"(.*)$', text, re.S)
        if m:
            return re.sub(r'\\([\\"$`])', r"\1", m.group(1)) + m.group(2)
    if text[:1] == "'":
        m = re.match(r"^'((?:[^']|'\"'\"'|'\\'')*)'(.*)$", text, re.S)
        if m:
            return m.group(1).replace("'\"'\"'", "'").replace("'\\''", "'") + m.group(2)
    return text


_SSH_ARG_OPTS = set("bcDEeFIiJLlmOoPpQRSWw")     # ssh options that take a value


def _split_ssh(command):
    """ssh [-opts] host [remote…] -> (host, remote) or (None, None)."""
    m = re.match(r"^ssh\s+(.*)$", command.strip(), re.S)
    if not m:
        return None, None
    rest = m.group(1)
    while True:
        opt = re.match(r"^-(\w+)(?:\s+|$)", rest)
        if not opt:
            break
        rest = rest[opt.end():]
        if opt.group(1)[-1] in _SSH_ARG_OPTS and len(opt.group(1)) == 1:
            rest = re.sub(r"^\S+\s*", "", rest, count=1)
    host = re.match(r"^([^\s'\"<]+)\s*(.*)$", rest, re.S)
    return (host.group(1), host.group(2)) if host else (None, None)


def unwrap(command):
    """-> (inner command, invocation) or (None, None) when it is not an ssh command."""
    host, remote = _split_ssh(command)
    if host is None:
        return None, None
    remote = re.sub(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+", "", _unquote_head(remote))
    inner = _EXEC.match(remote)
    if inner:
        shell = _SHELL_C.match(inner.group(3))
        body = _unquote_head(shell.group(1)) if shell else inner.group(3)
        return body.strip(), f"ssh {host} → {inner.group(1)}"
    if re.search(r"\bdocker\s+exec\b", remote):
        # a script run on the host (often fed as a heredoc) that drives the container
        return remote.strip(), f"ssh {host} → host script that runs docker exec"
    return remote.strip(), f"ssh {host} — on the host, outside the task container"


def program_of(command):
    text = (command or "").strip()
    while True:
        m = re.match(r"^(?:set\s+-[A-Za-z]+|cd\s+\S+)\s*(?:;|&&|\n)\s*", text)
        if not m:
            break
        text = text[m.end():]
    text = re.sub(r"^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+", "", text)
    token = re.match(r"[^\s;|&<>()]+", text)
    return os.path.basename(token.group(0)) if token else "shell"


# ---------------------------------------------------------------- task files
def read(path, default=""):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return default


def toml_lite(text):
    out, section = {}, None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = out.setdefault(line[1:-1], {})
            continue
        if "=" in line and section is not None:
            key, value = (part.strip() for part in line.split("=", 1))
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            elif value in ("true", "false"):
                value = value == "true"
            else:
                try:
                    value = int(value)
                except ValueError:
                    pass
            section[key] = value
    return out


def tally(text):
    """Sum every suite summary in a verifier log -> 'x passed · y failed[ · z skipped]'.

    Handles pytest, node:test, cargo and minitest; a hidden suite often runs
    several of them one after another."""
    text = text or ""
    passed = failed = skipped = 0
    found = False
    for m in re.finditer(r"(\d+) runs?, \d+ assertions?, (\d+) failures?, (\d+) errors?(?:, (\d+) skips?)?", text):
        runs, fail, err, skip = (int(g or 0) for g in m.groups())
        passed += runs - fail - err - skip; failed += fail + err; skipped += skip; found = True
    for m in re.finditer(r"test result: \w+\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?", text):
        passed += int(m.group(1)); failed += int(m.group(2)); skipped += int(m.group(3) or 0); found = True
    for m in re.finditer(r"^# pass (\d+)\s*\n# fail (\d+)", text, re.M):
        passed += int(m.group(1)); failed += int(m.group(2)); found = True
    for m in re.finditer(r"^=+ (.*?(?:passed|failed|error).*?) in [\d.]+s", text, re.M):
        line = m.group(1)
        for key, pattern in (("p", r"(\d+) passed"), ("f", r"(\d+) failed"), ("e", r"(\d+) errors?"), ("s", r"(\d+) skipped")):
            hit = re.search(pattern, line)
            if not hit:
                continue
            value = int(hit.group(1))
            if key == "p": passed += value
            elif key in ("f", "e"): failed += value
            else: skipped += value
        found = True
    if not found:
        return None
    return f"{passed} passed · {failed} failed" + (f" · {skipped} skipped" if skipped else "")


LANGUAGE = {".ts": "TypeScript", ".py": "Python", ".rs": "Rust", ".rb": "Ruby", ".go": "Go",
            ".js": "JavaScript", ".php": "PHP", ".java": "Java"}


# ---------------------------------------------------------------- matching
def match_attempts(attempts, sessions):
    """Pair each attempt with the session that produced it.

    Pass 1 needs text evidence: the attempt's saved final summary against the
    session's last message (2·similarity + duration closeness), global greedy.
    Pass 2 covers attempts that ended without a summary (timeouts): same model,
    duration within 15 %, closest first. Sessions left over are runs the
    driver aborted and restarted; they were never scored and are not exported."""
    def closeness(a, s):
        return 1 - min(abs(s["seconds"] - a["seconds"]) / max(a["seconds"], 1), 1) if a["seconds"] else None

    pairs, used_a, used_s = {}, set(), set()
    scored = []
    for a in attempts:
        for s in sessions:
            if family(s["model"]) != family(a["model"]) or not (a["transcript"] and s["final"]):
                continue
            text = difflib.SequenceMatcher(None, a["transcript"][-600:], s["final"][-600:]).ratio()
            c = closeness(a, s)
            scored.append((2 * text + (0.5 if c is None else c), text, a["label"], s["path"]))
    for score, text, label, path in sorted(scored, reverse=True):
        if score < 1.2 or text < 0.35 or label in used_a or path in used_s:
            continue
        pairs[label] = (path, round(score, 2))
        used_a.add(label); used_s.add(path)

    by_duration = []
    for a in attempts:
        if a["label"] in used_a or not a["seconds"]:
            continue
        for s in sessions:
            if s["path"] in used_s or family(s["model"]) != family(a["model"]):
                continue
            c = closeness(a, s)
            if c is not None and c >= 0.85:
                by_duration.append((c, a["label"], s["path"]))
    for c, label, path in sorted(by_duration, reverse=True):
        if label in used_a or path in used_s:
            continue
        pairs[label] = (path, round(c, 2))
        used_a.add(label); used_s.add(path)

    # Pass 3: a hand-run attempt with neither summary nor duration still pairs
    # when its model left exactly one session behind.
    for a in attempts:
        if a["label"] in used_a:
            continue
        left = [s for s in sessions if s["path"] not in used_s and family(s["model"]) == family(a["model"])]
        if len(left) == 1:
            pairs[a["label"]] = (left[0]["path"], "only session")
            used_a.add(a["label"]); used_s.add(left[0]["path"])
    return pairs


# ---------------------------------------------------------------- export
def export_task(task_dir, all_sessions):
    name = task_dir.name
    task = toml_lite(read(task_dir / "task" / "task.toml"))
    meta, env_cfg = task.get("metadata", {}), task.get("environment", {})
    results = json.loads(read(task_dir / "calibration" / "results.json", "{}") or "{}")
    image = json.loads(read(task_dir / "image.json", "{}") or "{}")
    gate = json.loads(read(task_dir / "task" / "GATE.json", "{}") or "{}")
    instruction = read(task_dir / "task" / "instruction.md")
    hidden = sorted(p.name for p in (task_dir / "task" / "tests" / "hidden").glob("*"))
    suite = read(task_dir / "task" / "tests" / "suite.sh")
    solve = read(task_dir / "task" / "solution" / "solve.sh")
    dockerfile = read(task_dir / "task" / "environment" / "Dockerfile")
    desc = task.get("task", {}).get("description", "")
    repo = (re.search(r"\bin\s+([\w.-]+/[\w.-]+)", desc) or [None, None])[1]
    title = instruction.split("\n", 1)[0].lstrip("# ").strip() or name
    carved = meta.get("carved_file", "")

    attempts_dir = task_dir / "calibration" / "attempts"
    attempts = []
    for record in sorted(attempts_dir.glob("*.json")):
        data = json.loads(read(record))
        label = record.stem
        attempts.append({"label": label, "model": data.get("model"), "trial": data.get("trial"),
                         "seconds": data.get("seconds") or 0, "verdict": data.get("verdict"),
                         "said_done": data.get("said_done"), "agent_rc": data.get("agent_rc"),
                         "verifier_rc": data.get("verifier_rc"), "reward": data.get("reward"),
                         "transcript": re.sub(r"\s+", " ", read(attempts_dir / f"{label}.transcript.txt")).strip()})
    if results.get("manual"):
        # hand-run task: results.json carries the verdicts, attempts/ only the transcripts
        for key in ("strong", "weak"):
            arm = results.get(key) or {}
            label = f'{family(arm.get("model"))}-1'
            if not arm or any(a["label"] == label for a in attempts):
                continue
            attempts.append({"label": label, "model": arm.get("model"), "trial": 1, "seconds": 0,
                             "verdict": "SOLVED" if arm.get("solved") else "NOT SOLVED",
                             "said_done": None, "agent_rc": None, "verifier_rc": None,
                             "reward": 1.0 if arm.get("solved") else 0.0,
                             "hidden_pass": arm.get("hidden_pass"),
                             "transcript": re.sub(r"\s+", " ", read(attempts_dir / f"{label}.transcript.txt")).strip()})

    key = results.get("task_id", "").replace("__", "--").replace("_", "-").lower()
    slug = (repo or "").split("/")[0].lower()
    sessions = [s for s in all_sessions if s["is_agent"] and (
        (s["dir_key"] and key.startswith(s["dir_key"])) or
        (not s["dir_key"] and slug and slug in s["head"].lower()))]
    pairs = match_attempts(attempts, sessions)

    strong, weak = results.get("strong") or {}, results.get("weak") or {}
    roster = [f'{a["label"]} {a["verdict"]}' + (f' · {a["seconds"]}s' if a["seconds"] else "") for a in attempts]
    index_rows, missing = [], []
    for a in attempts:
        if a["label"] not in pairs:
            missing.append(a["label"])
            continue
        path, score = pairs[a["label"]]
        s = next(x for x in sessions if x["path"] == path)
        rows = export_run(name, title, a, s, score, dict(
            task=task, meta=meta, env_cfg=env_cfg, results=results, image=image, gate=gate,
            instruction=instruction, hidden=hidden, suite=suite, solve=solve, dockerfile=dockerfile,
            repo=repo, carved=carved, strong=strong, weak=weak, roster=roster))
        index_rows.append(rows)
    return index_rows, missing


def export_run(name, title, a, s, score, ctx):
    messages = s["messages"]
    events, counts, tool_counts, kind_counts, status_counts = feedback.build_events(messages)

    # timestamps, per-step token accounting, and the command behind each Bash call
    usage_total = collections.Counter()
    first_event_of = {}
    for event in events:
        first_event_of.setdefault(event["sourceIndex"], event)
        message = messages[event["sourceIndex"]]
        if message.get("_ts"):
            event["timestamp"] = message["_ts"]
        event["content"] = scrub(event.get("content"))
        if event.get("summary"):
            event["summary"] = scrub(event["summary"])
        if event["type"] == "tool_call" and event.get("title") == "Bash":
            try:
                command = json.loads(event["content"]).get("command", "")
            except (ValueError, AttributeError):
                command = ""
            inner, invocation = unwrap(command) if command else (None, None)
            if inner:
                event["command"], event["invocation"] = inner, invocation
                event["toolName"] = "Bash"
                event["title"] = program_of(inner)
                event["summary"] = re.sub(r"\s+", " ", inner)[:180]
    steps = 0
    for index, message in enumerate(messages):
        if message["role"] != "assistant" or not message.get("_usage"):
            continue
        steps += 1
        u = message["_usage"]
        thinking = (u.get("output_tokens_details") or {}).get("thinking_tokens", 0)
        prompt = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
        usage_total.update(uncached=u.get("input_tokens", 0), cached=u.get("cache_read_input_tokens", 0),
                           write=u.get("cache_creation_input_tokens", 0), output=u.get("output_tokens", 0),
                           thinking=thinking, prompt=prompt)
        if index in first_event_of:
            first_event_of[index]["stepMetrics"] = {"prompt": prompt, "cached": u.get("cache_read_input_tokens", 0),
                                                    "output": u.get("output_tokens", 0), "reasoning": thinking}

    # produced around the run and never shown to the agent: the two-lane reader
    # keeps these out of both lanes
    hidden_output = read(Path(ARGS.pack) / "tasks" / name / "calibration" / "attempts" / f'{a["label"]}.hidden_suite_output.txt')
    for title_, text in (("Verifier suite.log", hidden_output), ("Oracle solve.sh", ctx["solve"]),
                         ("Task Dockerfile", ctx["dockerfile"])):
        if text.strip():
            events.append({"type": "context", "kind": "evaluation", "sourceIndex": len(messages) + len(events),
                           "title": title_, "content": scrub(text[-12000:]),
                           "summary": tally(text) if title_.startswith("Verifier") else None})
    for n, event in enumerate(events):
        event["sourceIndex"] = n

    results = [e for e in events if e["type"] == "tool_result"]
    failed = [e for e in results if e.get("status") in ("error", "timeout", "rejected")]
    solved = a["verdict"] == "SOLVED"
    total_tokens = usage_total["prompt"] + usage_total["output"]
    fam = family(a["model"])
    run_id = f'tb-{name}-{a["label"]}'
    env = {
        "family": "Terminal-Bench task environment",
        "benchmark": "Harbor · carve_b2_20260906", "task": name,
        "taskName": ctx["task"].get("task", {}).get("name"), "repository": ctx["repo"],
        "version": ctx["meta"].get("variant"), "difficulty": ctx["results"].get("grade"),
        "runtime": "Docker · Linux · offline", "os": "Linux", "architecture": "x86_64",
        "image": ctx["image"].get("image"), "workdir": ctx["env_cfg"].get("workdir"),
        "cpu": f'{ctx["env_cfg"].get("cpus")} cores' if ctx["env_cfg"].get("cpus") else None,
        "memory": f'{ctx["env_cfg"].get("memory_mb")} MB' if ctx["env_cfg"].get("memory_mb") else None,
        "storage": f'{ctx["env_cfg"].get("storage_mb")} MB' if ctx["env_cfg"].get("storage_mb") else None,
        "internet": "Blocked" if ctx["env_cfg"].get("allow_internet") is False else "Allowed",
        "agent": "Claude Code", "model": a["model"], "serviceTier": None,
        "verifier": "tests/test.sh → repository suite",
        "reward": f'{float(a["reward"]):.1f}' if a["reward"] is not None else None,
        "resolved": "true" if solved else "false", "verdict": a["verdict"], "outcome": a["verdict"],
        "tests": tally(hidden_output) or (f'{a.get("hidden_pass")} hidden tests passed' if a.get("hidden_pass") else None),
        "duration": a["seconds"] or round(s["seconds"]), "agentDuration": round(s["seconds"]),
        "issue": ctx["instruction"], "taskCategory": ctx["meta"].get("category"),
        "patchTarget": ctx["carved"], "regressionTest": ", ".join(ctx["hidden"]) or None,
        # the CLI writes its own failure ("Error: Reached max turns (60)") where a summary would be
        "exception": None if solved else (a["transcript"] if a["transcript"].startswith("Error:")
                                          else "agent stopped without saying DONE" if a.get("said_done") is False
                                          else "hidden suite failed"),
        "stoppedBecause": ("said DONE" if a.get("said_done") else "did not say DONE") if a.get("said_done") is not None else None,
        "verifierRc": a.get("verifier_rc"), "gradedBy": "repository suite (hidden tests restored)",
        "gateEmptyRc": ctx["gate"].get("empty", {}).get("rc"), "gateEmptyReward": ctx["gate"].get("empty", {}).get("reward"),
        "gateOracleRc": ctx["gate"].get("oracle", {}).get("rc"), "gateOracleReward": ctx["gate"].get("oracle", {}).get("reward"),
        "language": LANGUAGE.get(Path(ctx["carved"]).suffix), "carvedLines": ctx["meta"].get("carved_lines"),
        "hiddenTests": ctx["hidden"],
        "calGrade": ctx["results"].get("grade"),
        "calWhy": ctx["results"].get("why") if isinstance(ctx["results"].get("why"), str)
                  else " · ".join(ctx["results"].get("why") or []),
        "calStrong": f'{ctx["strong"].get("model")} {ctx["strong"].get("solved")}/{ctx["strong"].get("total")}' if ctx["strong"] else None,
        "calWeak": f'{ctx["weak"].get("model")} {ctx["weak"].get("solved")}/{ctx["weak"].get("total")}' if ctx["weak"] else None,
        "calJudgeSuspect": ctx["results"].get("judge_suspect", ctx["results"].get("spec_suspect")),
        "calTrial": a.get("trial"), "calSaidDone": a.get("said_done"), "calAgentRc": a.get("agent_rc"),
        "calAttempts": ctx["roster"], "calMatchScore": score,
        "agentUser": "root (calibration ran without the task's agent user)",
        "conversationId": s["id"], "sourceFile": f'tasks/{name}/calibration/attempts/{a["label"]}.json',
    }
    row = {
        "id": run_id, "shortId": f'{name}-{a["label"]}', "title": title,
        "trajectoryClass": "terminal", "category": "Terminal-Bench", "taskType": "code_restoration",
        "situation": "successful" if solved else "failed",
        "score": env["reward"] and f'Reward {env["reward"]}', "valueTier": ctx["results"].get("grade"),
        "model": a["model"], "agent": "Claude Code", "dataSource": "tb_calibrated_pack_20260909",
        "snapshotLabel": f'{fam} trial {a.get("trial") or 1}', "conversationId": s["id"],
        "report": f'{a["verdict"]} · {env["duration"]}s · {counts.get("tool_call", 0)} tool calls',
        "messageCount": len(events), "eventCount": len(events),
        "toolCallCount": counts.get("tool_call", 0), "agentStepCount": steps,
        "estimatedTokens": total_tokens,
        "tokenUsage": {"total": total_tokens, "promptTokens": usage_total["prompt"],
                       "cachedInput": usage_total["cached"], "uncachedInput": usage_total["uncached"],
                       "cacheWrite": usage_total["write"], "output": usage_total["output"],
                       "thinkingTokens": usage_total["thinking"], "source": "claude-code session usage",
                       "requestId": next((m.get("_request") for m in messages if m.get("_request")), None)},
        "tokenUsageEstimated": False,
        "errorRate": round(len(failed) / len(results), 4) if results else None,
        "counts": dict(collections.Counter(e["type"] for e in events)),
        "toolCounts": tool_counts,
        "kindCounts": dict(collections.Counter(e["kind"] for e in events)),
        "statusCounts": dict(collections.Counter(e.get("status") or "success" for e in results)),
        "environment": env, "events": None,
        "lazyData": f"data/tb-trajectories/{run_id}.json",
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{run_id}.json").write_text(json.dumps({"events": scrub_all(events)}, ensure_ascii=False,
                                                       separators=(",", ":")), encoding="utf-8")
    return scrub_all(row)


def main():
    root = Path(ARGS.sessions).expanduser()
    all_sessions = []
    for project in sorted(root.iterdir()):
        name = project.name
        cal = name.split("calibration-carve-b2-20260906-", 1)
        in_scope = len(cal) == 2 or "task-forge" in name
        if not project.is_dir() or not in_scope:
            continue
        for path in sorted(project.glob("*.jsonl")):
            head = path.read_text(encoding="utf-8", errors="replace")[:40000]
            if "You are the coding agent" not in head:
                continue
            s = session_summary(str(path))
            s["dir_key"] = cal[1].rstrip("-").lower() if len(cal) == 2 else ""
            s["head"] = head
            all_sessions.append(s)
    index, report = [], []
    for task_dir in sorted((Path(ARGS.pack) / "tasks").iterdir()):
        if not task_dir.is_dir():
            continue
        rows, missing = export_task(task_dir, all_sessions)
        index.extend(rows)
        report.append(f"{task_dir.name}: {len(rows)} runs" + (f" (no session for {', '.join(missing)})" if missing else ""))
    INDEX_FILE.write_text("window.EMPIRIA_TB_TRAJECTORIES = " +
                          json.dumps(index, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print("\n".join(report))
    print(f"{INDEX_FILE.name}: {len(index)} runs, {INDEX_FILE.stat().st_size:,} bytes; "
          f"bodies {sum(p.stat().st_size for p in OUT_DIR.glob('*.json')):,} bytes in {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
