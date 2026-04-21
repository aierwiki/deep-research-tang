#!/usr/bin/env python3
"""Manage the active deep-research session for an OpenClaw workspace.

This script is designed to live alongside the installed skill bundle, but it
also works from the repository checkout.

Commands:
  start     Create a fresh archive and bind it as the active research session
  activate  Bind an existing research directory as the active session
  clear     Clear the active session binding
  status    Print the current active session binding
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def scripts_dir() -> Path:
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    return scripts_dir().parent


def default_workspace_dir() -> Path:
    script_parent = scripts_dir().parent
    if script_parent.name == "deep-research" and script_parent.parent.name == "skills":
        return script_parent.parent.parent
    return Path.cwd()


def state_dir(workspace_dir: Path) -> Path:
    return workspace_dir / ".deep-research"


def state_file(workspace_dir: Path) -> Path:
    return state_dir(workspace_dir) / "active.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit(payload: dict) -> None:
    print(f"DEEP_RESEARCH_SESSION {json.dumps(payload, ensure_ascii=False)}")


def parse_init_stdout(stdout: str) -> Path:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        research_dir = payload.get("research_dir")
        if not isinstance(research_dir, str) or not research_dir.strip():
            continue
        candidate = Path(research_dir).expanduser().resolve()
        if (candidate / "00_meta.json").exists():
            return candidate

    for line in reversed(lines):
        candidate = Path(line).expanduser()
        if not candidate.is_absolute():
            continue
        resolved = candidate.resolve()
        if (resolved / "00_meta.json").exists():
            return resolved

    raise SystemExit("failed to parse research_dir from init_deep_research_archive.py output")


def write_state(workspace_dir: Path, payload: dict) -> None:
    marker = state_file(workspace_dir)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_state(workspace_dir: Path) -> dict | None:
    marker = state_file(workspace_dir)
    if not marker.exists():
      return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def cmd_start(args: argparse.Namespace) -> int:
    from init_deep_research_archive import main as _unused  # noqa: F401
    import subprocess

    workspace_dir = args.workspace_dir.resolve()
    output_root = (args.output_root or workspace_dir).resolve()
    init_script = scripts_dir() / "init_deep_research_archive.py"
    cmd = [
        sys.executable,
        str(init_script),
        "--json",
        "--topic",
        args.topic,
        "--question",
        args.question,
        "--target-depth",
        str(args.target_depth),
        "--depth-mode",
        args.depth_mode,
        "--workspace-root",
        str(repo_root()),
        "--output-root",
        str(output_root),
    ]
    if args.research_dir_name:
        cmd.extend(["--research-dir-name", args.research_dir_name])
    if args.no_check:
        cmd.append("--no-check")

    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    research_dir = parse_init_stdout(result.stdout)
    payload = {
        "version": 1,
        "action": "start",
        "workspace_dir": str(workspace_dir),
        "research_dir": str(research_dir),
        "topic": args.topic,
        "question": args.question,
        "activated_at": utc_now(),
    }
    write_state(workspace_dir, payload)
    emit(payload)
    return 0


def cmd_activate(args: argparse.Namespace) -> int:
    workspace_dir = args.workspace_dir.resolve()
    research_dir = Path(args.research_dir).expanduser().resolve()
    meta_path = research_dir / "00_meta.json"
    if not research_dir.is_dir():
        raise SystemExit(f"research directory not found: {research_dir}")
    if not meta_path.exists():
        raise SystemExit(f"00_meta.json not found under research directory: {research_dir}")
    payload = {
        "version": 1,
        "action": "activate",
        "workspace_dir": str(workspace_dir),
        "research_dir": str(research_dir),
        "activated_at": utc_now(),
    }
    write_state(workspace_dir, payload)
    emit(payload)
    return 0


def cmd_clear(args: argparse.Namespace) -> int:
    workspace_dir = args.workspace_dir.resolve()
    marker = state_file(workspace_dir)
    if marker.exists():
        marker.unlink()
    payload = {
        "version": 1,
        "action": "clear",
        "workspace_dir": str(workspace_dir),
        "cleared_at": utc_now(),
    }
    emit(payload)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    workspace_dir = args.workspace_dir.resolve()
    payload = read_state(workspace_dir)
    if payload is None:
        emit(
            {
                "version": 1,
                "action": "status",
                "workspace_dir": str(workspace_dir),
                "active": False,
            }
        )
        return 0
    emit(
        {
            "version": 1,
            "action": "status",
            "workspace_dir": str(workspace_dir),
            "active": True,
            **payload,
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage OpenClaw deep-research session state")
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="create and activate a new research archive")
    start.add_argument("--topic", required=True)
    start.add_argument("--question", required=True)
    start.add_argument("--target-depth", required=True, type=int)
    start.add_argument("--depth-mode", choices=["auto", "user-specified"], default="auto")
    start.add_argument("--workspace-dir", type=Path, default=default_workspace_dir())
    start.add_argument("--output-root", type=Path, default=None)
    start.add_argument("--research-dir-name", default="")
    start.add_argument("--no-check", action="store_true")
    start.set_defaults(func=cmd_start)

    activate = sub.add_parser("activate", help="activate an existing research archive")
    activate.add_argument("--research-dir", required=True)
    activate.add_argument("--workspace-dir", type=Path, default=default_workspace_dir())
    activate.set_defaults(func=cmd_activate)

    clear = sub.add_parser("clear", help="clear the active research archive binding")
    clear.add_argument("--workspace-dir", type=Path, default=default_workspace_dir())
    clear.set_defaults(func=cmd_clear)

    status = sub.add_parser("status", help="show the active research archive binding")
    status.add_argument("--workspace-dir", type=Path, default=default_workspace_dir())
    status.set_defaults(func=cmd_status)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
