#!/usr/bin/env python3
"""Manage the active deep-research session for an OpenClaw workspace.

This script is designed to live alongside the installed skill bundle, but it
also works from the repository checkout.

Commands:
  start         Create a fresh archive and bind it as the active research session
  activate      Bind an existing research directory as the active session
  advance-round Validate the current round, update meta, and scaffold the next round when needed
  finalize      Validate the full archive and mark the research completed
  clear         Clear the active session binding
  status        Print the current active session binding
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from init_deep_research_archive import (
    initialize_archive,
    maybe_run_initial_check,
    resolve_templates_dir,
    init_round_files,
)
from deep_research_state_machine import (
    TransitionEvent,
    load_meta,
    save_meta,
)
from check_deep_research_archive import check_archive


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


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def resolve_research_dir(args: argparse.Namespace) -> tuple[Path, Path]:
    workspace_dir = args.workspace_dir.resolve()
    explicit = getattr(args, "research_dir", None)
    if explicit:
        research_dir = Path(explicit).expanduser().resolve()
    else:
        payload = read_state(workspace_dir)
        research_dir_value = str(payload.get("research_dir", "")).strip() if payload else ""
        if not research_dir_value:
            fail("no active research session for this workspace")
        research_dir = Path(research_dir_value).expanduser().resolve()
    if not research_dir.is_dir():
        fail(f"research directory not found: {research_dir}")
    meta_path = research_dir / "00_meta.json"
    if not meta_path.exists():
        fail(f"00_meta.json not found under research directory: {research_dir}")
    return workspace_dir, research_dir


def emit_and_persist(workspace_dir: Path, payload: dict, *, persist: bool = True) -> None:
    if persist:
        write_state(workspace_dir, payload)
    emit(payload)


def preserve_session_owner(workspace_dir: Path, payload: dict) -> dict:
    current = read_state(workspace_dir) or {}
    for key in ("owner_session_id", "owner_session_key", "worker_session_keys"):
        if key in current and key not in payload:
            payload[key] = current[key]
    if current.get("version") == 2 and payload.get("version") == 1:
        payload["version"] = 2
    return payload


def round_pass_payload(action: str, workspace_dir: Path, research_dir: Path, **extra: object) -> dict:
    payload = {
        "version": 1,
        "action": action,
        "workspace_dir": str(workspace_dir),
        "research_dir": str(research_dir),
        "activated_at": utc_now(),
    }
    payload.update(extra)
    return preserve_session_owner(workspace_dir, payload)


def cmd_start(args: argparse.Namespace) -> int:
    workspace_dir = args.workspace_dir.resolve()
    output_root = (args.output_root or workspace_dir).resolve()
    try:
        research_dir = initialize_archive(
            topic=args.topic,
            question=args.question,
            target_depth=args.target_depth,
            depth_mode=args.depth_mode,
            workspace_root=repo_root(),
            output_root=output_root,
            research_dir_name=args.research_dir_name,
        )
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise SystemExit(str(exc))
    meta = load_meta(research_dir)
    meta.apply_event(TransitionEvent.START_ROUND, round_number=1)
    save_meta(research_dir, meta)
    if not args.no_check:
        maybe_run_initial_check(research_dir)
    payload = {
        "version": 1,
        "action": "start",
        "workspace_dir": str(workspace_dir),
        "research_dir": str(research_dir),
        "topic": args.topic,
        "question": args.question,
        "current_round": 1,
        "status": meta.status.value,
        "activated_at": utc_now(),
    }
    write_state(workspace_dir, payload)
    emit(payload)
    return 0


def cmd_activate(args: argparse.Namespace) -> int:
    workspace_dir, research_dir = resolve_research_dir(args)
    payload = round_pass_payload("activate", workspace_dir, research_dir)
    emit_and_persist(workspace_dir, payload)
    return 0


def run_validation_or_fail(research_dir: Path, *, strict: bool, round_num: int | None = None) -> dict:
    report = check_archive(research_dir, strict=strict, only_round=round_num)
    if report["result"] != "PASS":
        raise SystemExit(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def cmd_advance_round(args: argparse.Namespace) -> int:
    workspace_dir, research_dir = resolve_research_dir(args)
    meta = load_meta(research_dir)
    if meta.current_round <= 0:
        fail("cannot advance round: current_round must be > 0")

    run_validation_or_fail(research_dir, strict=args.strict, round_num=meta.current_round)

    completed_round = meta.current_round
    meta.apply_event(TransitionEvent.ROUND_PASS, round_number=completed_round)

    next_round = None
    if meta.status.value == "ready_for_next_round":
        next_round = completed_round + 1
        templates_dir = resolve_templates_dir(repo_root())
        next_round_dir = research_dir / f"round_{next_round:02d}"
        if next_round_dir.exists():
            fail(f"next round directory already exists: {next_round_dir}")
        init_round_files(research_dir, templates_dir, next_round)
        meta.apply_event(TransitionEvent.START_ROUND, round_number=next_round)

    save_meta(research_dir, meta)
    payload = round_pass_payload(
        "advance-round",
        workspace_dir,
        research_dir,
        validated_round=completed_round,
        strict=args.strict,
        next_round=next_round,
        status=meta.status.value,
        current_round=meta.current_round,
    )
    emit_and_persist(workspace_dir, payload)
    return 0


def cmd_finalize(args: argparse.Namespace) -> int:
    workspace_dir, research_dir = resolve_research_dir(args)
    meta = load_meta(research_dir)
    run_validation_or_fail(research_dir, strict=args.strict, round_num=None)
    meta.apply_event(TransitionEvent.FINALIZE)
    save_meta(research_dir, meta)
    payload = round_pass_payload(
        "finalize",
        workspace_dir,
        research_dir,
        strict=args.strict,
        status=meta.status.value,
        current_round=meta.current_round,
    )
    emit_and_persist(workspace_dir, payload)
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
    research_dir_value = str(payload.get("research_dir", "")).strip()
    enriched = {
        "version": 1,
        "action": "status",
        "workspace_dir": str(workspace_dir),
        "active": True,
        **payload,
    }
    if research_dir_value:
        try:
            meta = load_meta(Path(research_dir_value))
            enriched["current_round"] = meta.current_round
            enriched["status"] = meta.status.value
            enriched["target_depth"] = meta.target_depth
        except Exception:
            pass
    emit(enriched)
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

    advance_round = sub.add_parser(
        "advance-round",
        help="validate the current round, update meta, and scaffold the next round when required",
    )
    advance_round.add_argument("--research-dir")
    advance_round.add_argument("--workspace-dir", type=Path, default=default_workspace_dir())
    advance_round.add_argument("--strict", action="store_true")
    advance_round.set_defaults(func=cmd_advance_round)

    finalize = sub.add_parser(
        "finalize",
        help="validate the full archive and mark the research completed",
    )
    finalize.add_argument("--research-dir")
    finalize.add_argument("--workspace-dir", type=Path, default=default_workspace_dir())
    finalize.add_argument("--strict", action="store_true")
    finalize.set_defaults(func=cmd_finalize)

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
