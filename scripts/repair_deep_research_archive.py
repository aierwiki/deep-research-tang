#!/usr/bin/env python3
"""Auto-repair helper for deep-research archive.

For each FAIL error code emitted by check_deep_research_archive.py, this
script applies the minimum fix action and then re-runs the checker.
The loop retries up to --max-retries times.

Exit codes:
  0  – archive passes check after repair
  1  – archive still fails after max retries (or unrecoverable error)

Usage:
  python scripts/repair_deep_research_archive.py \
    --research-dir research_20260411_api-gateway [--strict] [--max-retries 3]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from deep_research_state_machine import (
    DepthMode,
    ResearchStatus,
    TransitionEvent,
    load_meta,
    save_meta,
)

SCRIPTS_DIR = Path(__file__).parent
CHECKER     = SCRIPTS_DIR / "check_deep_research_archive.py"
TEMPLATES_DIR = Path(__file__).parent.parent / "templates"


# ------------------------------------------------------------------ #
# Checker runner                                                      #
# ------------------------------------------------------------------ #

def run_checker(research_dir: Path, strict: bool, round_num: int | None = None) -> dict:
    cmd = [sys.executable, str(CHECKER), "--research-dir", str(research_dir)]
    if strict:
        cmd.append("--strict")
    if round_num is not None:
        cmd += ["--round", str(round_num)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"result": "FAIL" if result.returncode != 0 else "PASS", "errors": []}


# ------------------------------------------------------------------ #
# Template helpers                                                    #
# ------------------------------------------------------------------ #

def load_json_template(name: str) -> dict:
    path = TEMPLATES_DIR / name
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ------------------------------------------------------------------ #
# Individual repair actions                                           #
# ------------------------------------------------------------------ #

def repair_missing_file(research_dir: Path, error: dict) -> bool:
    detail: str = error.get("detail", "")
    round_num: int | None = error.get("round")

    # Determine relative path from detail
    rel = detail.split("not found")[0].strip()
    target = research_dir / rel

    if target.exists():
        return True  # already fixed

    if rel.endswith("00_research_brief.md"):
        write_text(target, "# 研究任务说明\n\n## 原始问题\n\n（请补充）\n")
        return True

    if rel.endswith("00_meta.json"):
        # Cannot safely auto-create meta without user input
        print(f"  [repair] Cannot auto-create 00_meta.json — fill it manually", file=sys.stderr)
        return False

    # Round files
    if round_num is not None:
        pad = str(round_num).zfill(2)
        if rel.endswith("01_seed_clues.json"):
            tmpl = load_json_template("01_seed_clues.json")
            tmpl["round"] = round_num
            write_json(target, tmpl)
            return True
        if rel.endswith("02_task_registry.json"):
            tmpl = load_json_template("02_task_registry.json")
            tmpl["round"] = round_num
            write_json(target, tmpl)
            return True
        if rel.endswith("03_round_summary.md"):
            src = TEMPLATES_DIR / "03_round_summary.md"
            write_text(target, src.read_text(encoding="utf-8") if src.exists() else f"# Round {round_num} Summary\n\n")
            return True
        if rel.endswith("04_delta_report.json"):
            tmpl = load_json_template("04_delta_report.json")
            tmpl["round"] = round_num
            write_json(target, tmpl)
            return True

    # Unknown — create empty placeholder
    print(f"  [repair] Creating placeholder: {rel}", file=sys.stderr)
    write_text(target, "")
    return True


def repair_invalid_json(research_dir: Path, error: dict) -> bool:
    round_num: int | None = error.get("round")
    detail: str = error.get("detail", "")
    if round_num is None:
        return False
    pad = str(round_num).zfill(2)

    if "02_task_registry" in detail:
        tmpl = load_json_template("02_task_registry.json")
        tmpl["round"] = round_num
        write_json(research_dir / f"round_{pad}" / "02_task_registry.json", tmpl)
        return True
    if "04_delta_report" in detail:
        tmpl = load_json_template("04_delta_report.json")
        tmpl["round"] = round_num
        write_json(research_dir / f"round_{pad}" / "04_delta_report.json", tmpl)
        return True
    return False


def repair_duplicate_question(research_dir: Path, error: dict) -> bool:
    """Cannot auto-fix semantic duplicates — just warn."""
    print(f"  [repair] WARN: duplicate key_question detected — manual fix required: {error.get('detail')}", file=sys.stderr)
    return False


def repair_duplicate_report_path(research_dir: Path, error: dict) -> bool:
    print(f"  [repair] WARN: duplicate report_path — manual fix required: {error.get('detail')}", file=sys.stderr)
    return False


def repair_task_file_missing(research_dir: Path, error: dict) -> bool:
    detail: str = error.get("detail", "")
    # Extract path from: "task R01-T01 report_path missing: round_01/tasks/task_01_foo.md"
    parts = detail.split("missing:")
    if len(parts) < 2:
        return False
    rel = parts[-1].strip()
    target = research_dir / rel
    if target.exists():
        return True
    src = TEMPLATES_DIR / "task_report.md"
    write_text(target, src.read_text(encoding="utf-8") if src.exists() else "# Task Report\n\n")
    return True


def repair_delta_no_findings(research_dir: Path, error: dict) -> bool:
    print(f"  [repair] WARN: not enough findings in delta — manual fix required", file=sys.stderr)
    return False


def repair_clue_chain_broken(research_dir: Path, error: dict) -> bool:
    print(f"  [repair] WARN: clue chain broken — manual fix required: {error.get('detail')}", file=sys.stderr)
    return False


def repair_depth_mismatch(research_dir: Path, error: dict) -> bool:
    """Update meta current_round to match actual completed rounds on disk."""
    import re
    completed = sorted([
        int(m.group(1))
        for p in research_dir.iterdir()
        if p.is_dir() and (m := re.fullmatch(r"round_(\d+)", p.name))
    ])
    if not completed:
        return False
    meta = load_meta(research_dir)
    actual = completed[-1]
    if actual == meta.current_round:
        return True
    print(f"  [repair] Updating current_round {meta.current_round} -> {actual}", file=sys.stderr)
    meta.current_round = actual
    if meta.current_round >= meta.target_depth:
        meta.status = ResearchStatus.READY_FOR_FINAL_REPORT
    elif meta.current_round > 0:
        meta.status = ResearchStatus.READY_FOR_NEXT_ROUND
    save_meta(research_dir, meta)
    return True


REPAIR_MAP = {
    "ERR_MISSING_FILE":               repair_missing_file,
    "ERR_INVALID_JSON":               repair_invalid_json,
    "ERR_TASK_DUPLICATE_QUESTION":    repair_duplicate_question,
    "ERR_TASK_DUPLICATE_REPORT_PATH": repair_duplicate_report_path,
    "ERR_TASK_FILE_MISSING":          repair_task_file_missing,
    "ERR_DELTA_NO_FINDINGS":          repair_delta_no_findings,
    "ERR_CLUE_CHAIN_BROKEN":          repair_clue_chain_broken,
    "ERR_DEPTH_MISMATCH":             repair_depth_mismatch,
}


# ------------------------------------------------------------------ #
# Main repair loop                                                    #
# ------------------------------------------------------------------ #

def repair_loop(research_dir: Path, strict: bool, max_retries: int) -> bool:
    for attempt in range(1, max_retries + 1):
        report = run_checker(research_dir, strict)
        if report["result"] == "PASS":
            print(f"[repair] PASS after {attempt - 1} repair attempt(s)")
            return True

        errors = report.get("errors", [])
        print(f"[repair] Attempt {attempt}/{max_retries}: {len(errors)} error(s)")

        any_fixed = False
        for err in errors:
            code = err.get("code", "")
            print(f"  [{code}] {err.get('detail', '')}")
            fn = REPAIR_MAP.get(code)
            if fn:
                fixed = fn(research_dir, err)
                if fixed:
                    any_fixed = True
            else:
                print(f"  [repair] No handler for {code} — skipping", file=sys.stderr)

        if not any_fixed:
            print("[repair] No repairs applied — cannot auto-fix remaining errors", file=sys.stderr)
            break

    # Final check
    final = run_checker(research_dir, strict)
    if final["result"] == "PASS":
        print("[repair] PASS")
        return True

    print("[repair] FAIL — manual intervention required", file=sys.stderr)
    print(json.dumps(final, ensure_ascii=False, indent=2), file=sys.stderr)
    return False


# ------------------------------------------------------------------ #
# CLI                                                                 #
# ------------------------------------------------------------------ #

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Auto-repair deep-research archive")
    p.add_argument("--research-dir", type=Path, required=True)
    p.add_argument("--strict", action="store_true")
    p.add_argument("--max-retries", type=int, default=3)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    ok = repair_loop(args.research_dir, args.strict, args.max_retries)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
