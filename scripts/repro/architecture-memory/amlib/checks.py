"""A named pass/fail check list with a stable printed form."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any


@dataclass
class Outcome:
    name: str
    passed: bool
    detail: str

    def line(self) -> str:
        return f"[{'PASS' if self.passed else 'FAIL'}] {self.name} :: {self.detail}"


class Results:
    def __init__(self, title: str) -> None:
        self.title = title
        self.outcomes: list[Outcome] = []

    def add(self, name: str, passed: bool, detail: str = "") -> Outcome:
        outcome = Outcome(name, passed, detail or ("ok" if passed else "failed"))
        self.outcomes.append(outcome)
        print(outcome.line(), flush=True)
        return outcome

    @property
    def failed(self) -> list[Outcome]:
        return [outcome for outcome in self.outcomes if not outcome.passed]

    def summary(self) -> str:
        passed = len(self.outcomes) - len(self.failed)
        return f"{self.title}: {passed}/{len(self.outcomes)} checks passed"

    def to_json(self) -> list[dict[str, Any]]:
        return [asdict(outcome) for outcome in self.outcomes]

    def exit_code(self) -> int:
        return 1 if self.failed else 0
