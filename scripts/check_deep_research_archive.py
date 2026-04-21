#!/usr/bin/env python3
"""Strict validator for deep-research archive directories.

Exit codes:
  0  PASS  - archive is fully compliant
  1  FAIL  - one or more rule violations (see JSON output on stdout)

Usage:
  python scripts/check_deep_research_archive.py --research-dir research_20260411_api-gateway [--strict] [--round N]

JSON output format:
  {
    "result": "PASS" | "FAIL",
    "research_dir": "...",
    "checked_rounds": [1, 2, ...],
    "errors": [
      {"code": "ERR_MISSING_FILE", "round": 1, "detail": "round_01/02_task_registry.json not found"},
      ...
    ]
  }
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from deep_research_state_machine import DepthMode, load_meta


# ------------------------------------------------------------------ #
# Error codes                                                         #
# ------------------------------------------------------------------ #

ERR_META_MISSING        = "ERR_META_MISSING"
ERR_META_INVALID        = "ERR_META_INVALID"
ERR_DEPTH_MISMATCH      = "ERR_DEPTH_MISMATCH"
ERR_MISSING_FILE        = "ERR_MISSING_FILE"
ERR_INVALID_JSON        = "ERR_INVALID_JSON"
ERR_TASK_DUPLICATE_Q    = "ERR_TASK_DUPLICATE_QUESTION"
ERR_TASK_DUPLICATE_PATH = "ERR_TASK_DUPLICATE_REPORT_PATH"
ERR_TASK_ILLEGAL_DEP    = "ERR_TASK_ILLEGAL_DEPENDS_ON"
ERR_TASK_FILE_MISSING   = "ERR_TASK_FILE_MISSING"
ERR_TASK_REGISTRY_EMPTY = "ERR_TASK_REGISTRY_EMPTY"
ERR_TASK_REGISTRY_ALIGN = "ERR_TASK_REGISTRY_ALIGN"
ERR_DELTA_NO_FINDINGS   = "ERR_DELTA_NO_FINDINGS"
ERR_DELTA_NO_CLUES      = "ERR_DELTA_NO_CLUES"
ERR_CLUE_CHAIN_BROKEN   = "ERR_CLUE_CHAIN_BROKEN"
ERR_DIMENSION_OVERFIT   = "ERR_DIMENSION_OVERFIT"
ERR_FINAL_REPORT_PREMATURE = "ERR_FINAL_REPORT_PREMATURE"
ERR_COMPLETED_WITHOUT_FINAL_REPORT = "ERR_COMPLETED_WITHOUT_FINAL_REPORT"


def _err(code: str, detail: str, round_num: int | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"code": code, "detail": detail}
    if round_num is not None:
        e["round"] = round_num
    return e


FINAL_REPORT_PLACEHOLDER = (
    "# 最终研究报告\n\n## 核心结论\n\n- \n\n## 关键发现与证据来源\n\n- 发现：\n  来源：\n\n## 具体建议\n\n- \n\n## 局限性与不确定性\n\n- "
)


def is_placeholder_final_report(content: str) -> bool:
    return "replace-with" in content or content.strip() == FINAL_REPORT_PLACEHOLDER


# ------------------------------------------------------------------ #
# Per-round checks                                                    #
# ------------------------------------------------------------------ #

def check_round(research_dir: Path, n: int, strict: bool) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    rdir = research_dir / f"round_{n:02d}"

    required_files = [
        f"round_{n:02d}/01_seed_clues.json",
        f"round_{n:02d}/02_task_registry.json",
        f"round_{n:02d}/03_round_summary.md",
        f"round_{n:02d}/04_delta_report.json",
    ]
    for rel in required_files:
        if not (research_dir / rel).exists():
            errors.append(_err(ERR_MISSING_FILE, f"{rel} not found", n))

    # ---- task registry ----
    registry_path = rdir / "02_task_registry.json"
    if not registry_path.exists():
        return errors  # already recorded above

    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(_err(ERR_INVALID_JSON, f"02_task_registry.json: {exc}", n))
        return errors

    tasks = registry.get("tasks", [])
    if not tasks:
        errors.append(_err(ERR_TASK_REGISTRY_EMPTY, "02_task_registry.json has no tasks", n))
        return errors

    questions: list[str] = []
    report_paths: list[str] = []
    dimensions: list[str] = []

    for task in tasks:
        tid = task.get("task_id", "?")

        q = str(task.get("key_question", "")).strip()
        if q:
            questions.append(q)

        rp = str(task.get("report_path", "")).strip()
        if rp:
            report_paths.append(rp)

        dep = task.get("depends_on", [])
        if dep:
            errors.append(_err(ERR_TASK_ILLEGAL_DEP,
                               f"task {tid} has non-empty depends_on: {dep}", n))

        dim = str(task.get("research_dimension", "")).strip().lower()
        if dim:
            dimensions.append(dim)

        # task result file must exist
        if rp and not (research_dir / rp).exists():
            errors.append(_err(ERR_TASK_FILE_MISSING, f"task {tid} report_path missing: {rp}", n))

    # duplicate key_question
    seen_q: set[str] = set()
    for q in questions:
        if q in seen_q:
            errors.append(_err(ERR_TASK_DUPLICATE_Q, f"duplicate key_question: {q!r}", n))
        seen_q.add(q)

    # duplicate report_path
    seen_rp: set[str] = set()
    for rp in report_paths:
        if rp in seen_rp:
            errors.append(_err(ERR_TASK_DUPLICATE_PATH, f"duplicate report_path: {rp!r}", n))
        seen_rp.add(rp)

    # dimension overfit: if strict and >70% tasks share same dimension
    if strict and dimensions:
        from collections import Counter
        top_dim, top_cnt = Counter(dimensions).most_common(1)[0]
        ratio = top_cnt / len(dimensions)
        if ratio > 0.7 and len(dimensions) > 2:
            errors.append(_err(ERR_DIMENSION_OVERFIT,
                               f"dimension '{top_dim}' covers {top_cnt}/{len(dimensions)} tasks (>{70}%)", n))

    # ---- delta report ----
    delta_path = rdir / "04_delta_report.json"
    if not delta_path.exists():
        return errors

    try:
        delta = json.loads(delta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(_err(ERR_INVALID_JSON, f"04_delta_report.json: {exc}", n))
        return errors

    findings = delta.get("new_findings", [])
    real_findings = [f for f in findings if not str(f.get("summary", "")).startswith("replace-with")]
    if strict and len(real_findings) < 3:
        errors.append(_err(ERR_DELTA_NO_FINDINGS,
                           f"04_delta_report.json has {len(real_findings)} real findings, need >= 3", n))

    clues = delta.get("carry_forward_clues", [])
    real_clues = [c for c in clues if not str(c.get("question", "")).startswith("replace-with")]
    if strict and not real_clues:
        errors.append(_err(ERR_DELTA_NO_CLUES,
                           "04_delta_report.json has no carry_forward_clues", n))

    return errors


def check_clue_chain(research_dir: Path, rounds: list[int]) -> list[dict[str, Any]]:
    """Round N's seed_clues must reference round N-1's carry_forward_clues."""
    errors: list[dict[str, Any]] = []
    for n in rounds:
        if n <= 1:
            continue
        prev_delta = research_dir / f"round_{n-1:02d}" / "04_delta_report.json"
        curr_seed  = research_dir / f"round_{n:02d}"   / "01_seed_clues.json"
        if not prev_delta.exists() or not curr_seed.exists():
            continue
        try:
            delta = json.loads(prev_delta.read_text(encoding="utf-8"))
            seed  = json.loads(curr_seed.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue

        prev_clue_ids = {c.get("clue_id") for c in delta.get("carry_forward_clues", [])}
        seed_refs     = {c.get("source_ref") for c in seed.get("seed_clues", [])}
        # Also accept clue_id directly in seed_clues
        seed_clue_ids = {c.get("clue_id") for c in seed.get("seed_clues", [])}

        if prev_clue_ids and not (prev_clue_ids & seed_refs) and not (prev_clue_ids & seed_clue_ids):
            errors.append(_err(
                ERR_CLUE_CHAIN_BROKEN,
                f"round_{n:02d}/01_seed_clues.json does not reference any carry_forward_clues from round {n-1}",
                n,
            ))
    return errors


# ------------------------------------------------------------------ #
# Top-level check                                                     #
# ------------------------------------------------------------------ #

def check_archive(research_dir: Path, strict: bool, only_round: int | None) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []

    # meta
    try:
        meta = load_meta(research_dir)
    except FileNotFoundError:
        errors.append(_err(ERR_META_MISSING, f"{research_dir}/00_meta.json not found"))
        return {"result": "FAIL", "research_dir": str(research_dir), "checked_rounds": [], "errors": errors}
    except Exception as exc:
        errors.append(_err(ERR_META_INVALID, str(exc)))
        return {"result": "FAIL", "research_dir": str(research_dir), "checked_rounds": [], "errors": errors}

    # 00_research_brief.md
    if not (research_dir / "00_research_brief.md").exists():
        errors.append(_err(ERR_MISSING_FILE, "00_research_brief.md not found"))

    # determine rounds to check
    completed_rounds = sorted([
        int(m.group(1))
        for p in research_dir.iterdir()
        if p.is_dir() and (m := re.fullmatch(r"round_(\d+)", p.name))
    ])

    if only_round is not None:
        rounds_to_check = [only_round] if only_round in completed_rounds else []
    else:
        rounds_to_check = completed_rounds

    for n in rounds_to_check:
        errors.extend(check_round(research_dir, n, strict))

    if not only_round:
        errors.extend(check_clue_chain(research_dir, completed_rounds))

    # depth completeness check (only in strict mode, not round-specific)
    if strict and only_round is None:
        if meta.depth_mode == DepthMode.USER_SPECIFIED:
            if meta.current_round < meta.target_depth:
                errors.append(_err(
                    ERR_DEPTH_MISMATCH,
                    f"target_depth={meta.target_depth} but current_round={meta.current_round}",
                ))

    # final_report premature: must not appear before depth reached
    final_path = research_dir / "final_report.md"
    if final_path.exists() and strict:
        content = final_path.read_text(encoding="utf-8")
        # Template placeholder means it hasn't been written yet — skip
        is_placeholder = is_placeholder_final_report(content)
        if not is_placeholder and meta.current_round < meta.target_depth:
            errors.append(_err(
                ERR_FINAL_REPORT_PREMATURE,
                f"final_report.md exists but only {meta.current_round}/{meta.target_depth} rounds completed",
            ))
        if meta.status.value == "completed" and is_placeholder:
            errors.append(_err(
                ERR_COMPLETED_WITHOUT_FINAL_REPORT,
                "meta.status is completed but final_report.md is still a placeholder",
            ))
    elif strict and meta.status.value == "completed":
        errors.append(_err(
            ERR_COMPLETED_WITHOUT_FINAL_REPORT,
            "meta.status is completed but final_report.md is missing",
        ))

    result = "PASS" if not errors else "FAIL"
    return {
        "result": result,
        "research_dir": str(research_dir),
        "checked_rounds": rounds_to_check,
        "errors": errors,
    }


# ------------------------------------------------------------------ #
# CLI                                                                 #
# ------------------------------------------------------------------ #

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a deep-research archive")
    parser.add_argument("--research-dir", type=Path, required=True)
    parser.add_argument("--strict", action="store_true",
                        help="Enable extra checks: delta findings count, dimension overfit, depth completion")
    parser.add_argument("--round", type=int, default=None,
                        help="Check only a specific round number")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress JSON output; only set exit code")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = check_archive(
        research_dir=args.research_dir,
        strict=args.strict,
        only_round=args.round,
    )
    if not args.quiet:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["result"] == "PASS" else 1)


if __name__ == "__main__":
    main()
