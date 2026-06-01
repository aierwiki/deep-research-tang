import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "openclaw_deep_research_session.py"


def run_cmd(*args: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    marker = next(line for line in lines if line.startswith("DEEP_RESEARCH_SESSION "))
    return json.loads(marker[len("DEEP_RESEARCH_SESSION ") :])


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_task_report(path: Path, task_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "# 任务报告",
                "",
                "## Task ID",
                "",
                task_id,
                "",
                "## Goal",
                "",
                "- Answer the round question.",
                "",
                "## Executed Actions",
                "",
                "1. Read docs.",
                "2. Cross-check code.",
                "",
                "## Key Evidence",
                "",
                "- Evidence line.",
                "",
                "## Findings",
                "",
                "- Finding line.",
                "",
                "## Open Questions",
                "",
                "- Open question line.",
                "",
                "## Next Leads",
                "",
                "- Next lead line.",
                "",
            ]
        ),
        encoding="utf-8",
    )


def write_final_report(path: Path, source_refs: list[str] | None = None) -> None:
    refs = source_refs or ["R01-T01", "R01-T02"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "# 最终研究报告",
                "",
                "## 核心结论",
                "",
                "- 综合结论成立。",
                "",
                "## 跨轮综合与证据权重",
                "",
                "- 结论：综合全部轮次后判断成立。",
                f"  综合依据：{', '.join(refs)}",
                "  证据权重说明：多轮证据一致，反例已纳入评估。",
                "",
                "## 关键发现与证据来源",
                "",
                f"- 发现：关键发现一。来源：{', '.join(refs)}",
                "",
                "## 时效性与交叉验证",
                "",
                "- 关键时间点：2026-04-21。",
                "  信息日期/数据日期：2026-04-20 / 2026-04-21。",
                "  验证动作：对比多个来源并区分事件发生日与发布日期。",
                "  交叉来源：来源 A，来源 B。",
                "",
                "## 具体建议",
                "",
                "- 采取审慎建议。",
                "",
                "## 局限性与不确定性",
                "",
                "- 仍存在不确定性。",
                "",
            ]
        ),
        encoding="utf-8",
    )


def build_valid_round(research_dir: Path, round_num: int) -> None:
    pad = str(round_num).zfill(2)
    round_dir = research_dir / f"round_{pad}"
    tasks_dir = round_dir / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)
    write_json(
        round_dir / "01_seed_clues.json",
        {
            "round": round_num,
            "seed_clues": [
                {
                    "clue_id": f"R{pad}-C01",
                    "source_round": round_num - 1,
                    "source_ref": "original-question" if round_num == 1 else f"R{str(round_num - 1).zfill(2)}-CF01",
                    "question": "What matters?",
                    "why_it_matters": "Important",
                }
            ],
        },
    )
    write_json(
        round_dir / "02_task_registry.json",
        {
            "round": round_num,
            "tasks": [
                {
                    "task_id": f"R{pad}-T01",
                    "title": "Architecture",
                    "task_type": "exploratory",
                    "research_dimension": "architecture",
                    "key_question": f"What matters in round {round_num}?",
                    "planned_actions": ["read docs", "read code", "compare"],
                    "expected_evidence": ["docs", "code"],
                    "depends_on": [],
                    "report_path": f"round_{pad}/tasks/task_01_architecture.md",
                }
            ],
        },
    )
    write_task_report(tasks_dir / "task_01_architecture.md", f"R{pad}-T01")
    (round_dir / "03_round_summary.md").write_text("# Summary\n", encoding="utf-8")
    write_json(
        round_dir / "04_delta_report.json",
        {
            "round": round_num,
            "new_findings": [
                {"finding_id": f"R{pad}-F01", "summary": "Finding one"},
                {"finding_id": f"R{pad}-F02", "summary": "Finding two"},
                {"finding_id": f"R{pad}-F03", "summary": "Finding three"},
            ],
            "contradictions": [],
            "carry_forward_clues": [{"clue_id": f"R{pad}-CF01", "question": "Next q"}],
            "coverage_assessment": "partial",
        },
    )


def test_start_status_clear_roundtrip(tmp_path: Path) -> None:
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()

    started = run_cmd(
        "start",
        "--workspace-dir",
        str(workspace_dir),
        "--output-root",
        str(workspace_dir),
        "--topic",
        "mmx-cli",
        "--question",
        "mmx-cli 是什么",
        "--target-depth",
        "2",
        "--depth-mode",
        "user-specified",
        "--no-check",
    )
    research_dir = Path(started["research_dir"])
    assert started["action"] == "start"
    assert research_dir.is_dir()
    assert (research_dir / "00_meta.json").exists()
    assert (workspace_dir / ".deep-research" / "active.json").exists()
    meta = json.loads((research_dir / "00_meta.json").read_text(encoding="utf-8"))
    assert meta["current_round"] == 1
    assert meta["status"] == "in_progress"
    marker = json.loads((workspace_dir / ".deep-research" / "active.json").read_text(encoding="utf-8"))
    assert marker["version"] == 3
    assert marker["research_dir"] == str(research_dir)

    status = run_cmd("status", "--workspace-dir", str(workspace_dir))
    assert status["active"] is True
    assert status["research_dir"] == str(research_dir)
    assert status["current_round"] == 1
    assert status["status"] == "in_progress"

    cleared = run_cmd("clear", "--workspace-dir", str(workspace_dir))
    assert cleared["action"] == "clear"
    assert not (workspace_dir / ".deep-research" / "active.json").exists()

    status_after_clear = run_cmd("status", "--workspace-dir", str(workspace_dir))
    assert status_after_clear["active"] is False


def test_status_without_marker_reports_inactive(tmp_path: Path) -> None:
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()

    status = run_cmd("status", "--workspace-dir", str(workspace_dir))
    assert status["action"] == "status"
    assert status["active"] is False


def test_advance_round_validates_and_scaffolds_next_round(tmp_path: Path) -> None:
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()

    started = run_cmd(
        "start",
        "--workspace-dir",
        str(workspace_dir),
        "--output-root",
        str(workspace_dir),
        "--topic",
        "mmx-cli",
        "--question",
        "mmx-cli 是什么",
        "--target-depth",
        "2",
        "--depth-mode",
        "user-specified",
        "--no-check",
    )
    research_dir = Path(started["research_dir"])
    marker_path = workspace_dir / ".deep-research" / "active.json"
    build_valid_round(research_dir, 1)

    advanced = run_cmd(
        "advance-round",
        "--workspace-dir",
        str(workspace_dir),
        "--strict",
    )
    assert advanced["action"] == "advance-round"
    assert advanced["validated_round"] == 1
    assert advanced["next_round"] == 2
    meta = json.loads((research_dir / "00_meta.json").read_text(encoding="utf-8"))
    assert meta["current_round"] == 2
    assert meta["status"] == "in_progress"
    marker_after = json.loads(marker_path.read_text(encoding="utf-8"))
    assert marker_after["version"] == 3
    assert marker_after["research_dir"] == str(research_dir)
    assert (research_dir / "round_02" / "01_seed_clues.json").exists()
    assert (research_dir / "round_02" / "02_task_registry.json").exists()


def test_recover_reports_validation_errors_without_mutating_meta(tmp_path: Path) -> None:
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()

    started = run_cmd(
        "start",
        "--workspace-dir",
        str(workspace_dir),
        "--output-root",
        str(workspace_dir),
        "--topic",
        "mmx-cli",
        "--question",
        "mmx-cli 是什么",
        "--target-depth",
        "1",
        "--depth-mode",
        "user-specified",
        "--no-check",
    )
    research_dir = Path(started["research_dir"])

    recovered = run_cmd(
        "recover",
        "--workspace-dir",
        str(workspace_dir),
        "--strict",
    )
    assert recovered["action"] == "recover"
    assert recovered["validation_result"] == "FAIL"
    assert recovered["next_action"] in {"repair_archive_file", "repair_archive", "repair_task_report", "repair_delta"}
    assert recovered["errors"]
    meta = json.loads((research_dir / "00_meta.json").read_text(encoding="utf-8"))
    assert meta["status"] == "in_progress"


def test_finalize_marks_completed_after_full_validation(tmp_path: Path) -> None:
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()

    started = run_cmd(
        "start",
        "--workspace-dir",
        str(workspace_dir),
        "--output-root",
        str(workspace_dir),
        "--topic",
        "mmx-cli",
        "--question",
        "mmx-cli 是什么",
        "--target-depth",
        "1",
        "--depth-mode",
        "user-specified",
        "--no-check",
    )
    research_dir = Path(started["research_dir"])
    build_valid_round(research_dir, 1)
    run_cmd(
        "advance-round",
        "--workspace-dir",
        str(workspace_dir),
        "--strict",
    )
    write_final_report(research_dir / "final_report.md")

    finalized = run_cmd(
        "finalize",
        "--workspace-dir",
        str(workspace_dir),
        "--strict",
    )
    assert finalized["action"] == "finalize"
    meta = json.loads((research_dir / "00_meta.json").read_text(encoding="utf-8"))
    assert meta["status"] == "completed"
