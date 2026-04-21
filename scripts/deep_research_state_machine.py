#!/usr/bin/env python3
"""State machine for deep-research archive lifecycle.

Centralises 00_meta.json schema and round-transition rules so that the
validator, repair helper, and init script all share identical constraints.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

META_FILE_NAME = "00_meta.json"


class DepthMode(str, Enum):
    AUTO = "auto"
    USER_SPECIFIED = "user-specified"


class ResearchStatus(str, Enum):
    INITIALIZED = "initialized"
    IN_PROGRESS = "in_progress"
    ROUND_FAILED = "round_failed"
    READY_FOR_NEXT_ROUND = "ready_for_next_round"
    READY_FOR_FINAL_REPORT = "ready_for_final_report"
    COMPLETED = "completed"


class TransitionEvent(str, Enum):
    START_ROUND = "start_round"
    ROUND_PASS = "round_pass"
    ROUND_FAIL = "round_fail"
    RETRY_ROUND = "retry_round"
    FINALIZE = "finalize"


@dataclass
class DeepResearchMeta:
    topic: str
    original_question: str
    target_depth: int
    depth_mode: DepthMode
    current_round: int
    status: ResearchStatus
    max_retries_per_round: int = 3
    current_retry_count: int = 0
    last_error_code: str | None = None
    history: list[dict[str, Any]] = field(default_factory=list)

    # ------------------------------------------------------------------ #
    # Serialisation                                                        #
    # ------------------------------------------------------------------ #

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DeepResearchMeta":
        return cls(
            topic=str(data.get("topic", "")).strip(),
            original_question=str(data.get("original_question", "")).strip(),
            target_depth=int(data.get("target_depth", 0)),
            depth_mode=DepthMode(str(data.get("depth_mode", DepthMode.AUTO.value))),
            current_round=int(data.get("current_round", 0)),
            status=ResearchStatus(
                str(data.get("status", ResearchStatus.INITIALIZED.value))
            ),
            max_retries_per_round=int(data.get("max_retries_per_round", 3)),
            current_retry_count=int(data.get("current_retry_count", 0)),
            last_error_code=data.get("last_error_code"),
            history=list(data.get("history", [])),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "topic": self.topic,
            "original_question": self.original_question,
            "target_depth": self.target_depth,
            "depth_mode": self.depth_mode.value,
            "current_round": self.current_round,
            "status": self.status.value,
            "max_retries_per_round": self.max_retries_per_round,
            "current_retry_count": self.current_retry_count,
            "last_error_code": self.last_error_code,
            "history": self.history,
        }

    # ------------------------------------------------------------------ #
    # Validation                                                           #
    # ------------------------------------------------------------------ #

    def ensure_valid(self) -> None:
        if not self.topic:
            raise ValueError("meta.topic must be non-empty")
        if not self.original_question:
            raise ValueError("meta.original_question must be non-empty")
        if self.target_depth <= 0:
            raise ValueError("meta.target_depth must be > 0")
        if self.current_round < 0:
            raise ValueError("meta.current_round must be >= 0")
        if self.max_retries_per_round < 0:
            raise ValueError("meta.max_retries_per_round must be >= 0")
        if self.current_retry_count < 0:
            raise ValueError("meta.current_retry_count must be >= 0")

    def can_finalize(self) -> bool:
        """True only when the required number of rounds has been completed."""
        return self.current_round >= self.target_depth

    # ------------------------------------------------------------------ #
    # State transitions                                                    #
    # ------------------------------------------------------------------ #

    def append_history(
        self, event: TransitionEvent, detail: dict[str, Any] | None = None
    ) -> None:
        entry: dict[str, Any] = {"event": event.value}
        if detail:
            entry.update(detail)
        self.history.append(entry)

    def apply_event(
        self,
        event: TransitionEvent,
        *,
        round_number: int | None = None,
        error_code: str | None = None,
    ) -> None:
        if event == TransitionEvent.START_ROUND:
            if round_number is None:
                raise ValueError("round_number is required for START_ROUND")
            expected = self.current_round + 1
            if round_number != expected:
                raise ValueError(
                    f"invalid round start: expected {expected}, got {round_number}"
                )
            if (
                self.depth_mode == DepthMode.USER_SPECIFIED
                and round_number > self.target_depth
            ):
                raise ValueError(
                    f"cannot start round {round_number} beyond target_depth {self.target_depth}"
                )
            self.current_round = round_number
            self.status = ResearchStatus.IN_PROGRESS
            self.current_retry_count = 0
            self.last_error_code = None
            self.append_history(event, {"round": round_number})
            return

        if event == TransitionEvent.ROUND_PASS:
            if round_number is None:
                round_number = self.current_round
            if round_number != self.current_round:
                raise ValueError("ROUND_PASS round_number must equal current_round")
            if self.can_finalize():
                self.status = ResearchStatus.READY_FOR_FINAL_REPORT
            else:
                self.status = ResearchStatus.READY_FOR_NEXT_ROUND
            self.current_retry_count = 0
            self.last_error_code = None
            self.append_history(event, {"round": round_number})
            return

        if event == TransitionEvent.ROUND_FAIL:
            if round_number is None:
                round_number = self.current_round
            if round_number != self.current_round:
                raise ValueError("ROUND_FAIL round_number must equal current_round")
            self.status = ResearchStatus.ROUND_FAILED
            self.current_retry_count += 1
            self.last_error_code = error_code
            self.append_history(event, {"round": round_number, "error_code": error_code})
            return

        if event == TransitionEvent.RETRY_ROUND:
            if self.status != ResearchStatus.ROUND_FAILED:
                raise ValueError("RETRY_ROUND requires status=ROUND_FAILED")
            if self.current_retry_count > self.max_retries_per_round:
                raise ValueError(
                    f"retry limit exceeded ({self.current_retry_count}/{self.max_retries_per_round})"
                )
            self.status = ResearchStatus.IN_PROGRESS
            self.append_history(event, {"round": self.current_round})
            return

        if event == TransitionEvent.FINALIZE:
            if not self.can_finalize():
                raise ValueError(
                    f"cannot finalize: only {self.current_round}/{self.target_depth} rounds completed"
                )
            if self.status != ResearchStatus.READY_FOR_FINAL_REPORT:
                raise ValueError(
                    "FINALIZE requires status=READY_FOR_FINAL_REPORT after all rounds pass"
                )
            self.status = ResearchStatus.COMPLETED
            self.current_retry_count = 0
            self.last_error_code = None
            self.append_history(event, {"round": self.current_round})
            return

        raise ValueError(f"unsupported event: {event.value}")


# ---------------------------------------------------------------------- #
# I/O helpers                                                             #
# ---------------------------------------------------------------------- #


def load_meta(research_dir: Path) -> DeepResearchMeta:
    meta_path = research_dir / META_FILE_NAME
    if not meta_path.exists():
        raise FileNotFoundError(f"meta file not found: {meta_path}")
    with meta_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    meta = DeepResearchMeta.from_dict(data)
    meta.ensure_valid()
    return meta


def save_meta(research_dir: Path, meta: DeepResearchMeta) -> None:
    meta.ensure_valid()
    meta_path = research_dir / META_FILE_NAME
    with meta_path.open("w", encoding="utf-8") as fh:
        json.dump(meta.to_dict(), fh, ensure_ascii=False, indent=2)
        fh.write("\n")
