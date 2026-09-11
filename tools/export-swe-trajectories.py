#!/usr/bin/env python3
"""Export swe-task-forge agent rollouts into the trajectory explorers' SWE corpus.

Reads an unpacked pack (tasks/<id>/task/{task.toml,instruction.md,GATE.json,
solution/,tests/,runs/<stamp>/{trace.jsonl,result.json,suite.log}}) plus the
mining manifests that produced it, and writes swe-trajectory-data.js:
window.EMPIRIA_SWE_TRAJECTORIES, one object per rollout, in the shape the
linear explorer and the two-lane reader already use for SWE runs.

    python3 tools/export-swe-trajectories.py \
        --pack    /path/to/minions_v148_pack_20260911 \
        --mining  /path/to/mining_v148_* \
        --redact  ~/.config/swe-export-redact.tsv     # optional, not in git

    # re-shape an existing export without the pack
    python3 tools/export-swe-trajectories.py --align-only old-export.js

What the codex harness records, and what it drops, is documented in
FIELD_COVERAGE.md; the field contract is SCHEMA.md.
"""
import argparse, json, os, re, glob, sys, collections, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--pack", help="unpacked pack directory (contains tasks/)")
ap.add_argument("--mining", nargs="*", default=[],
                help="mining run directories whose manifests/ carry commit provenance")
ap.add_argument("--out", default=str(ROOT / "swe-trajectory-data.js"))
ap.add_argument("--redact", help="optional file of extra 'regex<TAB>replacement' lines (keep it out of git)")
ap.add_argument("--align-only", metavar="EXPORT_JS",
                help="skip extraction; re-shape an existing export to the site conventions")
ARGS = ap.parse_args()
PACK = ARGS.pack or ""
MINE = sorted(ARGS.mining)
MAX_RESULT_CHARS, MAX_THINK_CHARS = 12000, 20000
SCHEMA_VERSION = "swe-trajectory/1.0"

# Generic scrubs only; site-specific host names belong in --redact, not in git.
REDACT = [
    (re.compile(r"/mnt/shared-storage-user/[^/\s\"']+/[^/\s\"']+"), "/shared"),
    (re.compile(r"/mnt/docker-ovl2?(?=[/\s'\"\\]|$)"), "/var/lib/docker"),
    (re.compile(r"\bharbor\.[\w.-]+/"), ""),
    (re.compile(r"(forge-codex-[a-z0-9\-]+?)-[0-9A-Za-z]{5,}\b"), r"\1"),
]
if ARGS.redact:
    for line in open(ARGS.redact, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            pat, _, rep = line.rstrip("\n").partition("\t")
            REDACT.append((re.compile(pat), rep))
def redact(s):
    if not s: return s
    for pat, rep in REDACT: s = pat.sub(rep, s)
    return s

# ---------------- stdout vs reasoning ----------------
NOT_PROSE = re.compile(
    r"^(?:[-dlbcps][rwxsStT-]{9}|total \d+|drwx|Traceback|\s*File \"|diff --git|index [0-9a-f]{6,}"
    r"|\+\+\+ |--- |@@ |={4,}|-{4,}|\w*(?:Error|Exception)\b|\s*\d+\s+(?:passed|failed|error)"
    r"|\S+:\d+:|\{|\}|\[|<|\$ )")
CMD_START = re.compile(
    r"^\s*(?:sudo|bash|sh|zsh|python[0-9.]*|pytest|pip[0-9.]*|git|ls|cd|cat|grep|egrep|sed|awk|mv|cp|rm"
    r"|mkdir|rmdir|touch|chmod|chown|chgrp|find|diff|echo|printf|set|export|env|head|tail|wc|sort|uniq"
    r"|docker|tar|unshare|nl|stat|df|du|mount|id|whoami|apply_patch|from|import|def |class |return |if |elif "
    r"|else:|for |while |try:|except|with |raise |print\(|#!|PY$|EOF$|@|--|\|)\b")

def is_prose(par):
    lines = [l for l in par.split("\n") if l.strip()]
    if not lines: return False
    for l in lines:
        if NOT_PROSE.match(l) or CMD_START.match(l): return False
        if "\t" in l: return False
    txt = " ".join(lines)
    words = txt.split()
    if len(words) < 3: return False
    alpha = sum(c.isalpha() or c.isspace() for c in txt) / max(len(txt), 1)
    if alpha < 0.62: return False
    if len(words) < 6 and not re.search(r"[.?!]$", txt.strip()): return False
    return True

def split_paragraphs(block):
    pars, cur = [], []
    for line in block.split("\n"):
        if line.strip() == "":
            if cur: pars.append("\n".join(cur)); cur = []
        else: cur.append(line)
    if cur: pars.append("\n".join(cur))
    return pars

def split_output_and_reasoning(block):
    """Codex prints stdout, then a blank line, then unlabelled reasoning paragraphs."""
    pars = split_paragraphs(block)
    cut = len(pars)
    while cut > 0 and is_prose(pars[cut - 1]): cut -= 1
    return "\n\n".join(pars[:cut]).strip("\n"), "\n\n".join(pars[cut:]).strip("\n")

RES_RE = re.compile(r"^\s*(succeeded|failed|exited)\b.*?:\s*$")
CWD_RE = re.compile(r'^(.*?)\s+in\s+(/\S*)\s*$')

def parse_transcript(text):
    lines, events, buf, mode = text.split("\n"), [], [], "head"
    cmd_lines, tokens_used, i = [], None, 0
    def flush(kind):
        nonlocal buf
        body = "\n".join(buf).strip("\n"); buf = []
        if not body.strip(): return
        if kind == "head":
            out, think = split_output_and_reasoning(body)
            if out: events.append({"type": "tool_result", "content": out, "status": "success",
                                   "exitLabel": "partial", "title": "transcript head"})
            if think: events.append({"type": "thinking", "content": think})
        else:
            events.append({"type": kind, "content": body})
    while i < len(lines):
        ln, s = lines[i], lines[i].strip()
        if s == "exec" and mode != "cmd":
            flush(mode); mode, cmd_lines = "cmd", []; i += 1; continue
        if s == "codex" and mode != "cmd":
            flush(mode); mode = "assistant"; i += 1; continue
        if s == "tokens used":
            flush(mode)
            if i + 1 < len(lines):
                m = re.search(r"([\d,]+)", lines[i + 1])
                if m: tokens_used = int(m.group(1).replace(",", ""))
            break
        if mode == "cmd":
            m = RES_RE.match(ln)
            if m:
                cwd = None
                if cmd_lines:
                    mm = CWD_RE.match(cmd_lines[-1])
                    if mm: cmd_lines[-1], cwd = mm.group(1), mm.group(2)
                d = re.search(r"in\s+([\d.]+)(ms|s)\b", ln)
                dms = float(d.group(1)) * (1 if d.group(2) == "ms" else 1000) if d else None
                status = {"succeeded": "success", "failed": "error", "exited": "error"}[m.group(1)]
                events.append({"type": "tool_call", "content": "\n".join(cmd_lines).strip(),
                               "cwd": cwd, "title": "shell", "status": "success"})
                out, j = [], i + 1
                while j < len(lines) and lines[j].strip() not in ("exec", "codex", "tokens used"):
                    out.append(lines[j]); j += 1
                stdout, think = split_output_and_reasoning("\n".join(out))
                events.append({"type": "tool_result", "content": stdout, "title": "shell",
                               "status": status, "durationMs": dms, "exitLabel": m.group(1)})
                if think: events.append({"type": "thinking", "content": think})
                mode, cmd_lines, i = "thinking", [], j
                continue
            cmd_lines.append(ln); i += 1; continue
        buf.append(ln); i += 1
    else:
        flush(mode)
    return events, tokens_used

# ---------------- misc helpers ----------------
def read(p, d=""):
    try:
        with open(p, errors="replace") as f: return f.read()
    except Exception: return d

def parse_toml_lite(txt):
    out, sec = {}, None
    for line in txt.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"): continue
        if line.startswith("[") and line.endswith("]"): sec = line[1:-1]; out.setdefault(sec, {}); continue
        if "=" in line and sec is not None:
            k, v = [x.strip() for x in line.split("=", 1)]
            if v.startswith('"') and v.endswith('"'): v = v[1:-1]
            elif v.startswith("["): v = [x.strip().strip('"') for x in v.strip("[]").split(",") if x.strip()]
            else:
                try: v = int(v)
                except ValueError:
                    try: v = float(v)
                    except ValueError: v = {"true": True, "false": False}.get(v, v)
            out[sec][k] = v
    return out

def suite_summary(tail):
    m = re.search(r"=+\s*([^=]*?(?:passed|failed|error)[^=]*?)\s*=+\s*$", (tail or "").strip(), re.M)
    if m: return m.group(1).strip()
    for line in reversed((tail or "").strip().split("\n")):
        if re.search(r"\d+\s+(passed|failed)", line): return line.strip()
    return None

def counts_from(txt):
    return {k: int(m.group(1)) for k in ("passed", "failed", "error", "skipped")
            for m in [re.search(r"(\d+)\s+" + k, txt or "")] if m}

# ---------------- site conventions ----------------
# The site already carries one SWE run (django__django-11119 in
# trajectory-data.js). Every rollout is shaped like it: `kind` on every event,
# `returnCode` on results, precomputed kindCounts/statusCounts for the reader's
# corpus overview, "Reward 1.0", "n / N" FAIL_TO_PASS, "x passed · y failed".

def _summary_line(text):
    for line in reversed((text or "").strip().split("\n")):
        if re.search(r"\d+\s+(passed|failed|error)", line): return line
    return None

def _tally(text):
    c = counts_from(_summary_line(text) or "")
    if not c: return None
    parts = [f'{c.get("passed", 0)} passed', f'{c.get("failed", 0) + c.get("error", 0)} failed']
    if c.get("skipped"): parts.append(f'{c["skipped"]} skipped')
    return " · ".join(parts)

def _scrub(value):
    if isinstance(value, str): return redact(value)
    if isinstance(value, list): return [_scrub(v) for v in value]
    if isinstance(value, dict): return {k: _scrub(v) for k, v in value.items()}
    return value

def _is_transcript_call(e):
    # transcript-derived calls carry truncatedInTrace (bool); backbone-only calls do not
    return e["type"] == "tool_call" and isinstance(e.get("truncatedInTrace"), bool)

def repair_call_pairing(events):
    """Exports made before the merge-order fix hung a transcript call's result on the
    last command the transcript skipped, and gave the command whose output the
    transcript opens with both a 'missing' placeholder and its partial output.
    Put every result back under its own call. A no-op on exports made since."""
    out = []
    for i, e in enumerate(events):
        nxt = events[i + 1] if i + 1 < len(events) else None
        if (e["type"] == "tool_result" and e.get("status") == "missing" and nxt is not None
                and nxt["type"] == "tool_result" and nxt.get("toolCallId") == e.get("toolCallId")
                and (nxt.get("summary") or "").startswith("partial output")):
            continue                                  # partial output supersedes the placeholder
        out.append(e)
    events, out, i = out, [], 0
    while i < len(events):
        e = events[i]
        out.append(e)
        if not _is_transcript_call(e):
            i += 1; continue
        j = i + 1
        while j < len(events) and not _is_transcript_call(events[j]):
            j += 1
        block = events[i + 1:j]
        own = next((k for k, x in enumerate(block) if x["type"] == "tool_result"
                    and x.get("status") != "missing"
                    and not (x.get("summary") or "").startswith("partial output")), None)
        if own is not None:
            r = block.pop(own)
            r["toolCallId"] = e.get("toolCallId")
            out.append(r)
        out.extend(block)
        i = j
    for n, e in enumerate(out):
        e["sourceIndex"] = n
    return out

# Every codex command reaches the task container through the same wrapper:
#   /bin/bash -lc "docker exec -u agent -w /workspace <ctr> bash -lc '<command>'"
# which buries the command ~75 characters in. Keep the raw invocation in
# `content`; expose the command itself as `command` for the readers.
_OUTER = re.compile(r'^/bin/(?:ba)?sh -lc "(.*)"$', re.S)
_OUTER_SQ = re.compile(r"^/bin/(?:ba)?sh -lc '(.*)'$", re.S)
_OUTER_CUT = re.compile(r'^/bin/(?:ba)?sh -lc "(.*)$', re.S)      # harness kept only line 1
_STDIN = re.compile("^" + r"(docker exec(?: -[a-zA-Z]+(?: (?!bash\b)[^\s'\"]+)?)*) (\S+) (bash -s\b.*)$", re.S)
_DOCKER = r"(docker exec(?: -[a-zA-Z]+(?: (?!bash\b)[^\s'\"]+)?)*) (\S+) bash -lc "
_INNER_SQ = re.compile("^" + _DOCKER + r"'([^']*)'(.*)$", re.S)
_INNER_DQ = re.compile("^" + _DOCKER + r'"((?:[^"\\]|\\.)*)"(.*)$', re.S)
_INNER_OPEN = re.compile("^" + _DOCKER + r"""(['"])(.*)$""", re.S)

HOST_SHELL = "host shell — outside the task container"

def _undq(text):
    """undo one level of bash double-quote escaping"""
    return re.sub(r'\\([\\"$`])', r"\1", text)

def unwrap_command(raw):
    """-> (command, invocation, truncated) or (None, None, False) when not wrapped"""
    # command_result appends " in <cwd>", and codex adds "\nPoll." to long-running ones
    raw = re.sub(r"""(["'])\s+in\s+/[^"']*$""", r"\1", (raw or "").strip())
    cut = False
    m = _OUTER.match(raw)
    if m:
        body = _undq(m.group(1))
    elif _OUTER_SQ.match(raw):
        body = _OUTER_SQ.match(raw).group(1).replace("'\"'\"'", "'")
    else:
        m, cut = _OUTER_CUT.match(raw), True
        if not m: return None, None, False
        body = _undq(m.group(1))
    st = _STDIN.match(body)
    if st:
        return st.group(3).strip(), st.group(1), cut
    if not body.lstrip().startswith(("docker exec", "bash -lc 'docker exec", 'bash -lc "docker exec')):
        # codex was told to wrap every command in docker exec; this one it ran as-is,
        # on the harness host rather than inside the task container
        return body.strip(), HOST_SHELL, cut
    sq = _INNER_SQ.match(body.replace("'\"'\"'", "\x00"))      # '"'"' is a literal ' inside '...'
    if sq:
        cmd = sq.group(3).replace("\x00", "'")
        tail = sq.group(4).replace("\x00", "'").strip()
        inv = sq.group(1)
    else:
        dq = _INNER_DQ.match(body)
        if dq:
            cmd, tail, inv = _undq(dq.group(3)), dq.group(4).strip(), dq.group(1)
        else:
            op = _INNER_OPEN.match(body)
            if not op: return None, None, False
            cmd = op.group(4).replace("'\"'\"'", "'")
            cmd = _undq(cmd) if op.group(3) == '"' else cmd
            tail, inv, cut = "", op.group(1), True
    if tail: cmd = cmd + " " + tail
    return cmd.strip(), inv, cut

def program_of(cmd):
    s = (cmd or "").strip()
    while True:
        m = re.match(r"^(?:set\s+-[A-Za-z]+|cd\s+\S+)\s*(?:;|&&|\n)\s*", s)
        if not m: break
        s = s[m.end():]
    s = re.sub(r"^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+", "", s)
    tok = re.match(r"[^\s;|&<>()]+", s)
    return os.path.basename(tok.group(0)) if tok else "shell"

# Post-run artefacts the agent never saw. They stay type "context" for the linear
# explorer, but carry kind "evaluation" so the two-lane reader keeps them out of
# the lane labelled "fed to the model".
_EVALUATION_TITLES = ("Gold patch", "Oracle solve.sh", "Task Dockerfile", "Verifier suite.log")

def align_to_site(trajectories):
    for t in trajectories:
        t["events"] = repair_call_pairing(t["events"])
        for e in t["events"]:
            if e["type"] == "tool_call" and "command" not in e:
                cmd, inv, cut = unwrap_command(e.get("content"))
                if cmd:
                    e["command"], e["invocation"] = cmd, inv
                    if cut: e["commandTruncated"] = True     # the harness stored line 1 only
                    e["title"] = program_of(cmd)
                    e["summary"] = re.sub(r"\s+", " ", cmd)[:180]
            if e["type"] == "context" and (e.get("title") or "").startswith(_EVALUATION_TITLES):
                e["kind"] = "evaluation"
        results = [e for e in t["events"] if e["type"] == "tool_result"]
        observed = [e for e in results if e.get("status") != "missing"]
        failed = [e for e in observed if e.get("status") in ("error", "timeout", "rejected")]
        t["errorRate"] = round(len(failed) / len(observed), 4) if observed else None
        c = collections.Counter(e["type"] for e in t["events"])
        t["counts"] = {k: c.get(k, 0) for k in
                       ("user", "thinking", "assistant", "tool_call", "tool_result", "context", "system")}
        t["messageCount"] = t["eventCount"] = len(t["events"])
        env = t["environment"]
        t["category"], t["taskType"], t["valueTier"] = "SWE", "commit_restoration", "SWE"
        t["dataSource"] = "swe-task-forge"
        t["score"] = f'Reward {env["reward"]}' if env.get("reward") else None
        env["family"] = "SWE task environment"
        env["runtime"], env["os"] = "Docker · Linux · offline", "Linux"
        if isinstance(env.get("verifierTimeout"), int):
            env["verifierTimeout"] = f'{env["verifierTimeout"]} s'

        first_ts = next((e.get("timestamp") for e in t["events"] if e.get("timestamp")), None)
        env["startedAt"], env["finishedAt"] = first_ts, None
        if first_ts and env.get("duration"):
            env["finishedAt"] = (dt.datetime.strptime(first_ts, "%Y-%m-%dT%H:%M:%SZ")
                                 + dt.timedelta(seconds=env["duration"])).strftime("%Y-%m-%dT%H:%M:%SZ")

        suite = next((e["content"] for e in t["events"]
                      if e["type"] == "context" and e.get("title") == "Verifier suite.log"), "")
        if _tally(suite): env["tests"] = _tally(suite)

        # FAIL_TO_PASS / PASS_TO_PASS are exact only when the whole suite passed:
        # then every test that failed on the empty patch passes and every test that
        # passed still does. A failed run keeps its tally in `tests` instead of an
        # invented per-test split. The gate's own arms stay in gate*Summary.
        if (env.get("failToPass") or "").endswith("empty patch"): env["gateEmptySummary"] = env["failToPass"]
        if (env.get("passToPass") or "").endswith("gold patch"): env["gateOracleSummary"] = env["passToPass"]
        g = counts_from(_summary_line(env.get("gateEmptyTail") or "") or "")
        f2p, p2p = g.get("failed", 0) + g.get("error", 0), g.get("passed", 0)
        exact = env.get("resolved") == "true" and env.get("verifierRc") == 0 and f2p > 0
        env["failToPass"] = f"{f2p} / {f2p}" if exact else None
        env["passToPass"] = f"{p2p} / {p2p}" if exact else None
        # The explorer's "Patch exists / Patch applied" describe the agent's own
        # patch. The pack never captures it, so say nothing rather than guess.
        env["patchExists"] = env["patchApplied"] = None

        for e in t["events"]:
            e.setdefault("kind", e["type"])
            if e["type"] == "tool_result":
                if e.get("status") == "missing": e["returnCode"] = None
                elif (e.get("summary") or "").startswith("succeeded"): e.setdefault("returnCode", 0)
                else: e.setdefault("returnCode", None)
        t["kindCounts"] = dict(collections.Counter(e["kind"] for e in t["events"]))
        t["statusCounts"] = dict(collections.Counter(e.get("status") or "success"
                                                     for e in t["events"] if e["type"] == "tool_result"))
    return _scrub(trajectories)

def write_js(trajectories, out):
    with open(out, "w", encoding="utf-8") as f:
        f.write("window.EMPIRIA_SWE_TRAJECTORIES = ")
        json.dump(trajectories, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"{out}: {len(trajectories)} rollouts, {os.path.getsize(out):,} bytes")

if ARGS.align_only:
    text = open(ARGS.align_only, encoding="utf-8").read()
    write_js(align_to_site(json.loads(text[text.index("["):].rstrip().rstrip(";\n").rstrip())), ARGS.out)
    sys.exit(0)
if not PACK:
    ap.error("--pack is required unless --align-only is given")

# ---------------- provenance index ----------------
prov = {}
for root in MINE:
    for stage in ("10_bundle_environments", "09_run_packages", "08_gate_packages",
                  "07_emit_harbor_task", "06_instruction_from_diff", "05_construct_tests",
                  "04_verify_suite_flip", "03_commit_gate", "02_mine_commits"):
        for p in glob.glob(f"{root}/manifests/{stage}.jsonl") + glob.glob(f"{root}/stream/*/manifests/{stage}.jsonl"):
            for line in open(p, errors="replace"):
                line = line.strip()
                if not line: continue
                try: o = json.loads(line)
                except Exception: continue
                tid = (o.get("task") or "").split("/")[-1]
                if not tid and o.get("task_id"): tid = o["task_id"]
                key = tid
                if key:
                    prov.setdefault(key, {}).setdefault(stage, o)
                cf = o.get("commit") or ""
                if cf:
                    prov.setdefault("commit:" + cf[:8], {}).setdefault(stage, o)

def prov_for(tid, subject):
    d = dict(prov.get(tid, {}))
    for k, v in prov.get("commit:" + (subject or "")[:8], {}).items(): d.setdefault(k, v)
    return d

REPO_RE = re.compile(r"\bin\s+([A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+)\b")
trajectories, environments, stats = [], [], collections.Counter()

for tdir in sorted(glob.glob(PACK + "/tasks/*")):
    tid = os.path.basename(tdir)
    toml = parse_toml_lite(read(f"{tdir}/task/task.toml"))
    meta, tsk = toml.get("metadata", {}), toml.get("task", {})
    envc, agc, vfc = toml.get("environment", {}), toml.get("agent", {}), toml.get("verifier", {})
    instruction = read(f"{tdir}/task/instruction.md")
    try: gate = json.loads(read(f"{tdir}/task/GATE.json", "{}"))
    except Exception: gate = {}
    try: image = json.loads(read(f"{tdir}/image.json", "{}"))
    except Exception: image = {}
    gold = read(f"{tdir}/task/solution/gold.patch")
    gold_files = sorted(set(re.findall(r"^\+\+\+ b/(.+)$", gold, re.M)))
    gold_add = len(re.findall(r"^\+(?!\+\+)", gold, re.M))
    gold_del = len(re.findall(r"^-(?!--)", gold, re.M))
    hidden = sorted(os.path.basename(p) for p in glob.glob(f"{tdir}/task/tests/hidden/*"))
    suite_sh, test_sh = read(f"{tdir}/task/tests/suite.sh"), read(f"{tdir}/task/tests/test.sh")
    solve_sh = read(f"{tdir}/task/solution/solve.sh")
    dockerfile = read(f"{tdir}/task/environment/Dockerfile")
    desc = tsk.get("description", "")
    mrepo = REPO_RE.search(desc); repo = mrepo.group(1) if mrepo else None
    title = instruction.split("\n", 1)[0].lstrip("# ").strip() or tsk.get("name", tid)
    f2p, p2p = counts_from(gate.get("empty", {}).get("tail", "")), counts_from(gate.get("oracle", {}).get("tail", ""))
    P = prov_for(tid, meta.get("subject"))
    m02 = P.get("02_mine_commits") or P.get("03_commit_gate") or P.get("05_construct_tests") or {}
    m07 = P.get("07_emit_harbor_task") or P.get("08_gate_packages") or P.get("10_bundle_environments") or {}
    m10 = P.get("10_bundle_environments") or {}
    m06 = P.get("06_instruction_from_diff") or {}
    stats["prov_hit"] += 1 if P else 0

    environments.append({"id": tid, "title": title, "repository": repo, "instruction": instruction,
                         "gate": gate, "goldFiles": gold_files, "hiddenTests": hidden, "toml": toml})

    run_dirs = sorted(glob.glob(f"{tdir}/task/runs/*"))
    for run_ix, rdir in enumerate(run_dirs, 1):
        stamp = os.path.basename(rdir)
        try: res = json.loads(read(f"{rdir}/result.json", "{}"))
        except Exception: res = {}
        suite_log = read(f"{rdir}/suite.log")
        raw = []
        for l in read(f"{rdir}/trace.jsonl").split("\n"):
            if l.strip():
                try: raw.append(json.loads(l))
                except Exception: pass
        transcript = next((o["payload"].get("text") for o in raw if o.get("event_type") == "codex_transcript"), None)
        transcript_rc = next((o.get("rc") for o in raw if o.get("event_type") == "codex_transcript"), None)
        instr_ev = next((o for o in raw if o.get("event_type") == "agent_turn"), None)
        cmd_events = [o for o in raw if o.get("event_type") == "command_result"]
        events, tokens_used = parse_transcript(transcript) if transcript else ([], None)

        ts_by_cmd = collections.defaultdict(list)
        for o in cmd_events: ts_by_cmd[o.get("command", "").strip()].append(o.get("timestamp"))
        t0 = instr_ev.get("timestamp") if instr_ev else None
        tlast = cmd_events[-1]["timestamp"] if cmd_events else None

        # ---- merge: command_result is the full backbone, transcript is a ~59KB tail ----
        def norm(s):
            # command_result truncates multi-line commands at the first line, so compare
            # on a whitespace-flattened prefix instead of exact text.
            return re.sub(r"\s+", " ", re.sub(r"\s+in\s+/\S*\s*$", "", (s or "").strip())).strip()
        def same(bb_cmd, exec_cmd):
            if not bb_cmd or not exec_cmd: return False
            if bb_cmd == exec_cmd: return True
            return len(bb_cmd) >= 40 and exec_cmd.startswith(bb_cmd)
        backbone = [{"cmd": norm(o.get("payload", {}).get("command") or o.get("command")),
                     "raw": o.get("payload", {}).get("command") or o.get("command"),
                     "step": o.get("step"), "ts": o.get("timestamp")} for o in cmd_events]
        merged, pending, p, matched = [], [], 0, 0
        head_partial = None
        for e in events:
            if e["type"] == "tool_call":
                target = norm(e.get("content"))
                hit = next((k for k in range(p, len(backbone)) if same(backbone[k]["cmd"], target)), None)
                # pending = [result of the previous call?, reasoning leading to this one].
                # The previous call's result belongs directly under that call; commands the
                # transcript skipped ran after it; the reasoning stays next to the call it
                # leads to. Flushing all of pending after the skipped commands hung the
                # previous result on the last skipped command instead.
                prev_result = pending[:1] if pending and pending[0][2]["type"] == "tool_result" else []
                rest = pending[len(prev_result):]
                pending = []
                merged.extend(prev_result)
                if hit is None:
                    merged.extend(rest)
                    merged.append(("call", None, e)); continue
                for k in range(p, hit):
                    if head_partial is not None and k == hit - 1:
                        # the transcript opens inside this command's output
                        merged.append(("call_head", backbone[k], head_partial)); head_partial = None
                    else:
                        merged.append(("call_only", backbone[k], None))
                merged.extend(rest)
                merged.append(("call", backbone[hit], e))
                p = hit + 1; matched += 1
            elif e["type"] == "tool_result" and e.get("exitLabel") == "partial":
                head_partial = e
            else:
                pending.append(("blk", None, e))
        merged.extend(pending)
        for k in range(p, len(backbone)):
            merged.append(("call_only", backbone[k], None))

        out_events, counts, idx, call_no = [], collections.Counter(), 0, 0
        if instruction:
            out_events.append({"type": "user", "sourceIndex": idx, "title": "Task instruction",
                               "content": instruction, "summary": title, "timestamp": t0})
            counts["user"] += 1; idx += 1
        for tag, bb, e in merged:
            if tag == "call_head":
                call_no += 1
                content = redact(bb["raw"] or "")
                out_events.append({"type": "tool_call", "sourceIndex": idx, "content": content,
                                   "title": "shell", "toolName": "shell", "toolCallId": f"c{call_no}",
                                   "timestamp": bb["ts"], "target": f'step {bb["step"]}',
                                   "summary": redact(re.sub(r"\s+", " ", content))[:180]})
                counts["tool_call"] += 1; idx += 1
                partial = redact(e.get("content") or "")[:MAX_RESULT_CHARS]
                out_events.append({"type": "tool_result", "sourceIndex": idx,
                                   "content": partial or "(command produced no output)",
                                   "title": "shell output (tail of transcript)", "toolName": "shell",
                                   "toolCallId": f"c{call_no}", "status": "success",
                                   "summary": "partial output — transcript starts mid-stream"})
                counts["tool_result"] += 1; idx += 1
                continue
            if tag == "call_only":
                call_no += 1
                content = redact(bb["raw"] or "")
                out_events.append({"type": "tool_call", "sourceIndex": idx, "content": content,
                                   "title": "shell", "toolName": "shell", "toolCallId": f"c{call_no}",
                                   "timestamp": bb["ts"], "target": f'step {bb["step"]}',
                                   "summary": redact(re.sub(r"\s+", " ", content))[:180]})
                counts["tool_call"] += 1; idx += 1
                out_events.append({"type": "tool_result", "sourceIndex": idx,
                                   "content": "[not captured — codex transcript was truncated to its last ~59 KB; "
                                              "trace.jsonl command_result events record the command only, never its output]",
                                   "title": "shell output", "toolName": "shell",
                                   "toolCallId": f"c{call_no}", "status": "missing",
                                   "summary": "output not captured (capture gap, not an agent failure)",
                                   "timestamp": bb["ts"]})
                counts["tool_result"] += 1; idx += 1
                continue
            typ, content = e["type"], redact(e.get("content") or "")
            if typ == "tool_result" and len(content) > MAX_RESULT_CHARS:
                content = content[:MAX_RESULT_CHARS] + f"\n… [truncated {len(content)-MAX_RESULT_CHARS} chars]"
            if typ == "thinking" and len(content) > MAX_THINK_CHARS:
                content = content[:MAX_THINK_CHARS] + "\n… [truncated]"
            if not content.strip():
                if typ != "tool_result": continue
                content = "(command produced no output)"
            ev = {"type": typ, "sourceIndex": idx, "content": content}
            if typ == "tool_call":
                call_no += 1
                ev.update({"title": "shell", "toolName": "shell", "toolCallId": f"c{call_no}",
                           "target": (f'step {bb["step"]}' if bb else redact(e.get("cwd") or "")),
                           "truncatedInTrace": bool(bb and len(norm(bb["raw"])) < len(norm(e.get("content")))),
                           "timestamp": bb["ts"] if bb else None,
                           "summary": redact(re.sub(r"\s+", " ", content))[:180]})
            elif typ == "tool_result":
                ev.update({"title": "shell output", "toolName": "shell", "toolCallId": f"c{call_no}",
                           "status": e.get("status", "success"),
                           "summary": (f"{e.get('exitLabel')} in {int(e['durationMs'])}ms"
                                       if e.get("durationMs") is not None else e.get("exitLabel"))})
            elif typ == "assistant": ev["title"] = "Assistant message"
            elif typ == "thinking":  ev["title"] = "Reasoning"
            counts[typ] += 1; out_events.append(ev); idx += 1

        if not transcript:
            stats["no_transcript"] += 1
            out_events.append({"type": "system", "sourceIndex": idx, "title": "Run aborted before any turn",
                               "content": f'verdict={res.get("verdict")}\nstopped_because={res.get("stopped_because")}\n'
                                          f'model={res.get("model")}\nNo codex transcript was recorded for this run.',
                               "summary": res.get("verdict"), "timestamp": t0})
            counts["system"] += 1; idx += 1
        if gold.strip():
            out_events.append({"type": "context", "sourceIndex": idx,
                               "title": "Gold patch (oracle — not shown to the agent)",
                               "content": gold[:MAX_RESULT_CHARS],
                               "summary": f'{len(gold_files)} files · +{gold_add} / -{gold_del}',
                               "status": "success"})
            counts["context"] += 1; idx += 1
        if solve_sh.strip():
            out_events.append({"type": "context", "sourceIndex": idx, "title": "Oracle solve.sh",
                               "content": solve_sh[:4000], "summary": "how the gold arm is applied",
                               "status": "success"})
            counts["context"] += 1; idx += 1
        if dockerfile.strip():
            out_events.append({"type": "context", "sourceIndex": idx, "title": "Task Dockerfile",
                               "content": dockerfile[:6000], "summary": "environment recipe",
                               "status": "success"})
            counts["context"] += 1; idx += 1
        if suite_log.strip():
            out_events.append({"type": "context", "sourceIndex": idx, "title": "Verifier suite.log",
                               "content": redact(suite_log[-MAX_RESULT_CHARS:]), "summary": suite_summary(suite_log),
                               "status": "success" if res.get("verifier_rc") == 0 else "error"})
            counts["context"] += 1; idx += 1

        reward = (res.get("reward") or {}).get("reward")
        passed = bool((res.get("reward") or {}).get("pass"))
        secs = res.get("seconds")
        agent_secs = None
        if t0 and tlast:
            try:
                f = "%Y-%m-%dT%H:%M:%SZ"
                agent_secs = (dt.datetime.strptime(tlast, f) - dt.datetime.strptime(t0, f)).total_seconds()
            except Exception: pass
        verif_secs = round(secs - agent_secs, 1) if (secs and agent_secs and secs > agent_secs) else None

        env = {
            "benchmark": "swe-task-forge · minions v148", "task": tid, "taskName": tid,
            "repository": repo or m02.get("repo"), "baseCommit": m02.get("commit") or meta.get("subject"),
            "version": meta.get("variant"), "difficulty": meta.get("difficulty"),
            "runtime": "docker · offline", "os": "linux", "architecture": "x86_64",
            "image": meta.get("source_image"), "workdir": envc.get("workdir"),
            "cpu": f'{envc.get("cpus")} cores' if envc.get("cpus") else None,
            "memory": f'{envc.get("memory_mb")} MB' if envc.get("memory_mb") else None,
            "storage": f'{envc.get("storage_mb")} MB' if envc.get("storage_mb") else None,
            "internet": "Blocked" if envc.get("allow_internet") is False else "Allowed",
            "agent": res.get("harness"), "model": res.get("model"), "serviceTier": None,
            "verifier": suite_sh.strip().split("\n")[-1] if suite_sh.strip() else None,
            "reward": None if reward is None else f"{reward:.1f}",
            "resolved": "true" if passed else "false",
            "tests": suite_summary(suite_log), "duration": secs, "issue": instruction,
            "taskCategory": meta.get("category"),
            "failToPass": f'{f2p.get("failed", 0)} failing on empty patch' if f2p else None,
            "passToPass": f'{p2p.get("passed", 0)} passing with gold patch' if p2p else None,
            "patchApplied": "true" if (res.get("steps") or 0) > 0 else "false",
            "patchExists": "true" if gold else "false",
            "exception": None if passed else res.get("stopped_because"),
            "agentDuration": agent_secs, "verifierDuration": verif_secs,
            "environmentSetupDuration": None, "agentSetupDuration": None,
            # ---- fields upstream has no slot for; our fork renders them ----
            "verdict": res.get("verdict"), "stoppedBecause": res.get("stopped_because"),
            "verifierRc": res.get("verifier_rc"),
            "suiteRc": (res.get("reward") or {}).get("detail", {}).get("suite_rc"),
            "gradedBy": (res.get("reward") or {}).get("detail", {}).get("graded_by"),
            "steps": res.get("steps"), "codexRc": transcript_rc,
            "commitSubject": meta.get("commit_subject") or m02.get("subject"),
            "patchLines": meta.get("patch_lines"), "domain": meta.get("domain"),
            "keywords": tsk.get("keywords"), "agentTimeout": agc.get("timeout_sec"),
            "verifierTimeout": vfc.get("timeout_sec"),
            "goldFiles": gold_files, "goldAdd": gold_add, "goldDel": gold_del, "hiddenTests": hidden,
            "gateEmptyRc": gate.get("empty", {}).get("rc"), "gateEmptyReward": gate.get("empty", {}).get("reward"),
            "gateOracleRc": gate.get("oracle", {}).get("rc"), "gateOracleReward": gate.get("oracle", {}).get("reward"),
            "gateEmptyTail": gate.get("empty", {}).get("tail"), "gateOracleTail": gate.get("oracle", {}).get("tail"),
            "baseTarball": image.get("base_tarball"),
            # --- what the dialogue reader's run-source rail reads ---
            "conversationId": stamp, "snapshot": stamp,
            "sourceFile": f"tasks/{tid}/task/runs/{stamp}/trace.jsonl",
            "outcome": res.get("verdict"),
            "taskSummary": ((P.get("03_commit_gate") or {}).get("judge") or {})
                             .get("behavior_summary", {}).get("expected_behavior"),
            "requestId": None,
            # --- Tier B: pack files that had no field before ---
            "solveCommand": (solve_sh.strip().split("\n")[-1] if solve_sh.strip() else None),
            "testEntry": (test_sh.strip().split("\n")[-1] if test_sh.strip() else None),
            "dockerfileLines": len([l for l in dockerfile.split("\n") if l.strip()]) or None,
            "buildCommand": image.get("build"),
            "language": (P.get("01_discover_pairs") or {}).get("language"),
            "miningWindow": (P.get("01_discover_pairs") or {}).get("window"),
            "verifiedInstancesTotal": (P.get("01_discover_pairs") or {}).get("verified_instances_total"),
            "commitStats": m02.get("stats"),
            "statementTitle": m06.get("statement_title"),
            "runOrdinal": run_ix, "runsForTask": len(run_dirs),
            "commandsRecorded": len(cmd_events), "transcriptChars": len(transcript or ""),
            "transcriptExecBlocks": sum(1 for e in events if e["type"] == "tool_call"),
            "callsWithOutput": matched,
            "outputCoverage": (f"{matched}/{len(cmd_events)} commands have captured stdout"
                               if cmd_events else None),
            "transcriptTruncated": "true" if (transcript and len(transcript) > 55000) else "false",
            # ---- mining provenance (never exported before) ----
            "provInstanceId": m02.get("instance_id") or m07.get("task_id"),
            "provRoute": m07.get("route") or m02.get("route"), "provShape": m07.get("shape"),
            "provTestOrigin": m07.get("test_origin"), "provStatementOrigin": m07.get("statement_origin"),
            "provWithheld": m07.get("withheld"), "provHarborRef": m07.get("harbor_ref"),
            "provImageDigest": m10.get("image_digest"),
            "provAuthor": m02.get("author"), "provAuthorDate": m02.get("author_date"),
            "provIssueRefs": m02.get("issue_refs"), "provIssueTracker": m02.get("issue_tracker"),
            "provParent": m02.get("parent"), "provIsMerge": m02.get("is_merge"),
            "provRepoUrl": m02.get("repo_url"), "provBucket": m02.get("bucket_id"),
            "provGoldDigest": m02.get("gold_patch_digest"), "provTestDigest": m02.get("test_patch_digest"),
            "provGoldFiles": (m02.get("files") or {}).get("gold"),
            "provTestFiles": (m02.get("files") or {}).get("test"),
            "provEvidence": P.get("05_construct_tests", {}).get("evidence") or P.get("04_verify_suite_flip", {}).get("evidence"),
            "provJudge": (P.get("03_commit_gate") or {}).get("judge"),
            "provStatementMeta": m06.get("statement_meta"), "provStatementTitle": m06.get("statement_title"),
            "provStats": m02.get("stats"), "provSwebench": m02.get("swebench"),
        }
        tool_calls = counts["tool_call"]
        errors = sum(1 for e in out_events if e.get("type") == "tool_result" and e.get("status") == "error")
        trajectories.append({
            "id": f"{tid}--{stamp}",
            "shortId": ((tid.split("-mine-")[-1] if "-mine-" in tid else tid)[:8]
                        + (f"-r{run_ix}" if len(run_dirs) > 1 else "")),
            "snapshotLabel": (f"run {run_ix}/{len(run_dirs)}" if len(run_dirs) > 1 else None),
            "title": title, "trajectoryClass": "swe", "category": meta.get("category", "coding"),
            "taskType": meta.get("variant", "swe"),
            "situation": "successful" if passed else "failed",
            "score": None if reward is None else f"{reward:.1f}", "valueTier": None,
            "model": res.get("model"), "agent": res.get("harness"), "serviceTier": None,
            "dataSource": f"minions_v148_pack_20260911 · {stamp}", "conversationId": stamp,
            "report": f'{res.get("verdict")} · {res.get("steps")} steps · {secs}s · stopped: {res.get("stopped_because")}',
            "messageCount": len(out_events), "eventCount": len(out_events),
            "toolCallCount": tool_calls, "agentStepCount": res.get("steps"),
            "estimatedTokens": tokens_used,
            "tokenUsage": {"total": tokens_used, "cachedInput": None, "uncachedInput": None,
                           "cacheWrite": None, "output": None, "thinkingTokens": None,
                           "promptTokens": None, "rawInput": None, "requestId": None,
                           "serviceTier": None,
                           "source": "codex transcript footer (run total only)"}
                          if tokens_used else {"total": None},
            "tokenUsageEstimated": True,
            "errorRate": round(errors / tool_calls, 4) if tool_calls else None,
            "counts": {k: counts.get(k, 0) for k in
                       ("user", "thinking", "assistant", "tool_call", "tool_result", "context", "system")},
            "toolCounts": {"shell": tool_calls}, "environment": env, "events": out_events,
            "captureCoverage": (round(matched / len(cmd_events), 4) if cmd_events else None),
            # ---- declared capture contract: what the producer does and does not emit ----
            "capture": {
                "schemaVersion": SCHEMA_VERSION,
                "producer": "swe-task-forge/minions mining-v1.2.0 + codex harness",
                "commandsRecorded": len(cmd_events), "commandsWithOutput": matched,
                "transcriptChars": len(transcript or ""),
                "transcriptTruncated": bool(transcript and len(transcript) > 55000),
                "available": {
                    "perStepTokens": False, "fullCommandOutput": False,
                    "structuredRollout": False, "agentFinalDiff": False,
                    "perTestResults": False, "relayEnvelope": False,
                    "fileMutations": False, "samplingParams": False,
                    "eventTimestamps": "tool_call only", "contextWindowPerStep": False,
                },
            },
        })
        stats["runs"] += 1
        stats["tokens_found"] += 1 if tokens_used else 0
        for k in ("thinking", "assistant", "tool_call", "tool_result", "context"): stats[k] += counts[k]
        stats["cmds_backbone"] += len(cmd_events); stats["cmds_with_output"] += matched

print(json.dumps(dict(stats), indent=1))
write_js(align_to_site(trajectories), ARGS.out)
