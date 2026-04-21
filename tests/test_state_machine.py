"""Unit tests for deep_research_state_machine."""
import json
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from deep_research_state_machine import (
    DeepResearchMeta,
    DepthMode,
    ResearchStatus,
    TransitionEvent,
    load_meta,
    save_meta,
)


def make_meta(**kwargs) -> DeepResearchMeta:
    defaults = dict(
        topic="test-topic",
        original_question="Is this a good idea?",
        target_depth=4,
        depth_mode=DepthMode.USER_SPECIFIED,
        current_round=0,
        status=ResearchStatus.INITIALIZED,
    )
    defaults.update(kwargs)
    return DeepResearchMeta(**defaults)


class TestEnsureValid:
    def test_empty_topic_raises(self):
        m = make_meta(topic="")
        with pytest.raises(ValueError, match="topic"):
            m.ensure_valid()

    def test_zero_target_depth_raises(self):
        m = make_meta(target_depth=0)
        with pytest.raises(ValueError, match="target_depth"):
            m.ensure_valid()

    def test_negative_round_raises(self):
        m = make_meta(current_round=-1)
        with pytest.raises(ValueError, match="current_round"):
            m.ensure_valid()


class TestStartRound:
    def test_advances_round(self):
        m = make_meta(current_round=0)
        m.apply_event(TransitionEvent.START_ROUND, round_number=1)
        assert m.current_round == 1
        assert m.status == ResearchStatus.IN_PROGRESS

    def test_wrong_round_number_raises(self):
        m = make_meta(current_round=0)
        with pytest.raises(ValueError):
            m.apply_event(TransitionEvent.START_ROUND, round_number=2)

    def test_beyond_target_depth_raises(self):
        m = make_meta(current_round=4, target_depth=4, status=ResearchStatus.READY_FOR_NEXT_ROUND)
        with pytest.raises(ValueError, match="target_depth"):
            m.apply_event(TransitionEvent.START_ROUND, round_number=5)

    def test_auto_mode_allows_beyond_target(self):
        m = make_meta(current_round=4, target_depth=4,
                      depth_mode=DepthMode.AUTO, status=ResearchStatus.READY_FOR_NEXT_ROUND)
        m.apply_event(TransitionEvent.START_ROUND, round_number=5)
        assert m.current_round == 5


class TestRoundPassFail:
    def test_pass_sets_ready(self):
        m = make_meta(current_round=2, status=ResearchStatus.IN_PROGRESS)
        m.apply_event(TransitionEvent.ROUND_PASS)
        assert m.status == ResearchStatus.READY_FOR_NEXT_ROUND
        assert m.current_retry_count == 0

    def test_pass_at_target_sets_ready_for_final_report(self):
        m = make_meta(current_round=4, target_depth=4, status=ResearchStatus.IN_PROGRESS)
        m.apply_event(TransitionEvent.ROUND_PASS)
        assert m.status == ResearchStatus.READY_FOR_FINAL_REPORT

    def test_fail_increments_retry(self):
        m = make_meta(current_round=2, status=ResearchStatus.IN_PROGRESS)
        m.apply_event(TransitionEvent.ROUND_FAIL, error_code="ERR_MISSING_FILE")
        assert m.status == ResearchStatus.ROUND_FAILED
        assert m.current_retry_count == 1
        assert m.last_error_code == "ERR_MISSING_FILE"

    def test_retry_clears_status(self):
        m = make_meta(current_round=2, status=ResearchStatus.ROUND_FAILED, current_retry_count=1)
        m.apply_event(TransitionEvent.RETRY_ROUND)
        assert m.status == ResearchStatus.IN_PROGRESS

    def test_retry_limit_exceeded(self):
        m = make_meta(current_round=2, status=ResearchStatus.ROUND_FAILED,
                      max_retries_per_round=3, current_retry_count=4)
        with pytest.raises(ValueError, match="retry limit"):
            m.apply_event(TransitionEvent.RETRY_ROUND)


class TestFinalize:
    def test_finalize_at_target(self):
        m = make_meta(current_round=4, target_depth=4, status=ResearchStatus.READY_FOR_FINAL_REPORT)
        m.apply_event(TransitionEvent.FINALIZE)
        assert m.status == ResearchStatus.COMPLETED

    def test_finalize_before_target_raises(self):
        m = make_meta(current_round=2, target_depth=4)
        with pytest.raises(ValueError, match="cannot finalize"):
            m.apply_event(TransitionEvent.FINALIZE)

    def test_finalize_requires_ready_for_final_report_status(self):
        m = make_meta(current_round=4, target_depth=4, status=ResearchStatus.READY_FOR_NEXT_ROUND)
        with pytest.raises(ValueError, match="READY_FOR_FINAL_REPORT"):
            m.apply_event(TransitionEvent.FINALIZE)

    def test_can_finalize_respects_target(self):
        m3 = make_meta(current_round=3, target_depth=4)
        m4 = make_meta(current_round=4, target_depth=4)
        assert not m3.can_finalize()
        assert m4.can_finalize()


class TestHistory:
    def test_history_appended(self):
        m = make_meta(current_round=0)
        m.apply_event(TransitionEvent.START_ROUND, round_number=1)
        m.apply_event(TransitionEvent.ROUND_PASS)
        assert len(m.history) == 2
        assert m.history[0]["event"] == "start_round"
        assert m.history[1]["event"] == "round_pass"


class TestPersistence:
    def test_save_and_load(self, tmp_path):
        m = make_meta(current_round=2, status=ResearchStatus.IN_PROGRESS)
        save_meta(tmp_path, m)
        loaded = load_meta(tmp_path)
        assert loaded.current_round == 2
        assert loaded.status == ResearchStatus.IN_PROGRESS
        assert loaded.topic == m.topic

    def test_missing_meta_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_meta(tmp_path)

    def test_serialise_roundtrip(self):
        m = make_meta(current_round=3, last_error_code="ERR_TASK_FILE_MISSING")
        d = m.to_dict()
        m2 = DeepResearchMeta.from_dict(d)
        assert m2.current_round == 3
        assert m2.last_error_code == "ERR_TASK_FILE_MISSING"
