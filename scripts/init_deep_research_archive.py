#!/usr/bin/env python3
"""Initialize a deep-research archive directory with templates and meta state.

Usage:
  python scripts/init_deep_research_archive.py \
    --topic api-gateway \
    --question "是否应该引入统一 API gateway" \
    --target-depth 5 \
    --depth-mode user-specified

Prints the created research directory path on success.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# Allow running directly from scripts/ without installing the package
sys.path.insert(0, str(Path(__file__).parent))
from deep_research_state_machine import DeepResearchMeta, DepthMode, ResearchStatus, save_meta


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Initialize deep-research archive")
    parser.add_argument("--topic", required=True, help="Short topic slug, e.g. api-gateway")
    parser.add_argument("--question", required=True, help="Original user question")
    parser.add_argument("--target-depth", type=int, required=True, help="Required research rounds (>0)")
    parser.add_argument(
        "--depth-mode",
        choices=[DepthMode.AUTO.value, DepthMode.USER_SPECIFIED.value],
        default=DepthMode.AUTO.value,
    )
    parser.add_argument(
        "--workspace-root",
        type=Path,
        default=None,
        help="Repo root containing deep-research/templates. Defaults to parent of this script.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path.cwd(),
        help="Where to create research_<date>_<topic>. Defaults to cwd.",
    )
    parser.add_argument(
        "--research-dir-name",
        type=str,
        default="",
        help="Override directory name instead of auto-generating.",
    )
    parser.add_argument(
        "--no-check",
        action="store_true",
        help="Skip running the validator after init.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a machine-readable JSON payload instead of a plain path.",
    )
    return parser.parse_args()


def resolve_templates_dir(workspace_root: Path | None) -> Path:
    root = workspace_root or Path(__file__).parent.parent
    templates_dir = root / "deep-research" / "templates"
    if templates_dir.exists():
        return templates_dir
    fallback = Path(__file__).parent.parent / "templates"
    if fallback.exists():
        return fallback
    raise FileNotFoundError(f"templates dir not found: {templates_dir}")


def build_research_dir(output_root: Path, topic: str, research_dir_name: str = "") -> Path:
    if research_dir_name:
        return output_root / research_dir_name
    date_tag = datetime.now().strftime("%Y%m%d")
    return output_root / f"research_{date_tag}_{sanitize_slug(topic)}"


def sanitize_slug(s: str) -> str:
    val = re.sub(r"[^a-zA-Z0-9\-_.]+", "-", s.strip().lower())
    val = re.sub(r"-{2,}", "-", val).strip("-")
    return val or "research-topic"


def load_json_template(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"template must be a JSON object: {path}")
    return data


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def emit_success(args: argparse.Namespace, research_dir: Path) -> None:
    if args.json:
        print(json.dumps({"research_dir": str(research_dir)}, ensure_ascii=False))
        return
    print(research_dir)


def init_round_files(research_dir: Path, templates_dir: Path, round_number: int) -> None:
    pad = str(round_number).zfill(2)
    round_dir = research_dir / f"round_{pad}"
    tasks_dir = round_dir / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)

    seed = load_json_template(templates_dir / "01_seed_clues.json")
    seed["round"] = round_number
    write_json(round_dir / "01_seed_clues.json", seed)

    registry = load_json_template(templates_dir / "02_task_registry.json")
    registry["round"] = round_number
    write_json(round_dir / "02_task_registry.json", registry)

    summary_src = templates_dir / "03_round_summary.md"
    (round_dir / "03_round_summary.md").write_text(
        summary_src.read_text(encoding="utf-8"), encoding="utf-8"
    )

    delta = load_json_template(templates_dir / "04_delta_report.json")
    delta["round"] = round_number
    write_json(round_dir / "04_delta_report.json", delta)

    task_tmpl = templates_dir / "task_report.md"
    (tasks_dir / "task_report.template.md").write_text(
        task_tmpl.read_text(encoding="utf-8"), encoding="utf-8"
    )


def initialize_archive(
    *,
    topic: str,
    question: str,
    target_depth: int,
    depth_mode: str = DepthMode.AUTO.value,
    workspace_root: Path | None = None,
    output_root: Path | None = None,
    research_dir_name: str = "",
    create_round_one: bool = True,
) -> Path:
    if target_depth <= 0:
        raise ValueError("target_depth must be > 0")

    resolved_output_root = (output_root or Path.cwd()).resolve()
    templates_dir = resolve_templates_dir(workspace_root.resolve() if workspace_root else None)
    research_dir = build_research_dir(
        resolved_output_root,
        topic=topic,
        research_dir_name=research_dir_name,
    )

    if research_dir.exists():
        raise FileExistsError(f"directory already exists: {research_dir}")

    research_dir.mkdir(parents=True)

    # 00_research_brief.md
    brief_lines = [
        "# 研究任务说明",
        "",
        "## 原始问题",
        "",
        question.strip(),
        "",
        "## 研究目标",
        "",
        f"- 主题: {topic.strip()}",
        f"- 目标轮次: {target_depth}",
        "- 按 deep-research 归档协议生成全量归档",
        "",
        "## 约束条件",
        "",
        "- 轮次不足不得生成最终报告",
        "- 每轮结束前必须通过严格归档检查",
        "",
    ]
    (research_dir / "00_research_brief.md").write_text(
        "\n".join(brief_lines), encoding="utf-8"
    )

    # 00_meta.json
    meta = DeepResearchMeta(
        topic=topic.strip(),
        original_question=question.strip(),
        target_depth=target_depth,
        depth_mode=DepthMode(depth_mode),
        current_round=0,
        status=ResearchStatus.INITIALIZED,
    )
    save_meta(research_dir, meta)

    if create_round_one:
        init_round_files(research_dir, templates_dir, 1)

    # final_report.md placeholder
    final_src = templates_dir / "final_report.md"
    (research_dir / "final_report.md").write_text(
        final_src.read_text(encoding="utf-8"), encoding="utf-8"
    )

    return research_dir


def maybe_run_initial_check(research_dir: Path) -> None:
    import subprocess

    checker = Path(__file__).parent / "check_deep_research_archive.py"
    if not checker.exists():
        return
    result = subprocess.run(
        [sys.executable, str(checker), "--research-dir", str(research_dir)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(
            "WARN: initial check returned non-zero (templates not filled yet):",
            file=sys.stderr,
        )
        if result.stdout:
            print(result.stdout, file=sys.stderr, end="" if result.stdout.endswith("\n") else "\n")


def main() -> None:
    args = parse_args()

    try:
        research_dir = initialize_archive(
            topic=args.topic,
            question=args.question,
            target_depth=args.target_depth,
            depth_mode=args.depth_mode,
            workspace_root=args.workspace_root,
            output_root=args.output_root,
            research_dir_name=args.research_dir_name,
        )
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    emit_success(args, research_dir)

    if not args.no_check:
        maybe_run_initial_check(research_dir)


if __name__ == "__main__":
    main()
