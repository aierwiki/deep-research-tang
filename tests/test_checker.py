"""End-to-end tests for check_deep_research_archive.py.

Tests cover:
  - PASS for a minimal valid archive
  - FAIL when required files are missing
  - FAIL when task registry has duplicate key_question
  - FAIL when task file is absent
  - FAIL when depth_mismatch in strict mode
  - FAIL when final_report is written prematurely
  - Clue chain broken between rounds
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from check_deep_research_archive import check_archive
from deep_research_state_machine import (
    DeepResearchMeta, DepthMode, ResearchStatus, save_meta
)


TEMPLATES_DIR = Path(__file__).parent.parent / "templates"


# ------------------------------------------------------------------ #
# Helpers                                                             #
# ------------------------------------------------------------------ #

def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


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
                "- Answer the task question clearly.",
                "",
                "## Executed Actions",
                "",
                "1. Read source A.",
                "2. Cross-check source B.",
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


def write_meta(rdir: Path, target_depth: int = 1, current_round: int = 1,
               depth_mode: str = "user-specified") -> None:
    meta = DeepResearchMeta(
        topic="test", original_question="q?", target_depth=target_depth,
        depth_mode=DepthMode(depth_mode), current_round=current_round,
        status=ResearchStatus.READY_FOR_NEXT_ROUND,
    )
    save_meta(rdir, meta)


def build_minimal_round(rdir: Path, n: int) -> None:
    pad = str(n).zfill(2)
    rd = rdir / f"round_{pad}"
    tasks_dir = rd / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)

    write_json(rd / "01_seed_clues.json", {
        "round": n,
        "seed_clues": [{"clue_id": f"R0{n}-C01", "source_round": n - 1,
                         "source_ref": "original-question", "question": "q", "why_it_matters": "m"}],
    })
    write_json(rd / "02_task_registry.json", {
        "round": n,
        "tasks": [
            {"task_id": f"R0{n}-T01", "title": "T1", "task_type": "exploratory",
             "research_dimension": "dim-a", "key_question": "What is X?",
             "planned_actions": ["a1", "a2", "a3"], "expected_evidence": ["e1"],
             "depends_on": [], "report_path": f"round_{pad}/tasks/task_01_x.md"},
            {"task_id": f"R0{n}-T02", "title": "T2", "task_type": "counterevidence",
             "research_dimension": "dim-b", "key_question": "What is Y?",
             "planned_actions": ["a1", "a2", "a3"], "expected_evidence": ["e1"],
             "depends_on": [], "report_path": f"round_{pad}/tasks/task_02_y.md"},
        ],
    })
    (rd / "03_round_summary.md").write_text("# Summary\n", encoding="utf-8")
    write_json(rd / "04_delta_report.json", {
        "round": n,
        "new_findings": [
            {"finding_id": f"R0{n}-F01", "summary": "Finding one", "source_tasks": [f"R0{n}-T01"]},
            {"finding_id": f"R0{n}-F02", "summary": "Finding two", "source_tasks": [f"R0{n}-T01"]},
            {"finding_id": f"R0{n}-F03", "summary": "Finding three", "source_tasks": [f"R0{n}-T02"]},
        ],
        "contradictions": [],
        "carry_forward_clues": [
            {"clue_id": f"R0{n}-CF01", "from_finding_id": f"R0{n}-F01", "question": "Next q"},
        ],
        "coverage_assessment": "partial",
    })
    for fname in ["task_01_x.md", "task_02_y.md"]:
        task_id = f"R0{n}-T01" if fname == "task_01_x.md" else f"R0{n}-T02"
        write_task_report(tasks_dir / fname, task_id)


# ------------------------------------------------------------------ #
# Tests                                                               #
# ------------------------------------------------------------------ #

class TestMinimalPass:
    def test_single_round_passes(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        report = check_archive(tmp_path, strict=True, only_round=None)
        assert report["result"] == "PASS", report["errors"]

    def test_four_rounds_passes(self, tmp_path):
        write_meta(tmp_path, target_depth=4, current_round=4)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        for n in range(1, 5):
            build_minimal_round(tmp_path, n)
        # Fix clue chains for rounds 2-4
        for n in range(2, 5):
            pad = str(n).zfill(2)
            prev_pad = str(n - 1).zfill(2)
            seed_path = tmp_path / f"round_{pad}" / "01_seed_clues.json"
            seed = json.loads(seed_path.read_text())
            seed["seed_clues"][0]["source_ref"] = f"R0{n-1}-CF01"
            write_json(seed_path, seed)
        report = check_archive(tmp_path, strict=True, only_round=None)
        assert report["result"] == "PASS", report["errors"]


class TestMissingFiles:
    def test_missing_meta_fails(self, tmp_path):
        report = check_archive(tmp_path, strict=False, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_META_MISSING" in codes

    def test_missing_round_summary_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        (tmp_path / "round_01" / "03_round_summary.md").unlink()
        report = check_archive(tmp_path, strict=False, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_MISSING_FILE" in codes

    def test_missing_task_file_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        (tmp_path / "round_01" / "tasks" / "task_01_x.md").unlink()
        report = check_archive(tmp_path, strict=False, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_TASK_FILE_MISSING" in codes


class TestTaskRegistryRules:
    def test_legacy_registry_schema_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        reg_path = tmp_path / "round_01" / "02_task_registry.json"
        write_json(reg_path, {
            "round": 1,
            "tasks": [
                {
                    "task_id": "R01-T01",
                    "theme": "Legacy task",
                    "query": "legacy query",
                    "key_questions": ["What is X?"],
                }
            ],
        })
        report = check_archive(tmp_path, strict=True, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_TASK_MISSING_FIELD" in codes

    def test_duplicate_key_question_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        reg_path = tmp_path / "round_01" / "02_task_registry.json"
        reg = json.loads(reg_path.read_text())
        reg["tasks"][1]["key_question"] = reg["tasks"][0]["key_question"]
        write_json(reg_path, reg)
        report = check_archive(tmp_path, strict=False, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_TASK_DUPLICATE_QUESTION" in codes

    def test_illegal_depends_on_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        reg_path = tmp_path / "round_01" / "02_task_registry.json"
        reg = json.loads(reg_path.read_text())
        reg["tasks"][1]["depends_on"] = ["R01-T01"]
        write_json(reg_path, reg)
        report = check_archive(tmp_path, strict=False, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_TASK_ILLEGAL_DEPENDS_ON" in codes

    def test_thin_task_report_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=1, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        report_path = tmp_path / "round_01" / "tasks" / "task_01_x.md"
        report_path.write_text(
            "\n".join(
                [
                    "# 任务报告",
                    "",
                    "## Task ID",
                    "",
                    "R01-T01",
                    "",
                    "## Goal",
                    "",
                    "- Answer the task question.",
                    "",
                    "## Executed Actions",
                    "",
                    "1. Single search only.",
                    "",
                    "## Key Evidence",
                    "",
                    "- ",
                    "",
                    "## Findings",
                    "",
                    "- ",
                    "",
                    "## Open Questions",
                    "",
                    "- ",
                    "",
                    "## Next Leads",
                    "",
                    "- ",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        report = check_archive(tmp_path, strict=True, only_round=None)
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_TASK_REPORT_THIN" in codes


class TestDepthEnforcement:
    def test_depth_mismatch_strict_fails(self, tmp_path):
        """4 rounds required but only 2 completed."""
        write_meta(tmp_path, target_depth=4, current_round=2)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        for n in range(1, 3):
            build_minimal_round(tmp_path, n)
        report = check_archive(tmp_path, strict=True, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_DEPTH_MISMATCH" in codes

    def test_depth_mismatch_non_strict_passes(self, tmp_path):
        """non-strict does not check depth completion."""
        write_meta(tmp_path, target_depth=4, current_round=2)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        for n in range(1, 3):
            build_minimal_round(tmp_path, n)
        # Fix clue chain for round 2
        seed_path = tmp_path / "round_02" / "01_seed_clues.json"
        seed = json.loads(seed_path.read_text())
        seed["seed_clues"][0]["source_ref"] = "R01-CF01"
        write_json(seed_path, seed)
        report = check_archive(tmp_path, strict=False, only_round=None)
        assert report["result"] == "PASS", report["errors"]


class TestFinalReportPremature:
    def test_premature_final_report_fails_strict(self, tmp_path):
        write_meta(tmp_path, target_depth=4, current_round=2)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        for n in range(1, 3):
            build_minimal_round(tmp_path, n)
        # Write a non-placeholder final report before depth reached
        (tmp_path / "final_report.md").write_text(
            "# Final Report\n\n## Core Conclusion\n\nSome real conclusion here.\n",
            encoding="utf-8",
        )
        report = check_archive(tmp_path, strict=True, only_round=None)
        assert report["result"] == "FAIL"
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_FINAL_REPORT_PREMATURE" in codes

    def test_completed_without_real_final_report_fails_strict(self, tmp_path):
        write_meta(tmp_path, target_depth=2, current_round=2)
        meta_path = tmp_path / "00_meta.json"
        meta = DeepResearchMeta.from_dict(json.loads(meta_path.read_text(encoding="utf-8")))
        meta.status = ResearchStatus.COMPLETED
        save_meta(tmp_path, meta)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        for n in range(1, 3):
            build_minimal_round(tmp_path, n)
        report = check_archive(tmp_path, strict=True, only_round=None)
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_COMPLETED_WITHOUT_FINAL_REPORT" in codes

    def test_round_specific_check_ignores_global_final_report_rule(self, tmp_path):
        write_meta(tmp_path, target_depth=2, current_round=1)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        write_final_report(tmp_path / "final_report.md")
        report = check_archive(tmp_path, strict=True, only_round=1)
        assert report["result"] == "PASS", report["errors"]

    def test_completed_final_report_requires_broad_sources(self, tmp_path):
        write_meta(tmp_path, target_depth=2, current_round=2)
        meta_path = tmp_path / "00_meta.json"
        meta = DeepResearchMeta.from_dict(json.loads(meta_path.read_text(encoding="utf-8")))
        meta.status = ResearchStatus.COMPLETED
        save_meta(tmp_path, meta)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        for n in range(1, 3):
            build_minimal_round(tmp_path, n)
        seed_path = tmp_path / "round_02" / "01_seed_clues.json"
        seed = json.loads(seed_path.read_text())
        seed["seed_clues"][0]["source_ref"] = "R01-CF01"
        write_json(seed_path, seed)
        write_final_report(tmp_path / "final_report.md", ["R01-T01"])
        report = check_archive(tmp_path, strict=True, only_round=None)
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_FINAL_REPORT_SOURCE_GAP" in codes


class TestClueChain:
    def test_broken_clue_chain_fails(self, tmp_path):
        write_meta(tmp_path, target_depth=2, current_round=2)
        (tmp_path / "00_research_brief.md").write_text("# Brief\n", encoding="utf-8")
        build_minimal_round(tmp_path, 1)
        build_minimal_round(tmp_path, 2)
        # Round 2 seed does NOT reference round 1 carry_forward_clues
        report = check_archive(tmp_path, strict=True, only_round=None)
        codes = [e["code"] for e in report["errors"]]
        assert "ERR_CLUE_CHAIN_BROKEN" in codes
