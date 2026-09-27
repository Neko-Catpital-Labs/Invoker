from __future__ import annotations

import json
from pathlib import Path

import pytest

from invoker_worker.idle_task_cleanup import IdleTaskCleanupWorker
from invoker_worker.requeue import RequeueWorker

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "decision-fixtures"


def _load(kind: str, name: str) -> dict:
    path = FIXTURES / kind / f"{name}.json"
    return json.loads(path.read_text())


@pytest.mark.parametrize(
    "name",
    ["empty-state-skip", "stalled-task-requeue", "non-liveness-skip"],
)
def test_requeue_fixtures(name: str) -> None:
    fixture = _load("heartbeat-requeue", name)
    worker = RequeueWorker()
    decisions = worker.tick({"state": fixture.get("state") or {}})
    assert decisions == fixture["decisions"]


@pytest.mark.parametrize(
    "name",
    ["empty-state-skip", "retire-completed-workflow"],
)
def test_idle_task_cleanup_fixtures(name: str) -> None:
    fixture = _load("idle-task-cleanup", name)
    worker = IdleTaskCleanupWorker()
    decisions = worker.tick({"state": fixture.get("state") or {}})
    assert decisions == fixture["decisions"]
