import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str((Path(__file__).resolve().parent.parent / "scripts")))
import openclaw_deep_research_session as session_script


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

    status = run_cmd("status", "--workspace-dir", str(workspace_dir))
    assert status["active"] is True
    assert status["research_dir"] == str(research_dir)

    cleared = run_cmd("clear", "--workspace-dir", str(workspace_dir))
    assert cleared["action"] == "clear"
    assert not (workspace_dir / ".deep-research" / "active.json").exists()

    status_after_clear = run_cmd("status", "--workspace-dir", str(workspace_dir))
    assert status_after_clear["active"] is False


def test_parse_init_stdout_prefers_structured_research_dir(tmp_path: Path) -> None:
    research_dir = tmp_path / "research_20260419_demo"
    research_dir.mkdir()
    (research_dir / "00_meta.json").write_text("{}\n", encoding="utf-8")

    stdout = "\n".join(
        [
            json.dumps({"research_dir": str(research_dir)}, ensure_ascii=False),
            "WARN: initial check returned non-zero (templates not filled yet):",
            "}",
        ]
    )

    parsed = session_script.parse_init_stdout(stdout)
    assert parsed == research_dir.resolve()
