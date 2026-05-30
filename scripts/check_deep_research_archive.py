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
ERR_TASK_MISSING_FIELD  = "ERR_TASK_MISSING_FIELD"
ERR_TASK_ACTIONS_SHORT  = "ERR_TASK_ACTIONS_SHORT"
ERR_TASK_REPORT_SECTION_MISSING = "ERR_TASK_REPORT_SECTION_MISSING"
ERR_TASK_REPORT_MISMATCH = "ERR_TASK_REPORT_MISMATCH"
ERR_TASK_REPORT_THIN = "ERR_TASK_REPORT_THIN"
ERR_TASK_REGISTRY_ALIGN = "ERR_TASK_REGISTRY_ALIGN"
ERR_DELTA_NO_FINDINGS   = "ERR_DELTA_NO_FINDINGS"
ERR_DELTA_NO_CLUES      = "ERR_DELTA_NO_CLUES"
ERR_CLUE_CHAIN_BROKEN   = "ERR_CLUE_CHAIN_BROKEN"
ERR_DIMENSION_OVERFIT   = "ERR_DIMENSION_OVERFIT"
ERR_FINAL_REPORT_PREMATURE = "ERR_FINAL_REPORT_PREMATURE"
ERR_COMPLETED_WITHOUT_FINAL_REPORT = "ERR_COMPLETED_WITHOUT_FINAL_REPORT"
ERR_FINAL_REPORT_SECTION_MISSING = "ERR_FINAL_REPORT_SECTION_MISSING"
ERR_FINAL_REPORT_THIN = "ERR_FINAL_REPORT_THIN"
ERR_FINAL_REPORT_SOURCE_GAP = "ERR_FINAL_REPORT_SOURCE_GAP"


def _err(code: str, detail: str, round_num: int | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"code": code, "detail": detail}
    if round_num is not None:
        e["round"] = round_num
    return e


FINAL_REPORT_PLACEHOLDER = (
    "# 最终研究报告\n\n## 核心结论\n\n- \n\n## 跨轮综合与证据权重\n\n- 结论：\n  综合依据：\n  证据权重说明：\n\n## 关键发现与证据来源\n\n- 发现：\n  来源：R01-T01, R02-T03\n\n## 时效性与交叉验证\n\n- 关键时间点：\n  信息日期/数据日期：\n  验证动作：\n  交叉来源：\n\n## 具体建议\n\n- \n\n## 局限性与不确定性\n\n- "
)
REQUIRED_FINAL_REPORT_SECTIONS = [
    "核心结论",
    "跨轮综合与证据权重",
    "关键发现与证据来源",
    "时效性与交叉验证",
    "具体建议",
    "局限性与不确定性",
]

REQUIRED_TASK_FIELDS = [
    "task_id",
    "title",
    "task_type",
    "research_dimension",
    "key_question",
    "planned_actions",
    "expected_evidence",
    "depends_on",
    "report_path",
]
REQUIRED_TASK_REPORT_SECTIONS = [
    "Task ID",
    "Goal",
    "Executed Actions",
    "Key Evidence",
    "Findings",
    "Open Questions",
    "Next Leads",
]


def is_placeholder_final_report(content: str) -> bool:
    return "replace-with" in content or content.strip() == FINAL_REPORT_PLACEHOLDER.strip()


def parse_markdown_sections(text: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        heading = re.match(r"^##\s+(.+?)\s*$", line.strip())
        if heading:
            current = heading.group(1).strip()
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items()}


def meaningful_section_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        line = re.sub(r"^[-*]\s+", "", line)
        line = re.sub(r"^\d+\.\s+", "", line)
        line = re.sub(r"^(\*\*|__)(.+)\1$", r"\2", line)
        line = re.sub(r"^(\*|_|`)(.+)\1$", r"\2", line)
        line = line.strip()
        if not line or line == "-" or line == "*" or "replace-with" in line.lower():
            continue
        lines.append(line)
    return lines


def check_task_report(task: dict[str, Any], report_path: Path, round_num: int) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    task_id = str(task.get("task_id", "?")).strip() or "?"

    try:
        content = report_path.read_text(encoding="utf-8")
    except OSError as exc:
        return [_err(ERR_TASK_FILE_MISSING, f"task {task_id} report unreadable: {exc}", round_num)]

    sections = parse_markdown_sections(content)
    for section in REQUIRED_TASK_REPORT_SECTIONS:
        if section not in sections:
            errors.append(_err(
                ERR_TASK_REPORT_SECTION_MISSING,
                f"task {task_id} report missing section: {section}",
                round_num,
            ))

    if errors:
        return errors

    task_id_lines = meaningful_section_lines(sections["Task ID"])
    if not task_id_lines or task_id_lines[0] != task_id:
        errors.append(_err(
            ERR_TASK_REPORT_MISMATCH,
            f"task {task_id} report Task ID section does not match registry task_id",
            round_num,
        ))

    required_non_empty_sections = [
        "Goal",
        "Key Evidence",
        "Findings",
        "Open Questions",
        "Next Leads",
    ]
    for section in required_non_empty_sections:
        if not meaningful_section_lines(sections[section]):
            errors.append(_err(
                ERR_TASK_REPORT_THIN,
                f"task {task_id} report section is empty or placeholder-only: {section}",
                round_num,
            ))

    executed_actions = meaningful_section_lines(sections["Executed Actions"])
    if len(executed_actions) < 2:
        errors.append(_err(
            ERR_TASK_REPORT_THIN,
            f"task {task_id} report Executed Actions must contain at least 2 real actions",
            round_num,
        ))

    return errors


def collect_all_task_ids(research_dir: Path) -> list[str]:
    task_ids: list[str] = []
    for round_dir in sorted(p for p in research_dir.iterdir() if p.is_dir() and re.fullmatch(r"round_\d+", p.name)):
        registry_path = round_dir / "02_task_registry.json"
        if not registry_path.exists():
            continue
        try:
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for task in registry.get("tasks", []):
            task_id = str(task.get("task_id", "")).strip()
            if task_id:
                task_ids.append(task_id)
    return task_ids


def check_final_report(research_dir: Path, meta) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    final_path = research_dir / "final_report.md"
    if not final_path.exists():
        if meta.status.value == "completed":
            errors.append(_err(
                ERR_COMPLETED_WITHOUT_FINAL_REPORT,
                "meta.status is completed but final_report.md is missing",
            ))
        return errors

    content = final_path.read_text(encoding="utf-8")
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
    if is_placeholder:
        return errors

    sections = parse_markdown_sections(content)
    for section in REQUIRED_FINAL_REPORT_SECTIONS:
        if section not in sections:
            errors.append(_err(
                ERR_FINAL_REPORT_SECTION_MISSING,
                f"final_report.md missing section: {section}",
            ))
    if errors:
        return errors

    required_non_empty_sections = [
        "核心结论",
        "跨轮综合与证据权重",
        "关键发现与证据来源",
        "时效性与交叉验证",
        "具体建议",
        "局限性与不确定性",
    ]
    for section in required_non_empty_sections:
        if not meaningful_section_lines(sections[section]):
            errors.append(_err(
                ERR_FINAL_REPORT_THIN,
                f"final_report.md section is empty or placeholder-only: {section}",
            ))

    source_section = sections["关键发现与证据来源"]
    task_ref_pattern = re.compile(r"R\d{2}-T\d{2}")
    task_refs = set(task_ref_pattern.findall(source_section))
    all_task_ids = collect_all_task_ids(research_dir)
    if all_task_ids:
        min_required = 1 if len(all_task_ids) == 1 else min(len(all_task_ids), meta.current_round + 1)
        if len(task_refs) < min_required:
            errors.append(_err(
                ERR_FINAL_REPORT_SOURCE_GAP,
                f"final_report.md cites only {len(task_refs)} task sources, need >= {min_required} across the completed research",
            ))

    timeliness_section = sections["时效性与交叉验证"]
    timeliness_lines = meaningful_section_lines(timeliness_section)
    if len(timeliness_lines) < 3:
        errors.append(_err(
            ERR_FINAL_REPORT_THIN,
            "final_report.md 时效性与交叉验证 section must include concrete dates and validation notes",
        ))
    if not re.search(r"\b20\d{2}-\d{2}-\d{2}\b", timeliness_section):
        errors.append(_err(
            ERR_FINAL_REPORT_THIN,
            "final_report.md 时效性与交叉验证 section must include at least one absolute date like YYYY-MM-DD",
        ))

    return errors


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

        for field in REQUIRED_TASK_FIELDS:
            if field not in task:
                errors.append(_err(
                    ERR_TASK_MISSING_FIELD,
                    f"task {tid} missing required field: {field}",
                    n,
                ))

        title = str(task.get("title", "")).strip()
        if not title:
            errors.append(_err(ERR_TASK_MISSING_FIELD, f"task {tid} missing required field: title", n))

        q = str(task.get("key_question", "")).strip()
        if not q:
            errors.append(_err(ERR_TASK_MISSING_FIELD, f"task {tid} missing required field: key_question", n))
        else:
            questions.append(q)

        rp = str(task.get("report_path", "")).strip()
        if not rp:
            errors.append(_err(ERR_TASK_MISSING_FIELD, f"task {tid} missing required field: report_path", n))
        else:
            report_paths.append(rp)

        dep = task.get("depends_on", [])
        if not isinstance(dep, list):
            errors.append(_err(ERR_TASK_MISSING_FIELD, f"task {tid} depends_on must be a list", n))
        if dep:
            errors.append(_err(ERR_TASK_ILLEGAL_DEP,
                               f"task {tid} has non-empty depends_on: {dep}", n))

        dim = str(task.get("research_dimension", "")).strip().lower()
        if not dim:
            errors.append(_err(ERR_TASK_MISSING_FIELD, f"task {tid} missing required field: research_dimension", n))
        else:
            dimensions.append(dim)

        task_type = str(task.get("task_type", "")).strip()
        if not task_type:
            errors.append(_err(ERR_TASK_MISSING_FIELD, f"task {tid} missing required field: task_type", n))

        actions = task.get("planned_actions", [])
        if not isinstance(actions, list) or len(actions) < 3:
            errors.append(_err(
                ERR_TASK_ACTIONS_SHORT,
                f"task {tid} planned_actions must contain at least 3 actions",
                n,
            ))

        evidence = task.get("expected_evidence", [])
        if not isinstance(evidence, list) or not evidence:
            errors.append(_err(
                ERR_TASK_MISSING_FIELD,
                f"task {tid} expected_evidence must be a non-empty list",
                n,
            ))

        # task result file must exist
        if rp and not (research_dir / rp).exists():
            errors.append(_err(ERR_TASK_FILE_MISSING, f"task {tid} report_path missing: {rp}", n))
        elif rp:
            errors.extend(check_task_report(task, research_dir / rp, n))

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
    if strict and only_round is None:
        errors.extend(check_final_report(research_dir, meta))

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
