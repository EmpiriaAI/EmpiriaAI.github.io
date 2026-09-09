#!/usr/bin/env python3
"""Re-apply the fixed event classification to already-exported snapshots.

Regenerating from the source JSONL needs the recorder directory and the
upstream pipeline output, neither of which travels with this repository. The
classification itself is a pure function of the exported event, though, so it
can be re-applied in place — which is how the published data gets corrected
without a full re-run.

It imports the real functions from import-feedback-snapshots.py rather than
copying them, so the two can never drift.

    python3 tools/recompute-event-kinds.py            # report only
    python3 tools/recompute-event-kinds.py --write    # rewrite the snapshots
    python3 tools/recompute-event-kinds.py --write --re-redact
"""

from __future__ import annotations

import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_DIR = ROOT / "data" / "feedback-snapshots"
INDEX_FILE = ROOT / "feedback-snapshot-index.js"

spec = importlib.util.spec_from_file_location(
    "import_feedback_snapshots", Path(__file__).with_name("import-feedback-snapshots.py")
)
importer = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(importer)


def classify(events: list[dict], re_redact: bool) -> tuple[list[dict], Counter, Counter]:
    """Return (events, kind counts, status transitions)."""
    kinds: Counter = Counter()
    moves: Counter = Counter()
    seen_system = False

    for event in events:
        kind = event["type"]
        if re_redact:
            for field in ("content", "summary"):
                if isinstance(event.get(field), str):
                    event[field] = importer.redact(event[field])

        if event["type"] == "system":
            kind = "system" if not seen_system else "inject"
            seen_system = True
            if kind == "inject":
                event["title"] = "Per-turn injection"
        elif event["type"] in {"user", "context"}:
            kind = importer.user_kind(event.get("content") or "")
            event["title"] = {
                "context": "Injected context", "interrupt": "User interrupt",
                "notify": "Task notification", "command": "Slash command",
                "user": "User request",
            }[kind]
            event["type"] = "context" if kind == "context" else "user"
        elif event["type"] == "tool_result":
            before = event.get("status")
            after = importer.tool_status({}, event.get("content") or "")
            if before != after:
                moves[f"{before} -> {after}"] += 1
            event["status"] = after

        event["kind"] = kind
        kinds[kind] += 1

    return events, kinds, moves


def main() -> None:
    write = "--write" in sys.argv
    re_redact = "--re-redact" in sys.argv
    totals: Counter = Counter()
    moves: Counter = Counter()
    kind_by_file: dict[str, dict] = {}

    for path in sorted(SNAPSHOT_DIR.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        events, kinds, file_moves = classify(payload.get("events") or [], re_redact)
        totals.update(kinds)
        moves.update(file_moves)
        kind_by_file[f"data/feedback-snapshots/{path.name}"] = dict(kinds)
        if write:
            payload["events"] = events
            path.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
            )

    if write:
        raw = INDEX_FILE.read_text(encoding="utf-8")
        index = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";\n").rstrip(";"))
        for row in index:
            counts = kind_by_file.get(row.get("lazyData"))
            if counts:
                row["kindCounts"] = counts
        encoded = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
        encoded = encoded.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        INDEX_FILE.write_text("window.EMPIRIA_FEEDBACK_SNAPSHOTS=" + encoded + ";\n", encoding="utf-8")

    print("status transitions")
    for move, count in moves.most_common():
        print(f"  {move:24s} {count}")
    print("\nkind counts")
    for kind, count in totals.most_common():
        print(f"  {kind:14s} {count}")
    print("\n" + ("written" if write else "dry run — pass --write to apply"))


if __name__ == "__main__":
    main()
