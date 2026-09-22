"""Idempotent attempt ledger.

Every trial attempt is written before the harness starts, so a crashed or
retried Invoker task cannot silently buy more trials. The ledger lives with the
committed records, not in a temporary directory, because the durable artefact is
what downstream verification receives.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Attempt:
    key: str
    experiment_id: str
    pair_id: str
    arm: str
    variant: str
    state: str
    started_at: str
    finished_at: str | None = None
    outcome: str | None = None
    note: str | None = None


class AttemptLedger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._entries: dict[str, dict[str, Any]] = {}
        if path.exists():
            raw = json.loads(path.read_text() or "{}")
            self._entries = raw.get("attempts", {})

    @staticmethod
    def key(experiment_id: str, pair_id: str, arm: str) -> str:
        return f"{experiment_id}|{pair_id}|{arm}"

    def get(self, key: str) -> dict[str, Any] | None:
        return self._entries.get(key)

    def entries(self) -> dict[str, dict[str, Any]]:
        return dict(self._entries)

    def claim(self, attempt: Attempt) -> None:
        existing = self._entries.get(attempt.key)
        if existing is not None:
            raise AttemptAlreadyRecorded(
                f"attempt {attempt.key} is already recorded as "
                f"state={existing['state']} outcome={existing.get('outcome')}; "
                "no automatic retry is permitted"
            )
        self._entries[attempt.key] = asdict(attempt)
        self._flush()

    def finish(self, key: str, *, state: str, outcome: str, note: str | None = None) -> None:
        entry = self._entries[key]
        entry["state"] = state
        entry["outcome"] = outcome
        entry["finished_at"] = _now()
        if note:
            entry["note"] = note
        self._flush()

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"schema": "architecture-memory/attempt-ledger/1", "attempts": self._entries}
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


class AttemptAlreadyRecorded(RuntimeError):
    pass


def new_attempt(experiment_id: str, pair_id: str, arm: str, variant: str) -> Attempt:
    return Attempt(
        key=AttemptLedger.key(experiment_id, pair_id, arm),
        experiment_id=experiment_id,
        pair_id=pair_id,
        arm=arm,
        variant=variant,
        state="started",
        started_at=_now(),
    )
