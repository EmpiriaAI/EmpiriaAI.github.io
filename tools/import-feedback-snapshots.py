#!/usr/bin/env python3
"""Convert filtered feedback snapshots into lazy-loaded website data."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "data" / "feedback-snapshots"
INDEX_FILE = ROOT / "feedback-snapshot-index.js"

TASK_LABELS = {
    "feature_development": "Feature development",
    "refactoring": "Refactoring",
    "coding": "Coding",
    "bug_fixing": "Bug fixing",
    "debugging": "Debugging",
    "testing": "Testing",
    "testing_debug": "Testing & debugging",
    "maintenance_automation": "Maintenance automation",
    "configuration_management": "Configuration management",
    "devops_infrastructure": "DevOps infrastructure",
    "research_analysis": "Research analysis",
    "research_read": "Research reading",
    "execution_automation": "Execution automation",
    "data_task": "Data task",
}


def redact(text: str) -> str:
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "[REDACTED_API_KEY]", text)
    text = re.sub(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", "[REDACTED_GITHUB_TOKEN]", text)
    text = re.sub(r"(?i)(authorization[\"'\s:=]+bearer\s+)[A-Za-z0-9._~-]{12,}", r"\1[REDACTED_TOKEN]", text)
    text = re.sub(
        r"(?im)^(\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PASSWD|SECRET)\s*=\s*)([^\r\n]+)$",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r'''(?i)(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)["']\s*:\s*["'])([^"'\r\n]+)(["'])''',
        r"\1[REDACTED]\3",
        text,
    )
    text = re.sub(r"(https?://)[^/@\s:]+:[^/@\s]+@", r"\1[REDACTED]@", text)
    text = re.sub(r"/Users/[^/\s\"']+", "/Users/[USER]", text)
    text = re.sub(r"/home/[^/\s\"']+", "/home/[USER]", text)
    text = re.sub(r"([A-Za-z]:\\Users\\)[^\\\s\"']+", r"\1[USER]", text)
    return text


def text_content(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return redact(content)
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                value = block.get("text") or block.get("content")
                if isinstance(value, str):
                    parts.append(value)
        return redact("\n".join(parts))
    return ""


def tool_status(content: str) -> str:
    value = content.lower()
    if "timed out" in value or "timeout" in value:
        return "timeout"
    if "rejected" in value or "not executed" in value or "permission denied" in value:
        return "rejected"
    error_signals = (
        '"returncode": 1', '"returncode": -1', "exit code 1", "traceback (most recent call last)",
        "modulenotfounderror", "syntaxerror", "fatal:", "command failed", "iserror\":true"
    )
    if any(signal in value for signal in error_signals):
        return "error"
    return "success"


def is_context_message(content: str) -> bool:
    stripped = content.lstrip()
    return (
        stripped.startswith("Contents of ")
        or stripped.startswith("<system-reminder>")
        or stripped.startswith("<local-command-caveat>")
        or "project instructions, checked into the codebase" in stripped[:500]
        or "user's private global instructions" in stripped[:500]
        or "user's auto-memory" in stripped[:500]
    )


def build_node_sources(messages: list[dict]) -> dict[int, list[int]]:
    pending: list[int] = []
    mapping: dict[int, list[int]] = {}
    node_index = 0
    for message_index, message in enumerate(messages):
        role = message.get("role")
        if role == "system":
            continue
        if role in {"user", "tool"}:
            pending.append(message_index)
            continue
        if role == "assistant":
            mapping[node_index] = [*pending, message_index]
            node_index += 1
            pending = []
    return mapping


def build_events(messages: list[dict]) -> tuple[list[dict], dict, dict]:
    call_names: dict[str, str] = {}
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            if call.get("id"):
                call_names[call["id"]] = fn.get("name") or "Tool"

    events: list[dict] = []
    counts = Counter()
    tool_counts = Counter()
    for index, message in enumerate(messages):
        role = message.get("role")
        content = text_content(message)
        if role == "system":
            events.append({"type": "system", "sourceIndex": index, "title": "System context", "content": content})
            counts["system"] += 1
        elif role == "user":
            event_type = "context" if is_context_message(content) else "user"
            title = "Injected context" if event_type == "context" else "User request"
            events.append({"type": event_type, "sourceIndex": index, "title": title, "content": content})
            counts[event_type] += 1
        elif role == "assistant":
            thinking = message.get("_step4_thinking")
            if isinstance(thinking, str) and thinking.strip():
                events.append({"type": "thinking", "sourceIndex": index, "title": "Agent reasoning", "content": redact(thinking)})
                counts["thinking"] += 1
            if content.strip():
                events.append({"type": "assistant", "sourceIndex": index, "title": "Assistant message", "content": content})
                counts["assistant"] += 1
            for call in message.get("tool_calls") or []:
                fn = call.get("function") or {}
                name = fn.get("name") or "Tool"
                args = fn.get("arguments", "")
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                events.append({
                    "type": "tool_call", "sourceIndex": index, "title": name,
                    "toolCallId": call.get("id", ""), "content": redact(args)
                })
                counts["tool_call"] += 1
                tool_counts[name] += 1
        elif role == "tool":
            call_id = message.get("tool_call_id", "")
            name = call_names.get(call_id, "Tool")
            summary = message.get("_tool_response_summary") or message.get("_step4_tool_summary") or ""
            events.append({
                "type": "tool_result", "sourceIndex": index, "title": f"{name} result",
                "toolCallId": call_id, "status": tool_status(content),
                "summary": redact(summary) if isinstance(summary, str) else "", "content": content
            })
            counts["tool_result"] += 1
    return events, dict(counts), dict(tool_counts)


def load_real_usage(raw_dir: Path, request_ids: set[str]) -> dict[str, dict]:
    """Index recorder files by unique request_id and return their real API usage."""
    usage_by_request: dict[str, dict] = {}
    request_pattern = re.compile(rb'"request_id"\s*:\s*"([^"]+)"')
    for path in raw_dir.glob("*.json"):
        try:
            with path.open("rb") as stream:
                header = stream.read(16384)
        except OSError:
            continue
        match = request_pattern.search(header)
        if not match:
            continue
        request_id = match.group(1).decode("utf-8", "replace")
        if request_id not in request_ids:
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        response_data = ((record.get("response") or {}).get("response_data") or {})
        response_usage = response_data.get("usage") or {}
        prompt_tokens = int(record.get("prompt_tokens") or 0)
        completion_tokens = int(record.get("completion_tokens") or 0)
        cache_read_tokens = int(record.get("cache_read_tokens") or 0)
        cache_write_tokens = int(record.get("cache_write_tokens") or 0)
        uncached_tokens = prompt_tokens - cache_read_tokens
        raw_input_tokens = prompt_tokens - cache_read_tokens - cache_write_tokens
        usage_by_request[request_id] = {
            "promptTokens": prompt_tokens,
            "cachedInput": cache_read_tokens,
            "cacheWrite": cache_write_tokens,
            "uncachedInput": uncached_tokens,
            "rawInput": raw_input_tokens,
            "output": completion_tokens,
            "total": prompt_tokens + completion_tokens,
            "serviceTier": response_usage.get("service_tier"),
            "thinkingTokens": ((response_usage.get("output_tokens_details") or {}).get("thinking_tokens")),
            "source": "session-recorder",
            "requestId": request_id,
        }
    return usage_by_request


def camel_meta(row: dict, trace: dict, node_sources: dict[int, list[int]], dataset: dict) -> dict:
    clean = trace.get("_clean_meta") or {}
    classification = trace.get("_step4_task_judge") or {}
    refinement = trace.get("_step5_meta") or {}
    route_record = row.get("_step5_route") or row.get("_step2_route") or {}
    list_judge = trace.get("_step4_list_judge") or {}
    segments = []
    for segment in list_judge.get("segments") or []:
        nodes = segment.get("nodes") or []
        segments.append({
            "nodes": nodes,
            "nodeSources": {str(node): node_sources.get(node, []) for node in nodes},
            "label": segment.get("label", ""),
            "pattern": segment.get("pattern", ""),
            "reason": redact(segment.get("reason", "")),
        })
    thinking_count = sum(1 for message in trace.get("messages") or [] if message.get("_step4_thinking"))
    quality = refinement.get("quality") or {}
    difficulty = refinement.get("difficulty") or {}
    return {
        "clean": {
            "trimmedTrailing": clean.get("trimmed_trailing"),
            "nonSystemMessages": clean.get("non_system_messages"),
            "errorRate": clean.get("error_rate"),
            "completeToolPairs": clean.get("complete_tool_pairs"),
            "estimatedTokens": clean.get("estimated_tokens"),
            "dangerousHits": clean.get("dangerous_hits"),
            "passed": clean.get("passed"),
            "rejectReason": clean.get("reject_reason", ""),
        },
        "classification": {
            "isSafe": classification.get("is_safe"),
            "taskType": classification.get("task_type"),
            "situation": classification.get("situation"),
            "isSafeReasoning": redact(classification.get("is_safe_reasoning", "")),
            "taskTypeReasoning": redact(classification.get("task_type_reasoning", "")),
            "situationReasoning": redact(classification.get("situation_reasoning", "")),
        },
        "routing": {
            "category": refinement.get("category"),
            "effectiveCategory": refinement.get("effective_category"),
            "taskTypeSource": refinement.get("task_type_source"),
            "valueTier": refinement.get("value_tier"),
            "searchMainType": refinement.get("search_main_type"),
            "rescuedVia": refinement.get("rescued_via"),
            "votes": " · ".join(f"{name.title()} {value:g}" for name, value in (route_record.get("votes") or {}).items()),
            "mainKept": route_record.get("n_main_kept"),
            "tieBroken": route_record.get("tie_broken"),
            "anyRescued": route_record.get("any_rescued"),
        },
        "quality": {
            "flag": quality.get("flag"), "reasons": quality.get("reasons") or [],
            "toolSteps": quality.get("n_tool_steps"), "errorRatio": quality.get("error_ratio"),
            "maxErrorChain": quality.get("max_error_chain"), "maxNoProgress": quality.get("max_noprogress"),
            "repeatRatio": quality.get("repeat_ratio"), "topRepeat": quality.get("top_repeat"),
        },
        "difficulty": {
            "flag": difficulty.get("flag"), "reasons": difficulty.get("reasons") or [],
            "userTurns": difficulty.get("user_turns"), "distinctTaskCount": difficulty.get("distinct_task_count"),
            "toolCallsTotal": difficulty.get("tool_calls_total"), "longestLoopRatio": difficulty.get("longest_loop_ratio"),
        },
        "segmentSummary": {
            "outcomeConfirmed": list_judge.get("traj_outcome_confirm"),
            "segmentCount": list_judge.get("n_segments"),
            "highQualityRatio": list_judge.get("high_quality_ratio"),
            "lowQualityRatio": list_judge.get("low_quality_ratio"),
            "highNodes": list_judge.get("high_nodes"), "lowNodes": list_judge.get("low_nodes"),
            "totalNodes": list_judge.get("total_nodes"),
        },
        "segments": segments,
        "thinkingClean": {
            "category": refinement.get("effective_category"),
            "status": "Step 4.5 not run",
            "withThinking": thinking_count,
            "dropped": None,
            "nearDuplicates": None,
        },
        "dataset": dataset,
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "Usage: import-feedback-snapshots.py "
            "/path/to/successful_with_snapshots.jsonl /path/to/session-recorder-dir"
        )
    source = Path(sys.argv[1]).expanduser().resolve()
    raw_dir = Path(sys.argv[2]).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Source file not found: {source}")
    if not raw_dir.is_dir():
        raise SystemExit(f"Recorder directory not found: {raw_dir}")
    rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    request_ids = {row["traces"][0].get("request_id") for row in rows}
    if None in request_ids:
        raise SystemExit("At least one snapshot has no request_id")
    real_usage = load_real_usage(raw_dir, request_ids)
    missing_usage = sorted(request_ids - set(real_usage))
    if missing_usage:
        raise SystemExit(f"Missing recorder usage for {len(missing_usage)} request_id(s): {missing_usage}")
    totals = Counter(row.get("conversation_id") for row in rows)
    ordinals = defaultdict(int)
    task_types = Counter()
    outcomes = Counter()
    tiers = Counter()
    estimated_values = []
    tool_values = []

    for row in rows:
        trace = row["traces"][0]
        classification = trace.get("_step4_task_judge") or {}
        refinement = trace.get("_step5_meta") or {}
        clean = trace.get("_clean_meta") or {}
        task_types[classification.get("task_type") or "unknown"] += 1
        outcomes[classification.get("situation") or "unknown"] += 1
        tiers[refinement.get("value_tier") or "none"] += 1
        estimated_values.append(clean.get("estimated_tokens") or 0)
        tool_values.append(row.get("tool_call_count") or 0)

    dataset = {
        "sourceFile": source.name,
        "trajectoryCount": len(rows),
        "uniqueConversations": len(totals),
        "toolCallCount": sum(tool_values),
        "estimatedTokens": sum(estimated_values),
        "minToolCalls": min(tool_values), "maxToolCalls": max(tool_values),
        "minEstimatedTokens": min(estimated_values), "maxEstimatedTokens": max(estimated_values),
        "taskTypeDistribution": " · ".join(f"{count} {name.replace('_', ' ')}" for name, count in task_types.most_common()),
        "outcomeDistribution": " · ".join(f"{count} {name}" for name, count in outcomes.most_common()),
        "valueTierDistribution": " · ".join(f"{count} {name.upper()}" for name, count in tiers.most_common()),
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for position, row in enumerate(rows, 1):
        conversation_id = row["conversation_id"]
        ordinals[conversation_id] += 1
        ordinal = ordinals[conversation_id]
        total = totals[conversation_id]
        run_id = f"snapshot-{position:02d}-{conversation_id}"
        short_id = conversation_id[:8]
        trace = row["traces"][0]
        classification = trace.get("_step4_task_judge") or {}
        refinement = trace.get("_step5_meta") or {}
        clean = trace.get("_clean_meta") or {}
        messages = trace.get("messages") or []
        request_id = trace.get("request_id")
        usage = real_usage[request_id]
        events, counts, tool_counts = build_events(messages)
        node_sources = build_node_sources(messages)
        pipeline = camel_meta(row, trace, node_sources, dataset)
        task_type = classification.get("task_type") or "other"
        snapshot_label = f"Snapshot {ordinal}/{total}" if total > 1 else "Single snapshot"
        title = f"{TASK_LABELS.get(task_type, task_type.replace('_', ' ').title())} · {short_id}"
        if total > 1:
            title += f" · S{ordinal}/{total}"
        event_file = f"{position:02d}-{short_id}-s{ordinal}.json"
        payload = {"events": events}
        (OUTPUT_DIR / event_file).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        agent_steps = pipeline["segmentSummary"].get("totalNodes") or sum(1 for message in messages if message.get("role") == "assistant")
        index.append({
            "id": run_id,
            "conversationId": conversation_id,
            "shortId": short_id,
            "title": title,
            "trajectoryClass": "feedback",
            "snapshotLabel": snapshot_label,
            "snapshotOrdinal": ordinal,
            "snapshotTotal": total,
            "model": row.get("model", ""),
            "dataSource": row.get("data_source", ""),
            "category": refinement.get("effective_category") or refinement.get("category") or "",
            "taskType": task_type,
            "valueTier": refinement.get("value_tier"),
            "situation": classification.get("situation", ""),
            "messageCount": len(messages),
            "toolCallCount": row.get("tool_call_count") or counts.get("tool_call", 0),
            "agentStepCount": agent_steps,
            "estimatedTokens": clean.get("estimated_tokens") or 0,
            "errorRate": clean.get("error_rate"),
            "counts": counts,
            "toolCounts": tool_counts,
            "eventCount": len(events),
            "events": None,
            "lazyData": f"data/feedback-snapshots/{event_file}",
            "tokenUsageEstimated": False,
            "tokenUsage": usage,
            "agent": "Claude Code",
            "environment": {
                "family": "Feedback trajectory snapshot",
                "sourceFile": source.name,
                "runtime": "Claude Code / WorkBuddy",
                "model": row.get("model", ""),
                "verifier": "Feedback quality pipeline",
                "outcome": classification.get("situation", ""),
                "snapshot": snapshot_label,
                "conversationId": conversation_id,
                "requestId": request_id,
                "serviceTier": usage.get("serviceTier"),
                "taskSummary": redact(classification.get("task_type_reasoning", "")),
            },
            "pipelineDetail": pipeline,
        })

    encoded = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
    encoded = encoded.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    INDEX_FILE.write_text("window.EMPIRIA_FEEDBACK_SNAPSHOTS=" + encoded + ";\n", encoding="utf-8")
    print(f"Generated {len(index)} snapshot entries in {OUTPUT_DIR}")
    print(f"Matched real usage for {len(real_usage)}/{len(request_ids)} request IDs")
    print(f"Index: {INDEX_FILE} ({INDEX_FILE.stat().st_size:,} bytes)")
    print(f"Payload: {sum(path.stat().st_size for path in OUTPUT_DIR.glob('*.json')):,} bytes")


if __name__ == "__main__":
    main()
